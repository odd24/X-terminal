//! A single protected collection for desktop and bridge clients.
use super::{
    DesktopKind, MANAGED_ENTRY, STORE, Settings, Shortcut, lock_store, read_store, validate,
};
use credential_vault::{Secret, Vault};
use serde::{Deserialize, Serialize};
use session_protocol::{
    Sensitive,
    bridge::ResultMessage,
    shortcuts::{self as wire, Call, Error, MAX_ITEMS, Receipt, Request, Target, v2},
};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io, path::Path};
use uuid::{Uuid, Variant};

const RECEIPTS: Uuid = Uuid::from_u128(0x953b775e_310f_4a1d_9d01_db7990462d39);
const EXTENDED_RECEIPTS: Uuid = Uuid::from_u128(0x66decc8a_18cf_4aff_bfbe_0b1d984d9c88);
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

fn receipts(vault: Option<&Vault>, journal: Uuid) -> Result<Vec<SavedReceipt>, Error> {
    match vault.map(|vault| vault.get(journal)) {
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

fn list(root: &Path, args: wire::List, extended: bool) -> Result<Outcome, Error> {
    if let Some(id) = args.receipt_request_id {
        if args.query.is_some() || !request_id(id) {
            return Err(Error::InvalidArgument);
        }
        return crate::log_viewer::with_native_settings(root, STORE, false, |vault| {
            let find = |journal| {
                receipts(vault.as_deref(), journal)
                    .map(|rows| rows.into_iter().find(|row| row.receipt.request_id == id))
            };
            Ok((|| {
                if extended && let Some(row) = find(EXTENDED_RECEIPTS)? {
                    return Ok(reply(ResultMessage::ShortcutReceipt(row.receipt)));
                }
                let row = find(RECEIPTS)?.ok_or(Error::NotFound)?;
                Ok(reply(ResultMessage::ShortcutReceipt(row.receipt)))
            })())
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
        .filter(|item| extended || item.desktop_kind.is_none())
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
        });
    let snapshot = if extended {
        ResultMessage::ShortcutSnapshotV2(v2::Snapshot {
            version: v2::Version::V2,
            revision,
            items: items
                .map(|(index, item)| {
                    let send = item.desktop_kind == Some(DesktopKind::Send);
                    let target = match (item.script_path, item.desktop_kind) {
                        (Some(path), _) => v2::Target::Script {
                            path: Sensitive::new(path),
                        },
                        (None, Some(DesktopKind::Local)) => v2::Target::Local {
                            command: Sensitive::new(item.command),
                        },
                        (None, Some(DesktopKind::Send)) => v2::Target::Send {
                            text: Sensitive::new(item.command),
                        },
                        (None, None) => v2::Target::Adb {
                            command: Sensitive::new(item.command),
                        },
                    };
                    v2::Item {
                        id: item.id,
                        name: Sensitive::new(item.name),
                        target,
                        order: index + 1,
                        pinned: item.pinned,
                        close_on_success: (!send).then_some(item.close_on_success),
                        append_enter: send.then_some(item.append_enter),
                    }
                })
                .collect(),
        })
    } else {
        ResultMessage::ShortcutSnapshot(wire::Snapshot {
            revision,
            items: items
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
                .collect(),
        })
    };
    Ok(reply(snapshot))
}

fn extended_target(target: Target) -> v2::Target {
    match target {
        Target::Adb { command } => v2::Target::Adb { command },
        Target::Script { path } => v2::Target::Script { path },
    }
}

fn assign_target(item: &mut Shortcut, target: v2::Target) {
    match target {
        v2::Target::Adb { command } => item.command = command.expose().to_owned(),
        v2::Target::Script { path } => item.script_path = Some(path.expose().to_owned()),
        v2::Target::Local { command } => {
            item.desktop_kind = Some(DesktopKind::Local);
            item.command = command.expose().to_owned();
        }
        v2::Target::Send { text } => {
            item.desktop_kind = Some(DesktopKind::Send);
            item.command = text.expose().to_owned();
        }
    }
}

fn set_name(item: &mut Shortcut, name: Option<Sensitive>, extended: bool) -> Result<(), Error> {
    let value = name.as_ref().map(Sensitive::expose).unwrap_or("");
    if value.chars().count() > 64 || value.chars().any(char::is_control) {
        return Err(Error::InvalidArgument);
    }
    item.name = match item.script_path.as_deref().filter(|_| extended) {
        Some(script) if value.trim().is_empty() => {
            let path = Path::new(script);
            if !super::super::scripts::valid_path(script) {
                return Err(Error::InvalidArgument);
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or(Error::InvalidArgument)?;
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .ok_or(Error::InvalidArgument)?;
            format!("{}.{ext}", stem.chars().take(60).collect::<String>())
        }
        Some(_) => value.trim().to_owned(),
        None => value.to_owned(),
    };
    Ok(())
}

fn options(item: &mut Shortcut, close: Option<bool>, enter: Option<bool>) -> Result<(), Error> {
    if let Some(close) = close {
        if item.desktop_kind == Some(DesktopKind::Send) {
            return Err(Error::InvalidArgument);
        }
        item.close_on_success = close;
    }
    if let Some(enter) = enter {
        if item.desktop_kind != Some(DesktopKind::Send) {
            return Err(Error::InvalidArgument);
        }
        item.append_enter = enter;
    }
    Ok(())
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

fn move_block(items: &mut Vec<Shortcut>, order: v2::MoveBlock) -> Result<(), Error> {
    let (ids, anchor, after) = match order {
        v2::MoveBlock::Anchor(args) => (
            unique_ids(&args.ids)?,
            Some(args.anchor),
            matches!(args.side, wire::Side::After),
        ),
        v2::MoveBlock::Edge(args) => (
            unique_ids(&args.ids)?,
            None,
            matches!(args.edge, v2::Edge::Last),
        ),
    };
    if anchor.is_some_and(|id| id.is_nil() || ids.contains(&id)) {
        return Err(Error::InvalidArgument);
    }
    let pinned = items
        .iter()
        .find(|item| anchor.map_or_else(|| ids.contains(&item.id), |anchor| item.id == anchor))
        .ok_or(Error::NotFound)?
        .pinned;
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
    let at = match anchor {
        Some(anchor) => {
            others
                .iter()
                .position(|item| item.id == anchor)
                .ok_or(Error::NotFound)?
                + usize::from(after)
        }
        None => {
            let boundary = others.partition_point(|item| item.pinned);
            match (pinned, after) {
                (true, false) => 0,
                (false, true) => others.len(),
                _ => boundary,
            }
        }
    };
    others.splice(at..at, block);
    *items = others;
    Ok(())
}

fn edit(
    items: &mut Vec<Shortcut>,
    changes: Vec<v2::Change>,
    moves: Vec<v2::MoveBlock>,
    extended: bool,
) -> Result<Vec<Uuid>, Error> {
    if changes.len() > MAX_ITEMS
        || moves.len() > MAX_ITEMS
        || (changes.is_empty() && moves.is_empty())
    {
        return Err(Error::InvalidArgument);
    }
    let mut affected = HashSet::new();
    let mut repinned = HashSet::new();
    for change in changes {
        if change.id.is_nil()
            || !affected.insert(change.id)
            || (change.name.is_none()
                && change.target.is_none()
                && change.pinned.is_none()
                && change.close_on_success.is_none()
                && change.append_enter.is_none())
        {
            return Err(Error::InvalidArgument);
        }
        let item = items
            .iter_mut()
            .find(|item| item.id == change.id)
            .ok_or(Error::NotFound)?;
        if let Some(target) = change.target {
            if !matches!(
                (item.script_path.is_some(), item.desktop_kind, &target),
                (true, None, v2::Target::Script { .. })
                    | (false, None, v2::Target::Adb { .. })
                    | (false, Some(DesktopKind::Local), v2::Target::Local { .. })
                    | (false, Some(DesktopKind::Send), v2::Target::Send { .. })
            ) {
                return Err(Error::InvalidArgument);
            }
            assign_target(item, target);
        }
        if change.name.is_some() {
            set_name(item, change.name, extended)?;
        }
        options(item, change.close_on_success, change.append_enter)?;
        if let Some(pinned) = change.pinned
            && item.pinned != pinned
        {
            item.pinned = pinned;
            repinned.insert(item.id);
        }
    }
    items.sort_by_key(|item| (!item.pinned, repinned.contains(&item.id)));
    for order in moves {
        affected.extend(match &order {
            v2::MoveBlock::Anchor(args) => &args.ids,
            v2::MoveBlock::Edge(args) => &args.ids,
        });
        move_block(items, order)?;
    }
    Ok(items
        .iter()
        .filter(|item| affected.contains(&item.id))
        .map(|item| item.id)
        .collect())
}

enum Mutation {
    Create(Vec<v2::CreateItem>),
    Update(Vec<v2::Change>, Vec<v2::MoveBlock>),
    Remove(Vec<Uuid>),
}

impl TryFrom<Call> for Mutation {
    type Error = Error;
    fn try_from(call: Call) -> Result<Self, Error> {
        Ok(match call {
            Call::Legacy(Request::Create(args)) => Self::Create(
                args.items
                    .into_iter()
                    .map(|item| v2::CreateItem {
                        name: Some(item.name),
                        target: extended_target(item.target),
                        pinned: item.pinned,
                        close_on_success: None,
                        append_enter: None,
                    })
                    .collect(),
            ),
            Call::Legacy(Request::Update(args)) => Self::Update(
                args.changes
                    .into_iter()
                    .map(|change| v2::Change {
                        id: change.id,
                        name: change.name,
                        target: change.target.map(extended_target),
                        pinned: change.pinned,
                        close_on_success: None,
                        append_enter: None,
                    })
                    .collect(),
                args.moves.into_iter().map(v2::MoveBlock::Anchor).collect(),
            ),
            Call::Legacy(Request::Remove(args)) => Self::Remove(args.ids),
            Call::Extended(v2::Request::Create(args)) => Self::Create(args.items),
            Call::Extended(v2::Request::Update(args)) => Self::Update(args.changes, args.moves),
            Call::Extended(v2::Request::Remove(args)) => Self::Remove(args.ids),
            _ => return Err(Error::InvalidArgument),
        })
    }
}

fn mutate(
    items: &mut Vec<Shortcut>,
    request: Mutation,
    extended: bool,
) -> Result<Vec<Uuid>, Error> {
    match request {
        Mutation::Create(entries) => {
            if !(1..=MAX_ITEMS).contains(&entries.len()) {
                return Err(Error::InvalidArgument);
            }
            if items.len() + entries.len() > MAX_ITEMS {
                return Err(Error::CapacityExceeded);
            }
            let mut ids = Vec::with_capacity(entries.len());
            for entry in entries {
                let id = Uuid::new_v4();
                let mut item = Shortcut {
                    id,
                    name: String::new(),
                    command: String::new(),
                    script_path: None,
                    pinned: entry.pinned,
                    desktop_kind: None,
                    append_enter: false,
                    close_on_success: false,
                };
                assign_target(&mut item, entry.target);
                set_name(&mut item, entry.name, extended)?;
                options(&mut item, entry.close_on_success, entry.append_enter)?;
                items.push(item);
                ids.push(id);
            }
            items.sort_by_key(|item| !item.pinned);
            Ok(ids)
        }
        Mutation::Update(changes, moves) => edit(items, changes, moves, extended),
        Mutation::Remove(args) => {
            let ids = unique_ids(&args)?;
            let before = items.len();
            items.retain(|item| !ids.contains(&item.id));
            if before - items.len() != ids.len() {
                return Err(Error::NotFound);
            }
            Ok(args)
        }
    }
}

fn save(
    vault: &mut Vault,
    request: Call,
    id: Uuid,
    expected_revision: Uuid,
    allowed: &impl Fn() -> bool,
) -> Result<Outcome, Error> {
    let mut hash = RequestDigest(Sha256::new());
    match &request {
        Call::Legacy(request) => serde_json::to_writer(&mut hash, request),
        Call::Extended(request) => serde_json::to_writer(&mut hash, request),
    }
    .map_err(|_| Error::InvalidArgument)?;
    let digest = hash.0.finalize().into();
    let extended = matches!(&request, Call::Extended(_));
    let (journal, other) = if extended {
        (EXTENDED_RECEIPTS, RECEIPTS)
    } else {
        (RECEIPTS, EXTENDED_RECEIPTS)
    };
    let mut rows = receipts(Some(vault), journal)?;
    if receipts(Some(vault), other)?
        .iter()
        .any(|row| row.receipt.request_id == id)
    {
        return Err(Error::RequestConflict);
    }
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
    let ids = if extended {
        mutate(&mut settings.shortcuts, Mutation::try_from(request)?, true)?
    } else {
        let available = |item: &Shortcut| item.desktop_kind.is_none();
        let mut exposed: Vec<_> = settings
            .shortcuts
            .iter()
            .filter(|item| available(item))
            .cloned()
            .collect();
        let ids = mutate(&mut exposed, Mutation::try_from(request)?, false)?;
        let mut unpinned = exposed
            .split_off(exposed.partition_point(|item| item.pinned))
            .into_iter();
        let mut pinned = exposed.into_iter();
        let mut merged = Vec::with_capacity(settings.shortcuts.len());
        for row in settings.shortcuts {
            if !available(&row) {
                merged.push(row);
            } else if let Some(row) = if row.pinned {
                pinned.next()
            } else {
                unpinned.next()
            } {
                merged.push(row);
            }
        }
        merged.extend(pinned);
        merged.extend(unpinned);
        merged.sort_by_key(|row| !row.pinned);
        settings.shortcuts = merged;
        ids
    };
    if settings.shortcuts.len() > MAX_ITEMS {
        return Err(Error::CapacityExceeded);
    }
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
    let saved_rows = stored(serde_json::to_vec(&rows).map_err(|_| Error::StorageUnavailable)?)?;
    if !allowed() {
        return Err(Error::PermissionDenied);
    }
    let committed = vault
        .set_pair_if((MANAGED_ENTRY, items), (journal, saved_rows), allowed)
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
    request: Call,
    allowed: impl Fn() -> bool,
) -> Result<Outcome, Error> {
    if !allowed() {
        return Err(Error::PermissionDenied);
    }
    let result = match request {
        Call::Legacy(Request::List(args)) => list(root, args, false),
        Call::Extended(v2::Request::List(args)) => list(
            root,
            wire::List {
                query: args.query,
                receipt_request_id: args.receipt_request_id,
            },
            true,
        ),
        request => return handle_mutation(root, request, allowed),
    };
    if allowed() {
        result
    } else {
        Err(Error::PermissionDenied)
    }
}

fn handle_mutation(
    root: &Path,
    request: Call,
    allowed: impl Fn() -> bool,
) -> Result<Outcome, Error> {
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
