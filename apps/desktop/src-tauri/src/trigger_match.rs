//! Desktop-only bounded matcher workers. They cannot read sessions or send input.
use serde::{Deserialize, Serialize};
use session_core::trigger::{Hit, Kind, Matcher};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::State;
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Compile {
        id: Uuid,
        kind: Kind,
        pattern: String,
    },
    Reset {
        id: Uuid,
        next_seq: u64,
    },
    Feed {
        id: Uuid,
        seq: u64,
        text: String,
        broken: bool,
        finished: bool,
    },
    Close {
        id: Uuid,
    },
}
#[derive(Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum Reply {
    Compiled { span: usize },
    Reset,
    Hits { hits: Vec<Hit> },
    Closed,
}
pub struct Manager {
    values: Arc<Mutex<HashMap<Uuid, Matcher>>>,
    slots: Arc<Semaphore>,
}
impl Default for Manager {
    fn default() -> Self {
        Self {
            values: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}
impl Manager {
    async fn request(&self, request: Request) -> Result<Reply, String> {
        // No queued compilation/search jobs: reject before spawning when both workers are busy.
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "TRIGGER_BUSY".to_string())?;
        let values = self.values.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let mut values = values
                .lock()
                .map_err(|_| "TRIGGER_UNAVAILABLE".to_string())?;
            let error = |e: session_core::trigger::Error| format!("TRIGGER_{e:?}");
            match request {
                Request::Compile { id, kind, pattern } => {
                    if id.is_nil() || values.contains_key(&id) || values.len() >= 4 {
                        return Err("TRIGGER_CAPACITY_OR_ID".into());
                    }
                    let matcher = Matcher::new(kind, &pattern, 1).map_err(error)?;
                    let span = matcher.span();
                    values.insert(id, matcher);
                    Ok(Reply::Compiled { span })
                }
                Request::Reset { id, next_seq } => {
                    values
                        .get_mut(&id)
                        .ok_or("TRIGGER_NOT_FOUND")?
                        .reset(next_seq)
                        .map_err(error)?;
                    Ok(Reply::Reset)
                }
                Request::Feed {
                    id,
                    seq,
                    text,
                    broken,
                    finished,
                } => {
                    let hits = values
                        .get_mut(&id)
                        .ok_or("TRIGGER_NOT_FOUND")?
                        .push(seq, &text, broken, finished)
                        .map_err(error)?;
                    Ok(Reply::Hits { hits })
                }
                Request::Close { id } => {
                    values.remove(&id);
                    Ok(Reply::Closed)
                }
            }
        })
        .await
        .map_err(|_| "TRIGGER_UNAVAILABLE".to_string())?
    }
}
#[tauri::command]
pub async fn trigger_match_request(
    state: State<'_, Manager>,
    request: Request,
) -> Result<Reply, String> {
    state.request(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn slot_cap_id_unknown_close_and_strict_requests() {
        let manager = Manager::default();
        let mut ids = Vec::new();
        for _ in 0..4 {
            let id = Uuid::new_v4();
            manager
                .request(Request::Compile {
                    id,
                    kind: Kind::Literal,
                    pattern: "ERROR".into(),
                })
                .await
                .unwrap();
            ids.push(id);
        }
        assert!(
            manager
                .request(Request::Compile {
                    id: Uuid::new_v4(),
                    kind: Kind::Literal,
                    pattern: "x".into()
                })
                .await
                .is_err()
        );
        assert!(
            manager
                .request(Request::Compile {
                    id: ids[0],
                    kind: Kind::Literal,
                    pattern: "changed".into()
                })
                .await
                .is_err()
        );
        manager
            .request(Request::Reset {
                id: ids[0],
                next_seq: 7,
            })
            .await
            .unwrap();
        let reply = manager
            .request(Request::Feed {
                id: ids[0],
                seq: 7,
                text: "ERROR".into(),
                broken: false,
                finished: false,
            })
            .await
            .unwrap();
        assert!(matches!(reply,Reply::Hits {hits} if hits.len()==1));
        for id in ids {
            manager.request(Request::Close { id }).await.unwrap();
        }
        manager
            .request(Request::Close { id: Uuid::new_v4() })
            .await
            .unwrap();
        assert!(manager.values.lock().unwrap().is_empty());
        assert!(
            serde_json::from_value::<Request>(
                serde_json::json!({"op":"close","id":Uuid::new_v4(),"send":true})
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn worker_admission_has_no_wait_queue() {
        let manager = Manager::default();
        let _first = manager.slots.clone().try_acquire_owned().unwrap();
        let _second = manager.slots.clone().try_acquire_owned().unwrap();
        assert_eq!(
            manager
                .request(Request::Close { id: Uuid::new_v4() })
                .await
                .err()
                .as_deref(),
            Some("TRIGGER_BUSY")
        );
    }
}
