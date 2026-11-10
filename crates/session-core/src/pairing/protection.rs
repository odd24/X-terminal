//! Output policy binding. Receipts retain salted equality metadata, not rule values.
use super::*;
use crate::{authorization::Form, redaction};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Definition {
    pub scopes: Vec<Scope>,
    pub form: Form,
    pub redaction: Option<Arc<redaction::Policy>>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Info {
    pub policy_id: Uuid,
    pub sensitive_fields: bool,
    pub literal_count: usize,
}
pub struct ProtectedPolicy {
    pub info: Info,
    pub rules: Arc<redaction::Policy>,
}
pub(super) struct Receipt {
    pub(super) info: Info,
    salt: [u8; 32],
    signature: [u8; 32],
}
impl Receipt {
    pub(super) fn new(policy: &ProtectedPolicy) -> Self {
        let salt = rand::random();
        Self {
            info: policy.info,
            signature: policy.rules.receipt_signature(&salt),
            salt,
        }
    }
    pub(super) fn matches(&self, rules: &redaction::Policy) -> bool {
        self.signature == rules.receipt_signature(&self.salt)
    }
}
impl Pairing {
    pub fn output_protection(
        &self,
        identity: &Identity,
        now: u64,
    ) -> Result<Option<Arc<ProtectedPolicy>>, ErrorCode> {
        Ok(self.ticket(identity, now)?.protection.clone())
    }
    pub fn require_unfiltered_output(
        &self,
        identity: &Identity,
        now: u64,
    ) -> Result<(), ErrorCode> {
        if self.ticket(identity, now)?.protection.is_some() {
            Err(ErrorCode::PermissionDenied)
        } else {
            Ok(())
        }
    }
    pub fn issue_agent_definition(
        &mut self,
        desktop: &Identity,
        definition: Definition,
        lifetime_ms: u64,
        now: u64,
    ) -> Result<(Identity, SecretToken, u64), ErrorCode> {
        self.require_desktop(desktop, now)?;
        if definition
            .scopes
            .iter()
            .any(|scope| scope.action == Action::Export)
            && definition.redaction.is_none()
        {
            return Err(ErrorCode::InvalidArgument);
        }
        if definition.redaction.is_some()
            && !definition
                .scopes
                .iter()
                .any(|s| matches!(s.action, Action::Read | Action::Exec | Action::Export))
        {
            return Err(ErrorCode::InvalidArgument);
        }
        self.tickets.retain(|_, ticket| ticket.expires_at_ms > now);
        if self.tickets.len() >= MAX_TICKETS {
            return Err(ErrorCode::CapacityExceeded);
        }
        let identity = Identity {
            ticket_id: Uuid::new_v4(),
            operation: None,
        };
        let expires = self
            .policy
            .grant_form(
                identity.ticket_id,
                definition.scopes,
                definition.form,
                lifetime_ms,
                now,
            )
            .map_err(policy_error)?;
        let protection = definition.redaction.map(|rules| {
            let (sensitive_fields, literal_count) = rules.summary();
            Arc::new(ProtectedPolicy {
                info: Info {
                    policy_id: Uuid::new_v4(),
                    sensitive_fields,
                    literal_count,
                },
                rules,
            })
        });
        let token = SecretToken::generate();
        self.tickets.insert(
            token.digest(),
            Ticket {
                identity: identity.clone(),
                authority: Authority::Agent,
                expires_at_ms: expires,
                protection,
            },
        );
        Ok((identity, token, expires))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ConnectionId;
    fn setup() -> (Pairing, Identity, Scope) {
        let bootstrap = SecretToken::generate();
        let pairing = Pairing::new(&bootstrap);
        let desktop = pairing.authenticate(&bootstrap, 0).unwrap();
        let scope = Scope {
            target: Target::Connection {
                connection: ConnectionRef {
                    connection_id: ConnectionId(Uuid::new_v4()),
                    generation: 1,
                },
            },
            action: Action::Read,
        };
        (pairing, desktop, scope)
    }
    fn protected_definition(scope: Scope, secret: &str, fields: bool) -> Definition {
        Definition {
            scopes: vec![scope],
            form: Form::Scoped,
            redaction: Some(Arc::new(
                redaction::Policy::new(vec![secret.into()], fields).unwrap(),
            )),
        }
    }
    #[test]
    fn export_requires_protected_single_binding_without_read_or_input_lease() {
        use crate::authorization::{OperationFingerprint, OperationKey};
        let (mut pairing, desktop, mut scope) = setup();
        scope.action = Action::Export;
        let connection = scope.target.connection().unwrap();
        let operation = OperationKey {
            request_id: Uuid::from_u128(0x0195_0203_0405_7000_8000_0000_0000_0001),
            fingerprint: OperationFingerprint::of_canonical(b"fixed export"),
        };
        let mut definition = protected_definition(scope, "synthetic-secret", true);
        assert!(
            pairing
                .issue_agent_definition(&desktop, definition.clone(), 100, 0)
                .is_err()
        );
        definition.form = Form::SingleOperation { operation };
        let mut unprotected = definition.clone();
        unprotected.redaction = None;
        assert!(
            pairing
                .issue_agent_definition(&desktop, unprotected, 100, 0)
                .is_err()
        );
        let (identity, _, _) = pairing
            .issue_agent_definition(&desktop, definition, 100, 0)
            .unwrap();
        assert_eq!(
            pairing.can_read(&identity, connection, 1),
            Err(ErrorCode::PermissionDenied)
        );
        assert!(pairing.acquire_lease(&identity, connection, 50, 1).is_err());
        let changed = OperationKey {
            fingerprint: OperationFingerprint::of_canonical(b"changed export"),
            ..operation
        };
        assert!(
            pairing
                .admit_export(&identity, connection, changed, 1)
                .is_err()
        );
        let permit = pairing
            .admit_export(&identity, connection, operation, 1)
            .unwrap();
        assert!(pairing.check_input(&identity, &permit, 2).is_ok());
        pairing.retire_connection(connection, 3);
        assert_eq!(
            pairing.check_input(&identity, &permit, 3),
            Err(ErrorCode::PermissionDenied)
        );
    }
    #[test]
    fn protected_receipt_replay_binds_private_rules_without_retaining_their_values_after_revocation()
     {
        let (mut pairing, desktop, scope) = setup();
        let id = Uuid::new_v4();
        let definition = protected_definition(scope, "synthetic-private-mask", true);
        let weak = Arc::downgrade(definition.redaction.as_ref().unwrap());
        assert!(!format!("{definition:?}").contains("synthetic-private-mask"));
        let first = pairing
            .issue_managed_agent_definition(&desktop, id, definition, 100, 0)
            .unwrap();
        let info = first.view.protection.unwrap();
        assert_eq!(info.literal_count, 1);
        assert!(info.sensitive_fields);
        assert!(!info.policy_id.is_nil());
        let token = first.token.unwrap();
        let identity = pairing.authenticate(&token, 1).unwrap();
        assert_eq!(
            pairing
                .output_protection(&identity, 1)
                .unwrap()
                .unwrap()
                .info,
            info
        );
        assert_eq!(
            pairing.require_unfiltered_output(&identity, 1),
            Err(ErrorCode::PermissionDenied)
        );
        pairing
            .can_read(&identity, scope.target.connection().unwrap(), 1)
            .unwrap();
        for changed in [
            protected_definition(scope, "changed", true),
            protected_definition(scope, "synthetic-private-mask", false),
            Definition {
                scopes: vec![scope],
                form: Form::Scoped,
                redaction: None,
            },
        ] {
            assert!(matches!(
                pairing.grant_replay_definition(&desktop, id, &changed, 100, 2),
                Err(ErrorCode::InvalidArgument)
            ));
        }
        let same = protected_definition(scope, "synthetic-private-mask", true);
        let replay = pairing
            .grant_replay_definition(&desktop, id, &same, 100, 50)
            .unwrap()
            .unwrap();
        assert_eq!(replay.view.protection, Some(info));
        assert_eq!(replay.view.summary.expires_at_ms, 100);
        assert_eq!(replay.token.unwrap().expose(), token.expose());
        assert!(weak.upgrade().is_some());
        let wire = serde_json::to_string(&replay.view).unwrap();
        assert!(!wire.contains("synthetic-private-mask"));
        assert!(!wire.contains("signature"));
        assert!(!wire.contains("salt"));
        pairing.revoke(&desktop, identity.ticket_id(), 60).unwrap();
        assert!(
            weak.upgrade().is_none(),
            "the ledger must not retain the sensitive rules"
        );
        let replay = pairing
            .grant_replay_definition(&desktop, id, &same, 100, 70)
            .unwrap()
            .unwrap();
        assert!(replay.token.is_none());
        assert_eq!(replay.view.protection, Some(info));
        assert_eq!(replay.view.summary.state, grants::State::Revoked);
        assert!(pairing.output_protection(&identity, 70).is_err());
    }
    #[test]
    fn protection_is_ticket_specific_does_not_grant_observation_and_expired_rules_drop_on_pruning()
    {
        let (mut pairing, desktop, scope) = setup();
        let write = Scope {
            action: Action::Write,
            ..scope
        };
        assert!(matches!(
            pairing.issue_agent_definition(
                &desktop,
                protected_definition(write, "mask", true),
                100,
                0
            ),
            Err(ErrorCode::InvalidArgument)
        ));
        let definition = protected_definition(scope, "mask", true);
        let weak = Arc::downgrade(definition.redaction.as_ref().unwrap());
        let id = Uuid::new_v4();
        let first = pairing
            .issue_managed_agent_definition(&desktop, id, definition, 10, 0)
            .unwrap();
        let token = first.token.unwrap();
        let identity = pairing.authenticate(&token, 1).unwrap();
        let (legacy, _, _) = pairing.issue_agent(&desktop, vec![scope], 100, 0).unwrap();
        assert!(pairing.output_protection(&legacy, 1).unwrap().is_none());
        pairing.require_unfiltered_output(&legacy, 1).unwrap();
        pairing.require_unfiltered_output(&desktop, 1).unwrap();
        let other = ConnectionRef {
            connection_id: ConnectionId(Uuid::new_v4()),
            generation: 1,
        };
        assert_eq!(
            pairing.can_read(&identity, other, 1),
            Err(ErrorCode::PermissionDenied)
        );
        let query = pairing.grant_status(&desktop, id, 10).unwrap();
        assert_eq!(query.view.summary.state, grants::State::Expired);
        assert!(query.token.is_none());
        assert!(weak.upgrade().is_none());
        assert!(pairing.output_protection(&identity, 10).is_err());
        let first = pairing
            .issue_managed_agent_definition(
                &desktop,
                Uuid::new_v4(),
                protected_definition(scope, "mask", true),
                100,
                10,
            )
            .unwrap();
        let second = pairing
            .issue_managed_agent_definition(
                &desktop,
                Uuid::new_v4(),
                protected_definition(scope, "mask", true),
                100,
                10,
            )
            .unwrap();
        assert_ne!(
            first.view.protection.unwrap().policy_id,
            second.view.protection.unwrap().policy_id
        );
    }
}
