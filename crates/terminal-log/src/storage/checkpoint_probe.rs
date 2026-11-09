//! Finite same-handle feasibility experiment only; no production async checkpoint.
use super::*;
use crate::{ManagedRoot, PairReader, ReadableStatus};
use session_core::{
    presentation::TextEvent,
    session::{ConnectionId, ConnectionRef, OutputEvent, Protocol},
};
use std::{
    io::BufReader,
    sync::{
        Arc, Barrier,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Instant,
};

fn record(meta: &Metadata, seq: u64) -> Record {
    let bytes = vec![b'a' + (seq % 26) as u8; 4096];
    Record {
        connection: meta.connection,
        raw: Some(OutputEvent {
            seq,
            timestamp_ms: seq,
            bytes: bytes.clone(),
            gap_bytes: None,
        }),
        text: TextEvent {
            seq,
            source_seq: Some(seq),
            timestamp_ms: seq,
            text: String::from_utf8(bytes).unwrap(),
            decode_error: false,
            gap_bytes: None,
        },
    }
}
fn synchronize(
    files: [File; 3],
    clock: Instant,
    prefix: ReadableStatus,
) -> io::Result<serde_json::Value> {
    let start = clock.elapsed().as_secs_f64();
    let mut calls = vec![];
    for (name, file) in ["live", "raw", "jsonl"].into_iter().zip(files) {
        let began = clock.elapsed().as_secs_f64();
        file.sync_all()?;
        calls.push(
            serde_json::json!({"file":name,"start_s":began,"end_s":clock.elapsed().as_secs_f64()}),
        );
    }
    Ok(
        serde_json::json!({"start_s":start,"end_s":clock.elapsed().as_secs_f64(),"files":calls,"common_prefix_records":prefix.flushed_records,"live_prefix_bytes":prefix.flushed_bytes}),
    )
}

#[test]
#[ignore = "explicit finite same-Windows-handle checkpoint feasibility; never a T19 acceptance run"]
fn p22_same_handle_checkpoint_feasibility() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let root = workspace
        .join("artifacts")
        .join(format!("P22-checkpoint-probe-中文-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut results = vec![];
    for trial in 0..2 {
        for independent in [false, true] {
            let label = format!(
                "trial-{trial}-{}",
                if independent { "independent" } else { "serial" }
            );
            let data = root.join(&label);
            fs::create_dir(&data).unwrap();
            let managed = ManagedRoot::open(&data).unwrap();
            let barrier = Arc::new(Barrier::new(9));
            let mut prepared = vec![];
            for stream in 0..8 {
                let setup = Instant::now();
                let meta = Metadata {
                    connection: ConnectionRef {
                        connection_id: ConnectionId(Uuid::new_v4()),
                        generation: 1,
                    },
                    protocol: Protocol::Fixture,
                    encoding: "utf-8".into(),
                    started_at_ms: 0,
                    source_cursor: 1,
                    text_cursor: 1,
                };
                let id = Uuid::new_v4();
                let mut journal = FileJournal::open_readable(
                    managed.path().to_owned(),
                    id,
                    meta.clone(),
                    Limits {
                        segment_bytes: 100 * 1024 * 1024,
                        segments: 2,
                    },
                    &format!("probe-{stream}"),
                )
                .unwrap();
                for seq in 1..=8 {
                    journal.append(&record(&meta, seq)).unwrap();
                }
                let before_flush = Instant::now();
                let (live, prefix) = journal
                    .live
                    .as_mut()
                    .unwrap()
                    .probe_flushed_handle()
                    .unwrap();
                let flush_us = before_flush.elapsed().as_micros();
                assert_eq!(prefix.flushed_records, 8);
                assert_eq!(prefix.synced_records, 0);
                let files = [
                    live,
                    journal.raw.as_ref().unwrap().try_clone().unwrap(),
                    journal.text.as_ref().unwrap().try_clone().unwrap(),
                ];
                prepared.push((
                    journal,
                    meta,
                    files,
                    prefix,
                    flush_us,
                    setup.elapsed().as_micros(),
                    id,
                ));
            }
            let mut workers = vec![];
            for (stream, (mut journal, meta, files, prefix, flush_us, setup_us, id)) in
                prepared.into_iter().enumerate()
            {
                let barrier = barrier.clone();
                let data = data.clone();
                workers.push(thread::spawn(move||{
                barrier.wait();let clock=Instant::now();let entered=Arc::new(AtomicBool::new(false));
                let (helper,serial)=if independent {
                    let entered=entered.clone();(Some(thread::spawn(move||{entered.store(true,Ordering::SeqCst);synchronize(files,clock,prefix)})),None)
                }else{(None,Some(synchronize(files,clock,prefix)))};
                if independent {while !entered.load(Ordering::SeqCst){thread::yield_now();}}
                let mut appends=vec![];
                for seq in 9..=136 {let began=clock.elapsed().as_secs_f64();journal.append(&record(&meta,seq)).unwrap();appends.push(serde_json::json!({"seq":seq,"start_s":began,"end_s":clock.elapsed().as_secs_f64()}));}
                let checkpoint=if let Some(helper)=helper {helper.join().unwrap().unwrap()}else{serial.unwrap().unwrap()};
                let current=journal.readable().unwrap();assert_eq!(current.written_records,136);assert_eq!(checkpoint["common_prefix_records"],8);
                assert_eq!(current.synced_records,0,"prototype completion must not publish latest written or bypass the coordinator");
                let max_append=appends.iter().map(|a|a["end_s"].as_f64().unwrap()-a["start_s"].as_f64().unwrap()).fold(0f64,f64::max);
                let overlap:Vec<_>=appends.iter().filter(|a|a["start_s"].as_f64().unwrap()<checkpoint["end_s"].as_f64().unwrap()&&a["end_s"].as_f64().unwrap()>checkpoint["start_s"].as_f64().unwrap()).collect();
                let max_overlap=overlap.iter().map(|a|a["end_s"].as_f64().unwrap()-a["start_s"].as_f64().unwrap()).fold(0f64,f64::max);
                // Stop fence: join helper and drop duplicate handles before final real checkpoint and closing originals.
                let stop=Instant::now();journal.checkpoint(true).unwrap();let final_readable=journal.readable().unwrap();assert_eq!(final_readable.synced_records,136);assert_eq!(final_readable.flushed_bytes,final_readable.synced_bytes);let stop_us=stop.elapsed().as_micros();drop(journal);
                let directory=data.join("terminal-logs").join(id.to_string());let mut reader=PairReader::new(BufReader::new(File::open(directory.join("0000000000000001.rawlog")).unwrap()),BufReader::new(File::open(directory.join("0000000000000001.text.jsonl")).unwrap())).unwrap();
                for seq in 1..=136 {let got=reader.next_record().unwrap().unwrap();assert_eq!(got.text,record(&meta,seq).text);assert_eq!(got.raw.unwrap().bytes,record(&meta,seq).raw.unwrap().bytes);}assert!(reader.next_record().unwrap().is_none());
                serde_json::json!({"stream":stream,"setup_us":setup_us,"prefix_flush_us":flush_us,"checkpoint":checkpoint,"written_records_at_helper_join":136,"published_by_helper":false,"max_append_s":max_append,"overlap_append_count":overlap.len(),"max_overlap_append_s":max_overlap,"final_checkpoint_us":stop_us,"final_readable":final_readable,"all_136_records_verified":true,"appends":appends})
            }));
            }
            barrier.wait();
            let streams: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
            let summary =
                serde_json::json!({"trial":trial,"independent":independent,"streams":streams});
            println!(
                "P22_SAME_HANDLE {}",
                serde_json::json!({"trial":trial,"independent":independent,"max_append_s":summary["streams"].as_array().unwrap().iter().map(|s|s["max_append_s"].as_f64().unwrap()).fold(0f64,f64::max),"overlap_count":summary["streams"].as_array().unwrap().iter().map(|s|s["overlap_append_count"].as_u64().unwrap()).sum::<u64>()})
            );
            results.push(summary);
            serde_json::to_writer_pretty(
                File::create(root.join("same-handle-result.json")).unwrap(),
                &results,
            )
            .unwrap();
        }
    }
    println!("P22_SAME_HANDLE_DIAGNOSTIC_COMPLETE {}", root.display());
}
