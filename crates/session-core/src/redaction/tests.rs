use super::*;
fn output(policy: &Policy, parts: &[&str], boundaries: Boundaries) -> Projection {
    let projected = policy.project(parts, boundaries).unwrap();
    assert_eq!(projected.fragments.len(), parts.len());
    for (before, after) in parts.iter().zip(&projected.fragments) {
        assert_eq!(before.len(), after.len());
        assert_eq!(
            before.bytes().filter(|b| *b == b'\n').count(),
            after.bytes().filter(|b| *b == b'\n').count()
        );
    }
    projected
}
#[test]
fn literal_rules_cover_overlaps_unicode_and_every_cross_event_partition() {
    let policy = Policy::new(vec!["aba".into(), "秘密🔑".into()], false).unwrap();
    let text = "head: ababa 秘密🔑 :tail\n";
    let baseline = output(&policy, &[text], Boundaries::default());
    assert_eq!(baseline.literal_matches, 3);
    assert_eq!(
        baseline.fragments.concat(),
        "head: ***** ********** :tail\n"
    );
    for left in (0..=text.len()).filter(|i| text.is_char_boundary(*i)) {
        for right in (left..=text.len()).filter(|i| text.is_char_boundary(*i)) {
            let result = output(
                &policy,
                &[&text[..left], &text[left..right], &text[right..]],
                Boundaries::default(),
            );
            assert_eq!(result.fragments.concat(), baseline.fragments.concat());
            assert_eq!(result.masked_ranges, baseline.masked_ranges);
            assert_eq!(result.literal_matches, baseline.literal_matches);
        }
    }
}
#[test]
fn sensitive_fields_are_case_insensitive_quote_aware_and_keep_other_lines() {
    let policy = Policy::new(vec![], true).unwrap();
    let cases = [
        ("password=synthetic\npublic=ok", "synthetic"),
        (
            "{\"ToKeN\": \"合成 value\\\"quoted\",\"public\":1}\n",
            "合成",
        ),
        ("Authorization: Bearer synthetic-token\r\nnext=ok", "Bearer"),
        ("private_key='line1\nline2'\npublic=ok", "line1"),
        ("passphrase=\"unfinished\nprivate", "private"),
        ("api-key: synthetic\n", "synthetic"),
    ];
    for (text, secret) in cases {
        let baseline = output(&policy, &[text], Boundaries::default());
        assert_eq!(baseline.field_matches, 1, "{text}");
        assert!(!baseline.fragments.concat().contains(secret));
        for at in (0..=text.len()).filter(|i| text.is_char_boundary(*i)) {
            let split = output(&policy, &[&text[..at], &text[at..]], Boundaries::default());
            assert_eq!(split.fragments.concat(), baseline.fragments.concat());
        }
    }
    let plain = "public_token=unchanged\nmysecret=unchanged\npassword_count=3\nTOKENIZED=ok\n";
    assert_eq!(
        output(&policy, &[plain], Boundaries::default())
            .fragments
            .concat(),
        plain
    );
}
#[test]
fn pem_blocks_wait_for_the_correct_key_terminator_and_hide_incomplete_bodies() {
    let policy = Policy::new(vec![], true).unwrap();
    let text = "visible\n-----BEGIN RSA PRIVATE KEY-----\r\nsecretA\n-----END PUBLIC KEY-----\nsecretB\n-----END RSA PRIVATE KEY-----\nvisible2";
    let p = output(&policy, &[text], Boundaries::default());
    let text = p.fragments.concat();
    assert_eq!(p.field_matches, 1);
    assert!(!text.contains("secretA"));
    assert!(!text.contains("secretB"));
    assert!(text.starts_with("visible\n"));
    assert!(text.ends_with("\nvisible2"));
    let unfinished = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret";
    assert!(
        !output(&policy, &[unfinished], Boundaries::default())
            .fragments
            .concat()
            .contains("secret")
    );
}
#[test]
fn live_suffix_and_selected_prefix_guards_cannot_release_partial_literal_values() {
    let policy = Policy::new(vec!["secret".into()], false).unwrap();
    let full = "prefix:secret:tail";
    for end in 8..=14 {
        let p = output(
            &policy,
            &[&full[..end]],
            Boundaries {
                prefix_cut: false,
                suffix_cut: true,
            },
        );
        assert!(p.fragments.concat()[8..end].bytes().all(|b| b == b'*'));
    }
    for start in 9..14 {
        let p = output(
            &policy,
            &[&full[start..]],
            Boundaries {
                prefix_cut: true,
                suffix_cut: false,
            },
        );
        assert!(
            p.fragments.concat()[..14 - start]
                .bytes()
                .all(|b| b == b'*')
        );
    }
    let policy = Policy::new(vec!["密🔑码".into()], false).unwrap();
    let p = output(
        &policy,
        &["head密🔑"],
        Boundaries {
            suffix_cut: true,
            ..Boundaries::default()
        },
    );
    assert_eq!(p.fragments.concat().len(), "head密🔑".len());
    assert!(!p.fragments.concat().contains('密'));
    assert!(!p.fragments.concat().contains('🔑'));
    let fields = Policy::new(vec![], true).unwrap();
    let p = output(
        &fields,
        &["orphan-value\npublic=ok\npartial-value"],
        Boundaries {
            prefix_cut: true,
            suffix_cut: true,
        },
    );
    assert_eq!(
        p.fragments.concat(),
        "************\n*********\n*************"
    );
}
#[test]
fn control_obfuscation_is_opaque_while_normal_newlines_do_not_disable_literal_matching() {
    let policy = Policy::new(vec!["secret".into()], true).unwrap();
    for text in [
        "pass\x1b[31mword=secret",
        "pass\x08word=secret",
        "token=secret\0",
        "pa\rassword=secret",
        "left\u{202e}secret",
    ] {
        let p = output(&policy, &[text], Boundaries::default());
        assert!(p.opaque_controls);
        assert!(p.fragments.concat().bytes().all(|b| b == b'*'));
    }
    let p = output(
        &policy,
        &["public\r\nsecret\tpublic\n"],
        Boundaries::default(),
    );
    assert!(!p.opaque_controls);
    assert_eq!(p.fragments.concat(), "public\r\n******\tpublic\n");
}
#[test]
fn policies_and_input_are_bounded_and_secret_rule_values_are_not_debugged() {
    for (literals, fields) in [
        (vec![], false),
        (vec![String::new()], true),
        (vec!["x".repeat(257)], true),
        (vec!["same".into(), "same".into()], true),
        ((0..33).map(|i| format!("value{i}")).collect(), false),
    ] {
        assert!(matches!(
            Policy::new(literals, fields),
            Err(ErrorCode::InvalidArgument)
        ));
    }
    let policy = Policy::new(vec!["synthetic-private-value".into()], true).unwrap();
    assert!(!format!("{policy:?}").contains("synthetic-private-value"));
    assert!(
        policy
            .project(&vec![""; 257], Boundaries::default())
            .is_err()
    );
    assert!(
        policy
            .project(&[&"x".repeat(MAX_INPUT_BYTES + 1)], Boundaries::default())
            .is_err()
    );
    assert_eq!(
        output(&policy, &["", ""], Boundaries::default()).fragments,
        ["", ""]
    );
    let max = "x".repeat(MAX_INPUT_BYTES);
    assert_eq!(
        output(&policy, &[&max], Boundaries::default()).fragments[0],
        max
    );
}
#[test]
fn full_segment_analysis_precedes_page_slicing_and_never_joins_independent_streams() {
    let policy = Policy::new(vec!["secret".into()], false).unwrap();
    let parts = ["visible se", "cr", "et tail"];
    let projection = output(&policy, &parts, Boundaries::default());
    assert_eq!(projection.fragments, ["visible **", "**", "** tail"]);
    let left = output(
        &policy,
        &["se"],
        Boundaries {
            suffix_cut: true,
            ..Boundaries::default()
        },
    );
    let right = output(
        &policy,
        &["cret"],
        Boundaries {
            prefix_cut: true,
            ..Boundaries::default()
        },
    );
    assert_eq!(left.fragments, ["**"]);
    assert_eq!(right.fragments, ["****"]);
}
#[test]
fn adversarial_prefixes_and_heavily_overlapping_rules_stay_bounded() {
    let policy = Policy::new(vec![], true).unwrap();
    let text = "-----BEGIN ".repeat(32768);
    let p = output(&policy, &[&text], Boundaries::default());
    assert_eq!(p.fragments[0], text);
    assert_eq!(p.field_matches, 0);
    let rules = (1..=32).map(|n| "a".repeat(n)).collect();
    let policy = Policy::new(rules, false).unwrap();
    let text = "a".repeat(65536);
    let p = output(&policy, &[&text], Boundaries::default());
    assert_eq!(p.fragments[0], "*".repeat(text.len()));
    assert_eq!(p.masked_ranges.len(), 1);
    assert_eq!(p.masked_ranges[0], 0..text.len());
    assert_eq!(
        p.literal_matches,
        (1..=32).map(|n| text.len() - n + 1).sum::<usize>()
    );
}
#[test]
fn cut_sensitive_field_state_cannot_release_orphan_multiline_quotes_or_pem_tails() {
    let policy = Policy::new(vec![], true).unwrap();
    for text in [
        "orphan-one\norphan-two'\npublic=ok",
        "key-body-one\nkey-body-two\n-----END PRIVATE KEY-----\nvisible",
    ] {
        let p = output(
            &policy,
            &[text],
            Boundaries {
                prefix_cut: true,
                suffix_cut: false,
            },
        );
        assert!(p.boundary_guard);
        assert!(
            p.fragments
                .concat()
                .bytes()
                .all(|b| matches!(b, b'*' | b'\n'))
        );
    }
}
#[test]
fn pem_end_must_be_an_entire_line_not_an_inline_or_suffixed_substring() {
    let policy = Policy::new(vec![], true).unwrap();
    for fake in [
        "AAAA-----END PRIVATE KEY-----",
        "-----END PRIVATE KEY-----extra",
        " -----END PRIVATE KEY-----",
        "-----END PRIVATE KEY----- trailing",
        "-----END RSA PRIVATE KEY-----",
    ] {
        let text = format!(
            "-----BEGIN PRIVATE KEY-----\nbody\n{fake}\nSENSITIVE-TAIL\n-----END PRIVATE KEY-----\npublic=ok"
        );
        let baseline = output(&policy, &[&text], Boundaries::default());
        assert_eq!(baseline.field_matches, 1);
        assert!(
            !baseline.fragments.concat().contains("SENSITIVE-TAIL"),
            "{fake}"
        );
        assert!(baseline.fragments.concat().ends_with("\npublic=ok"));
        for at in 0..=text.len() {
            let split = output(&policy, &[&text[..at], &text[at..]], Boundaries::default());
            assert_eq!(split.fragments.concat(), baseline.fragments.concat());
        }
    }
}
#[test]
fn pem_accepts_exact_end_lines_with_crlf_or_eof_and_keeps_unclosed_suffixes_hidden() {
    let policy = Policy::new(vec![], true).unwrap();
    for text in [
        "-----BEGIN PRIVATE KEY-----\r\nsecret\r\n-----END PRIVATE KEY-----\r\npublic=ok",
        "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----extra\nSENSITIVE-TAIL",
    ] {
        let p = output(&policy, &[text], Boundaries::default());
        assert_eq!(p.field_matches, 1);
        assert!(!p.opaque_controls);
        assert!(!p.fragments.concat().contains("secret"));
        assert!(!p.fragments.concat().contains("SENSITIVE-TAIL"));
        if text.ends_with("public=ok") {
            assert!(p.fragments.concat().ends_with("public=ok"));
        } else {
            assert!(
                p.fragments
                    .concat()
                    .bytes()
                    .all(|b| matches!(b, b'*' | b'\n'))
            );
        }
    }
}
