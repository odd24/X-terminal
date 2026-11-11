//! Twenty independent synthetic loopback SSH sources, no OS shell or device.
#[allow(dead_code)]
#[path = "../tests/support/ssh_fixture.rs"]
mod fixture;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{SyncSender, sync_channel},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, BufReader};

const STREAMS: usize = 20;
const HZ: u64 = 21;
fn block(stream: usize, seq: u64) -> Vec<u8> {
    let mut b = vec![b'a' + ((stream as u64 + seq) % 26) as u8; 1024];
    let header = format!("T18|{stream:02}|{seq:08}|");
    b[..header.len()].copy_from_slice(header.as_bytes());
    b[1023] = b'\n';
    b
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[repr(C)]
#[derive(Default)]
struct Memory {
    cb: u32,
    faults: u32,
    peak_working: usize,
    working: usize,
    peak_paged: usize,
    paged: usize,
    peak_nonpaged: usize,
    nonpaged: usize,
    pagefile: usize,
    peak_pagefile: usize,
    private: usize,
}
#[link(name = "psapi")]
unsafe extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut std::ffi::c_void,
        counters: *mut Memory,
        size: u32,
    ) -> i32;
}
fn resources(pid: u32) -> std::io::Result<Value> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
        },
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let size = std::mem::size_of::<Memory>() as u32;
    let mut m = Memory {
        cb: size,
        ..Default::default()
    };
    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    let memory_ok = unsafe { GetProcessMemoryInfo(handle, &mut m, size) };
    let cpu_ok =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe {
        CloseHandle(handle);
    }
    if memory_ok == 0 || cpu_ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    Ok(
        json!({"pid":pid,"private":m.private,"working":m.working,"peak_working":m.peak_working,"cpu_s":(ticks(kernel)+ticks(user)) as f64/10_000_000.0}),
    )
}
fn notify(tx: &SyncSender<Value>, value: Value, failed: &AtomicBool) {
    if tx.try_send(value).is_err() {
        failed.store(true, Ordering::SeqCst);
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (tx, rx) = sync_channel::<Value>(64);
    let notification_failed = Arc::new(AtomicBool::new(false));
    let writer = std::thread::spawn(move || {
        let mut out = std::io::stdout().lock();
        for value in rx {
            serde_json::to_writer(&mut out, &value).unwrap();
            writeln!(out).unwrap();
            out.flush().unwrap();
        }
    });
    let mut all = vec![];
    for _ in 0..STREAMS {
        let f = fixture::Fixture::start().await;
        f.silent_input.store(true, Ordering::SeqCst);
        all.push(Arc::new(f));
    }
    let sources = Arc::new(all);
    tx.send(json!({"event":"ready","servers":sources.iter().map(|f|json!({"port":f.port,"pin":f.pin,"password":*f.password})).collect::<Vec<_>>(),"streams":STREAMS}))?;
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = {
        let sources = sources.clone();
        let tx = tx.clone();
        let failed = notification_failed.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut seen = [0usize; STREAMS];
            let mut tick = tokio::time::interval(Duration::from_millis(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            while !stop.load(Ordering::SeqCst) {
                tick.tick().await;
                for (index, f) in sources.iter().enumerate() {
                    let added = {
                        let bytes = f.received.lock().unwrap();
                        let times = f.received_at.lock().unwrap();
                        let added=(seen[index]..bytes.len()).map(|n|json!({"event":"input","stream":index,"ordinal":n,"bytes":bytes[n],"received_at_us":times[n]})).collect::<Vec<_>>();
                        seen[index] = bytes.len();
                        added
                    };
                    for event in added {
                        notify(&tx, event, &failed);
                    }
                }
            }
        })
    };
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let mut generation = vec![];
    let mut started = false;
    while let Some(line) = stdin.next_line().await? {
        let value: Value = serde_json::from_str(&line)?;
        let id = value["id"].clone();
        match value["op"].as_str().unwrap_or("") {
            "start"=>{
                assert!(!started);started=true;let seconds=value["seconds"].as_u64().unwrap();assert!(matches!(seconds,8|25|120|28800));
                let sparse=matches!(seconds,25|28800);
                let frames=if sparse {seconds.div_ceil(10)} else {seconds*HZ};
                let base_start=Instant::now()+Duration::from_millis(250);let clock=tokio::time::Instant::from_std(base_start);let unix_ms=SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()+250;
                for index in 0..STREAMS {let f=sources[index].clone();let tx=tx.clone();let failed=notification_failed.clone();let stop=stop.clone();generation.push(tokio::spawn(async move{
                    tokio::time::sleep_until(clock).await;let start=base_start;let mut count=0;let mut hash=Sha256::new();let mut max_late=0f64;let mut error=None;let mut max_clock_drift=0f64;
                    for n in 0..frames {let due=if sparse {Duration::from_secs(n*10)} else {Duration::from_nanos(n*1_000_000_000/HZ)};tokio::time::sleep_until(clock+due).await;
                        let late=start.elapsed().saturating_sub(due).as_secs_f64();max_late=max_late.max(late);let wall=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as f64-unix_ms as f64;max_clock_drift=max_clock_drift.max((wall-start.elapsed().as_secs_f64()*1000.0).abs());
                        if stop.load(Ordering::SeqCst)||late>0.250||start.elapsed()>=Duration::from_secs(seconds){error=Some("source deadline/stop" );break;}
                        let bytes=block(index,n);
                        if sparse {
                            if tokio::time::timeout(Duration::from_secs(2),f.push(&bytes)).await.is_err(){error=Some("source push deadline");break;}
                        }else{f.push(&bytes).await;}
                        hash.update(&bytes);count+=1;
                    }
                    if !sparse || error.is_none(){tokio::time::sleep_until(clock+Duration::from_secs(seconds)).await;}
                    notify(&tx,json!({"event":"source_done","stream":index,"frames":count,"bytes":count*1024,"sha256":hex(hash.finalize().as_slice()),"elapsed_s":start.elapsed().as_secs_f64(),"max_late_s":max_late,"error":error,"start_unix_ms":unix_ms,"max_wall_mono_drift_ms":max_clock_drift}),&failed);
                }));}
                let mut response=json!({"id":id,"result":"started","seconds":seconds,"start_unix_ms":unix_ms,"block_bytes":1024});
                if sparse {response["interval_seconds"]=json!(10);}else{response["hz"]=json!(HZ);}
                tx.send(response)?;
            }
            "metrics"=>tx.send(json!({"id":id,"result":"metrics","notification_failed":notification_failed.load(Ordering::SeqCst),"received":sources.iter().map(|f|f.received.lock().unwrap().concat()).collect::<Vec<_>>()}))?,
            "resources"=>{let pids=value["pids"].as_array().unwrap();assert!(pids.len()<=2);let ids=pids.iter().map(|p|p.as_u64().unwrap() as u32).chain(Some(std::process::id()));let samples=ids.map(resources).collect::<std::io::Result<Vec<_>>>()?;tx.send(json!({"id":id,"result":"resources","samples":samples}))?;}
            "stop"=>{tx.send(json!({"id":id,"result":"stopping"}))?;break;}
            _=>panic!("unknown synthetic load fixture command"),
        }
    }
    stop.store(true, Ordering::SeqCst);
    for task in generation {
        task.abort();
        let _ = task.await;
    }
    watcher.await?;
    drop(sources);
    drop(tx);
    writer.join().unwrap();
    Ok(())
}
