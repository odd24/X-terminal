//! Read-only restart diagnostics for confirmed replacements. No path is recovered.
use super::{Result, Store, Unavailable, io, publish_file, publish_leaf, read_leaf};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const DIRECTORY: &str = "desktop-save-recovery-v1";
const LIMIT: usize = 16;
const MAX_LINE: usize = 4096;
const MAX_TIME: u64 = 253_402_300_799_999;
const MAX_NAME: usize = 1024;
type Object = (u32, u32, u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Phase {
    Unknown,
    Published,
    NotPublished,
    Preserve,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub save_id: Uuid,
    pub name: String,
    pub at_ms: u64,
    pub phase: Phase,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    version: u8,
    save_id: Uuid,
    at_ms: u64,
    name: String,
    parent: Object,
    original: Object,
    staging: Object,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Terminal {
    version: u8,
    save_id: Uuid,
    at_ms: u64,
    phase: Phase,
}

fn clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn unsafe_character(c: char) -> bool {
    c.is_control()
        || matches!(c as u32, 0x061c | 0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x206f | 0xfeff)
}

fn display_name(name: &str) -> String {
    use std::fmt::Write as _;
    let mut display = String::new();
    for c in name.chars() {
        if display.len() > MAX_NAME - 16 {
            display.push('…');
            break;
        }
        if unsafe_character(c) {
            let _ = write!(display, "⟦U+{:04X}⟧", c as u32);
        } else {
            display.push(c);
        }
    }
    display
}

fn decode<T: serde::de::DeserializeOwned>(line: &[u8]) -> Result<T> {
    if line.len() > MAX_LINE {
        return Err(Unavailable::Untrusted);
    }
    let value: serde_json::Value =
        serde_json::from_slice(line).map_err(|_| Unavailable::Untrusted)?;
    if value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|version| version != 1)
    {
        return Err(Unavailable::Unsupported);
    }
    serde_json::from_slice(line).map_err(|_| Unavailable::Untrusted)
}

fn parse_intent(bytes: &[u8], id: Uuid) -> Result<Intent> {
    let intent: Intent = decode(bytes)?;
    if id.is_nil()
        || intent.version != 1
        || intent.save_id != id
        || !(1..=MAX_TIME).contains(&intent.at_ms)
        || intent.name.is_empty()
        || intent.name.len() > MAX_NAME
        || intent
            .name
            .chars()
            .any(|c| unsafe_character(c) || "<>:\"/\\|?*".contains(c))
        || intent.parent.0 != intent.original.0
        || intent.original.0 != intent.staging.0
        || intent.original == intent.staging
        || intent.parent == intent.original
        || intent.parent == intent.staging
    {
        return Err(Unavailable::Untrusted);
    }
    Ok(intent)
}

fn parse_terminal(bytes: &[u8], id: Uuid) -> Result<Terminal> {
    let t: Terminal = decode(bytes)?;
    if t.version != 1
        || t.save_id != id
        || !(1..=MAX_TIME).contains(&t.at_ms)
        || t.phase == Phase::Unknown
    {
        return Err(Unavailable::Untrusted);
    }
    Ok(t)
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| Unavailable::Untrusted)?;
    if bytes.len() > MAX_LINE {
        return Err(Unavailable::Untrusted);
    }
    Ok(bytes)
}

#[derive(Default)]
struct Slot {
    intent: Option<(File, Intent)>,
    terminal: Option<(File, Terminal)>,
}

fn scan(store: &Store) -> Result<BTreeMap<Uuid, Slot>> {
    let mut slots = BTreeMap::<Uuid, Slot>::new();
    for item in fs::read_dir(&store.path).map_err(io)? {
        let item = item.map_err(io)?;
        let name = item.file_name();
        let name = name.to_str().ok_or(Unavailable::Untrusted)?;
        if name == "store.lock" {
            continue;
        }
        let (id, suffix) = name.split_once('.').ok_or(Unavailable::Untrusted)?;
        let id = Uuid::parse_str(id).map_err(|_| Unavailable::Untrusted)?;
        if id.is_nil() || !matches!(suffix, "json" | "done") || name != format!("{id}.{suffix}") {
            return Err(Unavailable::Untrusted);
        }
        if slots.len() == LIMIT && !slots.contains_key(&id) {
            return Err(Unavailable::Capacity);
        }
        let slot = slots.entry(id).or_default();
        let (file, bytes) = read_leaf(&item.path(), MAX_LINE)?;
        match suffix {
            "json" => slot.intent = Some((file, parse_intent(&bytes, id)?)),
            _ => slot.terminal = Some((file, parse_terminal(&bytes, id)?)),
        }
    }
    if slots.values().any(|slot| slot.intent.is_none()) {
        return Err(Unavailable::Untrusted);
    }
    Ok(slots)
}

pub fn read(root: &Path) -> Result<Vec<Item>> {
    let store = Store::open(root, DIRECTORY, false)?;
    let mut items = Vec::new();
    for (id, slot) in scan(&store)? {
        let (_, intent) = slot.intent.ok_or(Unavailable::Untrusted)?;
        let terminal = slot.terminal.map(|(_, terminal)| terminal);
        items.push(Item {
            save_id: id,
            name: intent.name,
            at_ms: terminal.as_ref().map_or(intent.at_ms, |t| t.at_ms),
            phase: terminal.map_or(Phase::Unknown, |t| t.phase),
        });
    }
    items.sort_by_key(|item| std::cmp::Reverse((item.at_ms, item.save_id)));
    Ok(items)
}

pub(crate) fn begin(
    root: &Path,
    id: Uuid,
    name: &str,
    parent: Object,
    original: Object,
    staging: Object,
) -> Result<Intent> {
    let intent = Intent {
        version: 1,
        save_id: id,
        at_ms: clock(),
        name: display_name(name),
        parent,
        original,
        staging,
    };
    let bytes = encode(&intent)?;
    parse_intent(&bytes, id)?;
    let store = Store::open(root, DIRECTORY, true)?;
    let mut slots = scan(&store)?;
    if slots.contains_key(&id) {
        return Err(Unavailable::Conflict);
    }
    if slots.len() == LIMIT {
        let oldest = slots
            .iter()
            .filter_map(|(id, slot)| {
                let (_, intent) = slot.intent.as_ref()?;
                let (_, terminal) = slot.terminal.as_ref()?;
                matches!(terminal.phase, Phase::Published | Phase::NotPublished)
                    .then_some((intent.at_ms, *id))
            })
            .min()
            .ok_or(Unavailable::Capacity)?
            .1;
        let slot = slots.remove(&oldest).ok_or(Unavailable::Conflict)?;
        let (terminal, _) = slot.terminal.ok_or(Unavailable::Conflict)?;
        // Retire terminal first. If interrupted, the surviving intent stays unknown.
        crate::selected_save::remove_owned(&terminal).map_err(io)?;
        drop(terminal);
        let (file, _) = slot.intent.ok_or(Unavailable::Conflict)?;
        crate::selected_save::remove_owned(&file).map_err(io)?;
    }
    publish_file(&store, id, &bytes, |_| {})?;
    Ok(intent)
}

pub(crate) fn finish(root: &Path, intent: &Intent, phase: Phase) -> Result<()> {
    let terminal = encode(&Terminal {
        version: 1,
        save_id: intent.save_id,
        at_ms: clock(),
        phase,
    })?;
    let id = intent.save_id;
    parse_terminal(&terminal, id)?;
    let store = Store::open(root, DIRECTORY, false)?;
    let slots = scan(&store)?;
    let slot = slots.get(&id).ok_or(Unavailable::Conflict)?;
    let (_, prior) = slot.intent.as_ref().ok_or(Unavailable::Conflict)?;
    if prior != intent || slot.terminal.is_some() {
        return Err(Unavailable::Conflict);
    }
    publish_leaf(
        &store,
        &format!("{id}.done.pending"),
        &format!("{id}.done"),
        &terminal,
        |_| {},
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "shared-terminal-save-recovery-store-中文-{}",
                Uuid::new_v4()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let root = self.0.canonicalize().unwrap();
            assert_eq!(
                root.parent(),
                Some(std::env::temp_dir().canonicalize().unwrap().as_path())
            );
            assert!(
                root.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("shared-terminal-save-recovery-store-中文-")
            );
            fs::remove_dir_all(root).unwrap();
        }
    }
    fn intent(root: &Path) -> Intent {
        begin(
            root,
            Uuid::new_v4(),
            "测试\u{202e}.txt",
            (1, 0, 1),
            (1, 0, 2),
            (1, 0, 3),
        )
        .unwrap()
    }

    #[test]
    fn save_recovery_store_bounds_pending_and_only_retires_settled_metadata() {
        let root = Temp::new();
        let records: Vec<_> = (0..LIMIT).map(|_| intent(&root.0)).collect();
        finish(&root.0, &records[0], Phase::Preserve).unwrap();
        let new = Uuid::new_v4();
        assert_eq!(
            begin(&root.0, new, "new.txt", (1, 0, 1), (1, 0, 2), (1, 0, 3)),
            Err(Unavailable::Capacity)
        );
        finish(&root.0, &records[1], Phase::Published).unwrap();
        let replacement = intent(&root.0);
        let observed = read(&root.0).unwrap();
        assert_eq!(observed.len(), LIMIT);
        assert!(
            observed
                .iter()
                .any(|item| item.save_id == records[0].save_id && item.phase == Phase::Preserve)
        );
        assert!(
            !observed
                .iter()
                .any(|item| item.save_id == records[1].save_id)
        );
        assert!(
            observed
                .iter()
                .any(|item| item.save_id == replacement.save_id && item.phase == Phase::Unknown)
        );
        assert!(observed.iter().all(|item| item.name == "测试⟦U+202E⟧.txt"));
        assert!(
            !root
                .0
                .join(DIRECTORY)
                .join(format!("{}.done", records[1].save_id))
                .exists()
        );
    }

    #[test]
    fn save_recovery_store_exclusive_lock_and_bad_pending_fail_closed() {
        let root = Temp::new();
        let i = intent(&root.0);
        let store = Store::open(&root.0, DIRECTORY, false).unwrap();
        assert!(matches!(read(&root.0), Err(Unavailable::Busy)));
        assert_eq!(
            finish(&root.0, &i, Phase::Published),
            Err(Unavailable::Busy)
        );
        drop(store);
        let pending = root
            .0
            .join(DIRECTORY)
            .join(format!("{}.done.pending", i.save_id));
        fs::write(&pending, b"{incomplete").unwrap();
        assert_eq!(
            finish(&root.0, &i, Phase::Published),
            Err(Unavailable::Untrusted)
        );
        assert!(matches!(read(&root.0), Err(Unavailable::Untrusted)));
        assert_eq!(fs::read(pending).unwrap(), b"{incomplete");
    }

    #[test]
    fn save_recovery_store_rejects_future_record_and_hard_link() {
        let root = Temp::new();
        let i = intent(&root.0);
        let file = root.0.join(DIRECTORY).join(format!("{}.json", i.save_id));
        let outside = root.0.join("outside");
        fs::hard_link(&file, &outside).unwrap();
        assert!(matches!(read(&root.0), Err(Unavailable::Untrusted)));
        fs::remove_file(outside).unwrap();
        let future = br#"{"version":2,"unsupported":"synthetic"}"#;
        fs::write(&file, future).unwrap();
        assert!(matches!(read(&root.0), Err(Unavailable::Unsupported)));
        assert_eq!(fs::read(file).unwrap(), future);
    }
}
