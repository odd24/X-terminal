use super::*;
impl Entry {
    pub(super) fn poll(&mut self, store: &mut Store) {
        let completed: Vec<_> = self
            .tickets
            .iter()
            .filter_map(|(id, ticket)| match ticket.poll() {
                Ok(None) => None,
                result => Some((*id, result)),
            })
            .collect();
        for (id, result) in completed {
            self.tickets.remove(&id);
            let receipt = &mut self.inputs.get_mut(&id).unwrap().receipt;
            match result {
                Ok(Some(worker::Outcome::Written {
                    driver_accepted,
                    complete,
                    error,
                    cancelled,
                })) => {
                    receipt.driver_accepted = Some(driver_accepted);
                    receipt.state = if complete {
                        InputState::DriverAccepted
                    } else {
                        InputState::Unknown
                    };
                    receipt.failure = if cancelled {
                        Some(Failure::Cancelled)
                    } else {
                        error.map(failure)
                    };
                }
                Ok(Some(worker::Outcome::Controlled)) => receipt.state = InputState::ControlApplied,
                Ok(Some(worker::Outcome::ControlFailed(error))) => {
                    receipt.state = InputState::Unknown;
                    receipt.failure = Some(failure(error));
                }
                Ok(Some(worker::Outcome::CancelledBeforeDispatch)) => {
                    receipt.state = InputState::CancelledBeforeDispatch;
                    receipt.failure = Some(Failure::Cancelled);
                }
                _ => {
                    receipt.state = InputState::Unknown;
                    receipt.failure = Some(Failure::WorkerFailed);
                }
            }
        }
        if let Some(worker) = &mut self.worker {
            self.status = worker.status();
            if let Ok(info) = store.sessions.info(self.reference) {
                if matches!(self.status.phase, worker::Phase::Ready)
                    && info.state == State::Connecting
                    && !self.closing
                {
                    let _ = store.sessions.transition(self.reference, State::Connected);
                }
                if (self.closing || matches!(self.status.phase, worker::Phase::Ended(_)))
                    && !matches!(
                        info.state,
                        State::Closing | State::Disconnected | State::Failed
                    )
                {
                    let _ = store.sessions.transition(self.reference, State::Closing);
                }
            }
            let mut drained = false;
            for _ in 0..32 {
                let result = match worker.read_output() {
                    worker::Output::Data { bytes, .. } => {
                        store
                            .sessions
                            .append_draining(self.reference, &bytes, timestamp())
                    }
                    worker::Output::Gap { from, to } => {
                        store
                            .sessions
                            .mark_gap(self.reference, to - from, timestamp())
                    }
                    worker::Output::Idle => break,
                    worker::Output::Closed(_) => {
                        drained = true;
                        break;
                    }
                };
                if result.is_err() {
                    self.failure = Some(Failure::CounterExhausted);
                    worker.cancel();
                    break;
                }
            }
            if drained && worker.is_finished() {
                let mut worker = self.worker.take().unwrap();
                let (sender, receiver) = mpsc::sync_channel(1);
                self.joining = Some(receiver);
                tokio::task::spawn_blocking(move || {
                    let _ = sender.send(worker.join().map_err(|_| Failure::WorkerFailed));
                });
            }
        }
        if let Some(joining) = &self.joining {
            let result = match joining.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Disconnected) => Some(Err(Failure::WorkerFailed)),
                Err(mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                self.joining = None;
                self.joined = true;
                match result {
                    Ok(status) => {
                        self.status = status;
                        if self.failure.is_none() {
                            self.failure = match status.phase {
                                worker::Phase::Ended(worker::End::Cancelled) if self.closing => {
                                    None
                                }
                                worker::Phase::Ended(worker::End::Cancelled) => {
                                    Some(Failure::Cancelled)
                                }
                                worker::Phase::Ended(
                                    worker::End::OpenFailed(error)
                                    | worker::End::ReadFailed(error)
                                    | worker::End::WriteFailed(error),
                                ) => Some(failure(error)),
                                worker::Phase::Ended(worker::End::CounterExhausted) => {
                                    Some(Failure::CounterExhausted)
                                }
                                _ => Some(Failure::WorkerFailed),
                            };
                        }
                    }
                    Err(error) => self.failure = Some(error),
                }
                let target = if self.closing {
                    State::Disconnected
                } else {
                    State::Failed
                };
                let _ = store.sessions.transition(self.reference, target);
            }
        }
    }
}
