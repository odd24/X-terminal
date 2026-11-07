//! Bounded Desktop grant receipts. Tokens remain memory-only and are never listed.
use super::protection::Definition;
use super::*;
use crate::authorization::Form;
use crate::input::{RequestWindow, ordered_timestamp};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_GRANT_RECEIPTS: usize = 128;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State {
    Active,
    Expired,
    Revoked,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Summary {
    pub request_id: Uuid,
    pub ticket_id: Uuid,
    pub expires_at_ms: u64,
    pub state: State,
    pub effective_scope_count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct View {
    pub summary: Summary,
    pub approved_scopes: Vec<Scope>,
    pub effective_scopes: Vec<Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<Box<Form>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection: Option<protection::Info>,
}
pub struct ResultView {
    pub view: View,
    pub token: Option<SecretToken>,
}
struct Record {
    owner: Uuid,
    ticket_id: Uuid,
    scopes: Vec<Scope>,
    form: Form,
    protection: Option<protection::Receipt>,
    lifetime_ms: u64,
    expires: u64,
    token: Option<SecretToken>,
}
#[derive(Default)]
pub(super) struct Ledger {
    records: HashMap<Uuid, Record>,
    window: RequestWindow,
}
impl Ledger {
    pub(super) fn clear_token(&mut self, ticket_id: Uuid) {
        for record in self
            .records
            .values_mut()
            .filter(|record| record.ticket_id == ticket_id)
        {
            record.token = None;
        }
    }
}
impl Pairing {
    fn grant_state(&self, record: &Record, now: u64) -> State {
        if now >= record.expires {
            State::Expired
        } else if self
            .tickets
            .values()
            .any(|t| t.identity.ticket_id == record.ticket_id)
        {
            State::Active
        } else {
            State::Revoked
        }
    }
    fn prune_grant_tokens(&mut self, now: u64) {
        self.tickets.retain(|_, ticket| ticket.expires_at_ms > now);
        let dead: Vec<_> = self
            .grants
            .records
            .iter()
            .filter(|(_, r)| self.grant_state(r, now) != State::Active)
            .map(|(id, _)| *id)
            .collect();
        for id in dead {
            self.grants.records.get_mut(&id).unwrap().token = None;
        }
    }
    fn grant_result(&self, id: Uuid, record: &Record, now: u64) -> Result<ResultView, ErrorCode> {
        let state = self.grant_state(record, now);
        let effective_scopes = if state == State::Active {
            self.policy.effective_scopes(record.ticket_id, now)
        } else {
            vec![]
        };
        Ok(ResultView {
            view: View {
                summary: Summary {
                    request_id: id,
                    ticket_id: record.ticket_id,
                    expires_at_ms: record.expires,
                    state,
                    effective_scope_count: effective_scopes.len(),
                },
                approved_scopes: record.scopes.clone(),
                effective_scopes,
                form: (record.form != Form::Scoped).then(|| Box::new(record.form.clone())),
                protection: record.protection.as_ref().map(|p| p.info),
            },
            token: if state == State::Active {
                record
                    .token
                    .as_ref()
                    .map(|t| SecretToken::parse(t.expose().to_string()))
                    .transpose()?
            } else {
                None
            },
        })
    }
    /// Called before asynchronous profile lookup as well as after it. A retained
    /// retry only recovers the old receipt, even if scopes/generation retired.
    pub fn grant_replay(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        scopes: &[Scope],
        lifetime_ms: u64,
        now: u64,
    ) -> Result<Option<ResultView>, ErrorCode> {
        self.grant_replay_form(desktop, id, scopes, &Form::Scoped, lifetime_ms, now)
    }
    pub fn grant_replay_form(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        scopes: &[Scope],
        form: &Form,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<Option<ResultView>, ErrorCode> {
        self.grant_replay_definition(
            desktop,
            id,
            &Definition {
                scopes: scopes.to_vec(),
                form: form.clone(),
                redaction: None,
            },
            lifetime_ms,
            now,
        )
    }
    pub fn grant_replay_definition(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        definition: &Definition,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<Option<ResultView>, ErrorCode> {
        self.require_desktop(desktop, now)?;
        self.prune_grant_tokens(now);
        if let Some(record) = self.grants.records.get(&id) {
            if record.owner != desktop.ticket_id {
                return Err(ErrorCode::PermissionDenied);
            }
            let protection_matches = match (&record.protection, &definition.redaction) {
                (None, None) => true,
                (Some(receipt), Some(rules)) => receipt.matches(rules),
                _ => false,
            };
            if !protection_matches
                || record.form != definition.form
                || record.lifetime_ms != lifetime_ms
                || record.scopes.iter().collect::<HashSet<_>>()
                    != definition.scopes.iter().collect::<HashSet<_>>()
            {
                return Err(ErrorCode::InvalidArgument);
            }
            return self.grant_result(id, record, now).map(Some);
        }
        self.grants.window.check(id)?;
        Ok(None)
    }
    pub fn issue_managed_agent(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        scopes: Vec<Scope>,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<ResultView, ErrorCode> {
        self.issue_managed_agent_form(desktop, id, scopes, Form::Scoped, lifetime_ms, now)
    }
    pub fn issue_managed_agent_form(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        scopes: Vec<Scope>,
        form: Form,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<ResultView, ErrorCode> {
        self.issue_managed_agent_definition(
            desktop,
            id,
            Definition {
                scopes,
                form,
                redaction: None,
            },
            lifetime_ms,
            now,
        )
    }
    pub fn issue_managed_agent_definition(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        definition: Definition,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<ResultView, ErrorCode> {
        if id.is_nil() {
            return Err(ErrorCode::InvalidArgument);
        }
        if let Some(result) =
            self.grant_replay_definition(desktop, id, &definition, lifetime_ms, now)?
        {
            return Ok(result);
        }
        if self.grants.records.len() == MAX_GRANT_RECEIPTS {
            let (old, stamp) = self
                .grants
                .records
                .iter()
                .filter(|(_, r)| self.grant_state(r, now) != State::Active)
                .filter_map(|(id, _)| ordered_timestamp(*id).map(|stamp| (*id, stamp)))
                .min_by_key(|(_, stamp)| *stamp)
                .ok_or(ErrorCode::CapacityExceeded)?;
            self.grants.window.retire(stamp);
            self.grants.records.remove(&old);
            self.grants.window.check(id)?;
        }
        let (identity, token, expires) =
            self.issue_agent_definition(desktop, definition.clone(), lifetime_ms, now)?;
        let protection = self
            .output_protection(&identity, now)?
            .as_deref()
            .map(protection::Receipt::new);
        self.grants.records.insert(
            id,
            Record {
                owner: desktop.ticket_id,
                ticket_id: identity.ticket_id,
                scopes: definition.scopes,
                form: definition.form,
                protection,
                lifetime_ms,
                expires,
                token: Some(token),
            },
        );
        self.grant_result(id, &self.grants.records[&id], now)
    }
    pub fn grant_status(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        now: u64,
    ) -> Result<ResultView, ErrorCode> {
        self.require_desktop(desktop, now)?;
        self.prune_grant_tokens(now);
        if let Some(record) = self.grants.records.get(&id) {
            if record.owner != desktop.ticket_id {
                return Err(ErrorCode::PermissionDenied);
            }
            return self.grant_result(id, record, now);
        }
        self.grants.window.check(id)?;
        Err(ErrorCode::NotFound)
    }
    pub fn grant_list(&mut self, desktop: &Identity, now: u64) -> Result<Vec<Summary>, ErrorCode> {
        self.require_desktop(desktop, now)?;
        self.prune_grant_tokens(now);
        let mut list = self
            .grants
            .records
            .iter()
            .filter(|(_, r)| r.owner == desktop.ticket_id)
            .map(|(id, r)| {
                let state = self.grant_state(r, now);
                Summary {
                    request_id: *id,
                    ticket_id: r.ticket_id,
                    expires_at_ms: r.expires,
                    state,
                    effective_scope_count: if state == State::Active {
                        self.policy.effective_scopes(r.ticket_id, now).len()
                    } else {
                        0
                    },
                }
            })
            .collect::<Vec<_>>();
        list.sort_by_key(|r| r.request_id);
        Ok(list)
    }
    pub fn revoke_managed_agent(
        &mut self,
        desktop: &Identity,
        id: Uuid,
        now: u64,
    ) -> Result<ResultView, ErrorCode> {
        let result = self.grant_status(desktop, id, now)?;
        if result.view.summary.state == State::Active {
            self.revoke(desktop, result.view.summary.ticket_id, now)?;
        }
        self.grant_status(desktop, id, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ConnectionId;
    #[test]
    fn failed_journal_keeps_original_grant_lookup_replay_and_revocation_without_renewal() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        struct Sink(AtomicBool);
        impl access::AuditSink for Sink {
            fn record(&self, _: access::AuditEvent) -> bool {
                self.0.load(Ordering::SeqCst)
            }
            fn healthy(&self) -> bool {
                self.0.load(Ordering::SeqCst)
            }
        }
        let (mut p, desktop, scope) = setup();
        let sink = Arc::new(Sink(AtomicBool::new(true)));
        p.set_audit_sink(sink.clone());
        let id = Uuid::new_v4();
        let first = p
            .issue_managed_agent(&desktop, id, vec![scope], 100, 0)
            .unwrap();
        let original = first.view.summary;
        let connection = scope.target.connection().unwrap();
        let full = Scope {
            target: Target::Connection { connection },
            action: Action::Read,
        };
        let window = crate::context::TimeWindow {
            from_ms: 1,
            until_ms: 10,
        };
        let bounded = Scope {
            target: Target::OutputWindow { connection, window },
            action: Action::Read,
        };
        let (reader, _, _) = p.issue_agent(&desktop, vec![full], 100, 0).unwrap();
        let (bounded_reader, _, _) = p.issue_agent(&desktop, vec![bounded], 100, 0).unwrap();
        assert_eq!(
            p.can_read_context(&bounded_reader, connection, window, 1),
            Ok(())
        );
        sink.0.store(false, Ordering::SeqCst);
        assert_eq!(
            p.can_read(&reader, connection, 20),
            Err(ErrorCode::CapacityExceeded)
        );
        assert_eq!(
            p.can_read_context(&reader, connection, window, 20),
            Err(ErrorCode::CapacityExceeded)
        );
        assert_eq!(
            p.can_read_context(&bounded_reader, connection, window, 20),
            Err(ErrorCode::CapacityExceeded)
        );
        assert_eq!(
            p.can_observe(&bounded_reader, connection, 20),
            Ok(()),
            "own metadata discovery remains a safe query"
        );
        let replay = p
            .issue_managed_agent(&desktop, id, vec![scope], 100, 20)
            .unwrap();
        assert_eq!(replay.view.summary.ticket_id, original.ticket_id);
        assert_eq!(replay.view.summary.expires_at_ms, original.expires_at_ms);
        assert_eq!(
            p.grant_status(&desktop, id, 20)
                .unwrap()
                .view
                .summary
                .ticket_id,
            original.ticket_id
        );
        assert!(
            p.issue_managed_agent(&desktop, Uuid::new_v4(), vec![scope], 100, 20)
                .is_err()
        );
        p.revoke(&desktop, original.ticket_id, 20).unwrap();
        assert_eq!(
            p.grant_status(&desktop, id, 20).unwrap().view.summary.state,
            State::Revoked
        );
    }
    fn setup() -> (Pairing, Identity, Scope) {
        let bootstrap = SecretToken::generate();
        let p = Pairing::new(&bootstrap);
        let desktop = p.authenticate(&bootstrap, 0).unwrap();
        (
            p,
            desktop,
            Scope {
                target: Target::Connection {
                    connection: ConnectionRef {
                        connection_id: ConnectionId(Uuid::new_v4()),
                        generation: 1,
                    },
                },
                action: Action::Write,
            },
        )
    }
    fn ordered(stamp: u64) -> Uuid {
        Uuid::from_u128(((stamp as u128) << 80) | 0x7000_8000_0000_0000_0001)
    }
    #[test]
    fn forms_are_immutable_receipt_identity_and_recovery_never_renews_or_retains_payload() {
        use crate::authorization::{OperationFingerprint, OperationKey};
        let (mut p, desktop, scope) = setup();
        let id = Uuid::new_v4();
        let operation = OperationKey {
            request_id: Uuid::new_v4(),
            fingerprint: OperationFingerprint::of_canonical(b"synthetic-body"),
        };
        let form = Form::SingleOperation { operation };
        let first = p
            .issue_managed_agent_form(&desktop, id, vec![scope], form.clone(), 100, 0)
            .unwrap();
        let token = first.token.unwrap();
        let replay = p
            .grant_replay_form(&desktop, id, &[scope], &form, 100, 50)
            .unwrap()
            .unwrap();
        assert_eq!(replay.token.unwrap().expose(), token.expose());
        assert_eq!(replay.view.summary.expires_at_ms, 100);
        assert_eq!(replay.view.form.as_deref(), Some(&form));
        let changed = Form::SingleOperation {
            operation: OperationKey {
                fingerprint: OperationFingerprint::of_canonical(b"changed"),
                ..operation
            },
        };
        let task_id = Uuid::new_v4();
        let task = Form::TimedTask {
            task_id,
            label: "诊断任务".into(),
        };
        for other in [Form::Scoped, task.clone(), changed] {
            assert!(matches!(
                p.grant_replay_form(&desktop, id, &[scope], &other, 100, 50),
                Err(ErrorCode::InvalidArgument)
            ));
        }
        let task_request = Uuid::new_v4();
        let task_result = p
            .issue_managed_agent_form(&desktop, task_request, vec![scope], task.clone(), 100, 0)
            .unwrap();
        for other in [
            Form::TimedTask {
                task_id: Uuid::new_v4(),
                label: "诊断任务".into(),
            },
            Form::TimedTask {
                task_id,
                label: "另一任务".into(),
            },
        ] {
            assert!(matches!(
                p.grant_replay_form(&desktop, task_request, &[scope], &other, 100, 50),
                Err(ErrorCode::InvalidArgument)
            ));
        }
        p.revoke(&desktop, task_result.view.summary.ticket_id, 50)
            .unwrap();
        let revoked = p
            .grant_replay_form(&desktop, task_request, &[scope], &task, 100, 60)
            .unwrap()
            .unwrap();
        assert_eq!(revoked.view.summary.state, State::Revoked);
        assert!(revoked.token.is_none());
        assert_eq!(revoked.view.form.as_deref(), Some(&task));
        let expired = p
            .grant_replay_form(&desktop, id, &[scope], &form, 100, 100)
            .unwrap()
            .unwrap();
        assert_eq!(expired.view.summary.state, State::Expired);
        assert!(expired.token.is_none());
        let wire = serde_json::to_string(&expired.view).unwrap();
        assert!(!wire.contains("synthetic-body"));
        assert!(!wire.contains(token.expose()));
        let scoped = p
            .issue_managed_agent(&desktop, Uuid::new_v4(), vec![scope], 100, 100)
            .unwrap();
        assert!(scoped.view.form.is_none());
        assert!(
            serde_json::to_value(scoped.view)
                .unwrap()
                .get("form")
                .is_none()
        );
    }
    #[test]
    fn receipt_retries_do_not_extend_authority_and_management_never_revives_revoked_grants() {
        let (mut p, desktop, scope) = setup();
        let id = Uuid::new_v4();
        let first = p
            .issue_managed_agent(&desktop, id, vec![scope], 100, 0)
            .unwrap();
        let token = first.token.unwrap();
        let ticket = first.view.summary.ticket_id;
        let same = p
            .issue_managed_agent(&desktop, id, vec![scope], 100, 30)
            .unwrap();
        assert_eq!(same.token.unwrap().expose(), token.expose());
        assert_eq!(same.view.summary.expires_at_ms, 100);
        assert_eq!(p.tickets.len(), 2);
        assert!(matches!(
            p.issue_managed_agent(&desktop, id, vec![scope], 101, 30),
            Err(ErrorCode::InvalidArgument)
        ));
        let agent = p.authenticate(&token, 1).unwrap();
        assert!(matches!(
            p.grant_status(&agent, id, 2),
            Err(ErrorCode::PermissionDenied)
        ));
        assert!(p.grant_list(&agent, 2).is_err());
        assert!(p.revoke_managed_agent(&agent, id, 2).is_err());
        assert_eq!(p.grant_list(&desktop, 2).unwrap()[0].ticket_id, ticket);
        if let Target::Connection { connection } = scope.target {
            p.acquire_lease(&agent, connection, 50, 2).unwrap();
            p.takeover(&desktop, connection, 3).unwrap();
        }
        let taken = p.grant_status(&desktop, id, 3).unwrap();
        assert_eq!(taken.view.summary.state, State::Active);
        assert!(taken.view.effective_scopes.is_empty());
        assert_eq!(taken.view.approved_scopes, [scope]);
        let revoked = p.revoke_managed_agent(&desktop, id, 4).unwrap();
        assert_eq!(revoked.view.summary.state, State::Revoked);
        assert!(revoked.token.is_none());
        assert!(p.grants.records[&id].token.is_none());
        assert!(p.authenticate(&token, 5).is_err());
        assert_eq!(
            p.revoke_managed_agent(&desktop, id, 5)
                .unwrap()
                .view
                .summary
                .state,
            State::Revoked
        );
        assert!(
            p.issue_managed_agent(&desktop, id, vec![scope], 100, 6)
                .unwrap()
                .token
                .is_none()
        );
        assert_eq!(p.tickets.len(), 1);
        assert_eq!(
            p.grant_status(&desktop, id, 100)
                .unwrap()
                .view
                .summary
                .state,
            State::Expired
        );
    }
    #[test]
    fn bounded_receipts_retire_only_finished_ordered_ids_and_preserve_opaque_history() {
        let (mut p, desktop, scope) = setup();
        for stamp in 1..=129 {
            p.issue_managed_agent(&desktop, ordered(stamp), vec![scope], 100, stamp * 200)
                .unwrap();
        }
        assert_eq!(p.grants.records.len(), MAX_GRANT_RECEIPTS);
        assert_eq!(p.grant_list(&desktop, 25900).unwrap().len(), 128);
        assert!(matches!(
            p.issue_managed_agent(&desktop, ordered(1), vec![scope], 100, 26000),
            Err(ErrorCode::RequestExpired)
        ));
        assert!(matches!(
            p.grant_status(&desktop, ordered(1), 26000),
            Err(ErrorCode::RequestExpired)
        ));
        assert!(matches!(
            p.revoke_managed_agent(&desktop, ordered(1), 26000),
            Err(ErrorCode::RequestExpired)
        ));
        let (mut p, desktop, scope) = setup();
        for n in 0..128 {
            p.issue_managed_agent(&desktop, Uuid::new_v4(), vec![scope], 100, n * 200)
                .unwrap();
        }
        assert!(matches!(
            p.issue_managed_agent(&desktop, ordered(999), vec![scope], 100, 26000),
            Err(ErrorCode::CapacityExceeded)
        ));
        assert_eq!(p.grants.records.len(), 128);
    }
    #[test]
    fn expiry_erases_recoverable_tokens_and_old_generation_retries_never_reauthorize() {
        let (mut p, desktop, scope) = setup();
        let id = Uuid::new_v4();
        let first = p
            .issue_managed_agent(&desktop, id, vec![scope], 100, 0)
            .unwrap();
        if let Target::Connection { connection } = scope.target {
            p.retire_connection(connection, 1);
        }
        assert!(
            p.grant_replay(&desktop, id, &[scope], 100, 2)
                .unwrap()
                .unwrap()
                .view
                .effective_scopes
                .is_empty()
        );
        let expired = p.grant_status(&desktop, id, 100).unwrap();
        assert_eq!(expired.view.summary.state, State::Expired);
        assert!(expired.token.is_none());
        assert!(p.grants.records[&id].token.is_none());
        assert!(p.authenticate(&first.token.unwrap(), 100).is_err());
        assert!(
            p.issue_managed_agent(&desktop, id, vec![scope], 100, 200)
                .unwrap()
                .token
                .is_none()
        );
        assert_eq!(
            p.tickets.len(),
            1,
            "expired ticket and private rules are pruned"
        );
        assert_eq!(
            p.tickets.values().next().unwrap().identity.ticket_id(),
            desktop.ticket_id()
        );
    }
}
