//! A single protected collection for desktop and bridge clients.
use super::{MANAGED_ENTRY, STORE, Settings, Shortcut, lock_store, read_store, validate};
use credential_vault::{Secret, Vault};
use serde::{Deserialize, Serialize};
use session_protocol::{
    Sensitive,
    bridge::ResultMessage,
    shortcuts::{self as wire, Error, MAX_ITEMS, Receipt, Request, Target},
};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io, path::Path};
use uuid::{Uuid, Variant};

const RECEIPTS: Uuid = Uuid::from_u128(0x953b775e_310f_4a1d_9d01_db7990462d39);
const MAX_RECEIPTS: usize = 32;

struct RequestDigest(Sha256);
impl io::Write for RequestDigest {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedReceipt {
    digest: [u8; 32],
    receipt: Receipt,
}

pub(crate) struct Outcome {
    pub reply: ResultMessage,
    pub committed_revision: Option<Uuid>,
}

fn reply(reply: ResultMessage) -> Outcome {
    Outcome {
        reply,
        committed_revision: None,
    }
}

fn revision(settings: &Settings) -> Uuid {
    settings.revision.unwrap_or(Uuid::nil())
}

fn request_id(id: Uuid) -> bool {
    id.get_version_num() == 7 && id.get_variant() == Variant::RFC4122
}

fn receipts(vault: Option<&Vault>) -> Result<Vec<SavedReceipt>, Error> {
    match vault.map(|vault| vault.get(RECEIPTS)) {
        None | Some(Err(credential_vault::Error::NotFound)) => Ok(Vec::new()),
        Some(Ok(secret)) => {
            let rows: Vec<SavedReceipt> =
                serde_json::from_slice(secret.expose()).map_err(|_| Error::StorageUnavailable)?;
            if rows.len() > MAX_RECEIPTS {
                return Err(Error::StorageUnavailable);
            }
            Ok(rows)
        }
        _ => Err(Error::StorageUnavailable),
    }
}

fn list(root: &Path, args: wire::List) -> Result<Outcome, Error> {
    if let Some(id) = args.receipt_request_id {
        if args.query.is_some() || !request_id(id) {
            return Err(Error::InvalidArgument);
        }
        return crate::log_viewer::with_native_settings(root, STORE, false, |vault| {
            Ok(receipts(vault.as_deref()).and_then(|rows| {
                rows.into_iter()
                    .find(|row| row.receipt.request_id == id)
                    .map(|row| reply(ResultMessage::ShortcutReceipt(row.receipt)))
                    .ok_or(Error::NotFound)
            }))
        })
        .map_err(|_| Error::StorageUnavailable)?;
    }
    let query = args.query.as_ref().map(Sensitive::expose).unwrap_or("");
    if query.chars().count() > 256 || query.chars().any(char::is_control) {
        return Err(Error::InvalidArgument);
    }
    let query = query.to_lowercase();
    let settings = super::read(root).map_err(|_| Error::StorageUnavailable)?;
    let revision = revision(&settings);
    let items = settings
        .shortcuts
        .into_iter()
        .enumerate()
        .filter(|(_, item)| {
            query.is_empty()
                || item.name.to_lowercase().contains(&query)
                || item
                    .script_path
                    .as_deref()
                    .unwrap_or(&item.command)
                    .to_lowercase()
                    .contains(&query)
        })
        .map(|(index, item)| wire::Item {
            id: item.id,
            name: Sensitive::new(item.name),
            target: match item.script_path {
                Some(path) => Target::Script {
                    path: Sensitive::new(path),
                },
                None => Target::Adb {
                    command: Sensitive::new(item.command),
                },
            },
            order: index + 1,
            pinned: item.pinned,
        })
        .collect();
    Ok(reply(ResultMessage::ShortcutSnapshot(wire::Snapshot {
        revision,
        items,
    })))
}

fn assign_target(item: &mut Shortcut, target: Target) {
    match target {
        Target::Adb { command } => item.command = command.expose().to_owned(),
        Target::Script { path } => item.script_path = Some(path.expose().to_owned()),
    }
}

fn unique_ids(ids: &[Uuid]) -> Result<HashSet<Uuid>, Error> {
    let result: HashSet<_> = ids.iter().copied().collect();
    if !(1..=MAX_ITEMS).contains(&ids.len())
        || result.len() != ids.len()
        || result.contains(&Uuid::nil())
    {
        return Err(Error::InvalidArgument);
    }
    Ok(result)
}

fn move_block(items: &mut Vec<Shortcut>, args: wire::Move) -> Result<(), Error> {
    let ids = unique_ids(&args.ids)?;
    if args.anchor.is_nil() || ids.contains(&args.anchor) {
        return Err(Error::InvalidArgument);
    }
    let anchor = items
        .iter()
        .find(|item| item.id == args.anchor)
        .ok_or(Error::NotFound)?;
    let pinned = anchor.pinned;
    let mut block = Vec::with_capacity(ids.len());
    let mut others = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        if ids.contains(&item.id) {
            if item.pinned != pinned {
                return Err(Error::InvalidArgument);
            }
            block.push(item);
        } else {
            others.push(item);
        }
    }
    if block.len() != ids.len() {
        return Err(Error::NotFound);
    }
    let at = others
        .iter()
        .position(|item| item.id == args.anchor)
        .ok_or(Error::NotFound)?;
    let at = at + usize::from(matches!(args.side, wire::Side::After));
    others.splice(at..at, block);
    *items = others;
    Ok(())
}

fn edit(items: &mut Vec<Shortcut>, args: wire::Update) -> Result<Vec<Uuid>, Error> {
    if args.changes.len() > MAX_ITEMS
        || args.moves.len() > MAX_ITEMS
        || (args.changes.is_empty() && args.moves.is_empty())
    {
        return Err(Error::InvalidArgument);
    }
    let mut affected = HashSet::new();
    let mut repinned = HashSet::new();
    for change in args.changes {
        if change.id.is_nil()
            || !affected.insert(change.id)
            || (change.name.is_none() && change.target.is_none() && change.pinned.is_none())
        {
            return Err(Error::InvalidArgument);
        }
        let item = items
            .iter_mut()
            .find(|item| item.id == change.id)
            .ok_or(Error::NotFound)?;
        if let Some(name) = change.name {
            item.name = name.expose().to_owned();
        }
        if let Some(target) = change.target {
            if item.script_path.is_some() != matches!(target, Target::Script { .. }) {
                return Err(Error::InvalidArgument);
            }
            assign_target(item, target);
        }
        if let Some(pinned) = change.pinned
            && item.pinned != pinned
        {
            item.pinned = pinned;
            repinned.insert(item.id);
        }
    }
    items.sort_by_key(|item| (!item.pinned, repinned.contains(&item.id)));
    for order in args.moves {
        affected.extend(order.ids.iter().copied());
        move_block(items, order)?;
    }
    Ok(items
        .iter()
        .filter(|item| affected.contains(&item.id))
        .map(|item| item.id)
        .collect())
}

fn mutate(items: &mut Vec<Shortcut>, request: Request) -> Result<Vec<Uuid>, Error> {
    match request {
        Request::Create(args) => {
            if !(1..=MAX_ITEMS).contains(&args.items.len()) {
                return Err(Error::InvalidArgument);
            }
            if items.len() + args.items.len() > MAX_ITEMS {
                return Err(Error::CapacityExceeded);
            }
            let mut ids = Vec::with_capacity(args.items.len());
            for entry in args.items {
                let id = Uuid::new_v4();
                let mut item = Shortcut {
                    id,
                    name: entry.name.expose().to_owned(),
                    command: String::new(),
                    script_path: None,
                    pinned: entry.pinned,
                };
                assign_target(&mut item, entry.target);
                items.push(item);
                ids.push(id);
            }
            items.sort_by_key(|item| !item.pinned);
            Ok(ids)
        }
        Request::Update(args) => edit(items, args),
        Request::Remove(args) => {
            let ids = unique_ids(&args.ids)?;
            let before = items.len();
            items.retain(|item| !ids.contains(&item.id));
            if before - items.len() != ids.len() {
                return Err(Error::NotFound);
            }
            Ok(args.ids)
        }
        Request::List(_) => Err(Error::InvalidArgument),
    }
}

fn save(
    vault: &mut Vault,
    request: Request,
    id: Uuid,
    expected_revision: Uuid,
    allowed: &impl Fn() -> bool,
) -> Result<Outcome, Error> {
    let mut hash = RequestDigest(Sha256::new());
    serde_json::to_writer(&mut hash, &request).map_err(|_| Error::InvalidArgument)?;
    let digest = hash.0.finalize().into();
    let mut rows = receipts(Some(vault))?;
    if let Some(row) = rows.iter().find(|row| row.receipt.request_id == id) {
        return if !allowed() {
            Err(Error::PermissionDenied)
        } else if row.digest != digest {
            Err(Error::RequestConflict)
        } else {
            Ok(reply(ResultMessage::ShortcutReceipt(row.receipt.clone())))
        };
    }
    let mut settings = read_store(Some(vault)).map_err(|_| Error::StorageUnavailable)?;
    if revision(&settings) != expected_revision {
        return Err(Error::RevisionConflict);
    }
    let ids = mutate(&mut settings.shortcuts, request)?;
    validate(&settings).map_err(|_| Error::InvalidArgument)?;
    let revision = Uuid::new_v4();
    settings.revision = Some(revision);
    let receipt = Receipt {
        request_id: id,
        revision,
        ids,
    };
    if rows.len() == MAX_RECEIPTS {
        rows.remove(0);
    }
    rows.push(SavedReceipt {
        digest,
        receipt: receipt.clone(),
    });
    let stored = |bytes| Secret::new(bytes).map_err(|_| Error::CapacityExceeded);
    let items = stored(serde_json::to_vec(&settings).map_err(|_| Error::StorageUnavailable)?)?;
    let journal = stored(serde_json::to_vec(&rows).map_err(|_| Error::StorageUnavailable)?)?;
    if !allowed() {
        return Err(Error::PermissionDenied);
    }
    let committed = vault
        .set_pair_if((MANAGED_ENTRY, items), (RECEIPTS, journal), allowed)
        .map_err(|_| Error::UnknownDelivery)?;
    if !committed {
        return Err(Error::PermissionDenied);
    }
    Ok(Outcome {
        reply: ResultMessage::ShortcutReceipt(receipt),
        committed_revision: Some(revision),
    })
}

pub(crate) fn handle(
    root: &Path,
    request: Request,
    allowed: impl Fn() -> bool,
) -> Result<Outcome, Error> {
    if !allowed() {
        return Err(Error::PermissionDenied);
    }
    if let Request::List(args) = request {
        let result = list(root, args);
        return if allowed() {
            result
        } else {
            Err(Error::PermissionDenied)
        };
    }
    let (id, version) = request.write_key().ok_or(Error::InvalidArgument)?;
    if !request_id(id) {
        return Err(Error::InvalidArgument);
    }
    let _lock = lock_store(root).map_err(|error| match error.raw_os_error() {
        Some(32 | 33) => Error::InputBusy,
        _ => Error::StorageUnavailable,
    })?;
    crate::log_viewer::with_native_settings(root, STORE, true, |vault| {
        Ok(vault
            .ok_or(Error::StorageUnavailable)
            .and_then(|v| save(v, request, id, version, &allowed)))
    })
    .map_err(|_| Error::StorageUnavailable)?
}
