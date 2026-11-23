use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    thread,
    time::Duration,
};

fn main() -> io::Result<()> {
    let root = PathBuf::from(env::var_os("SHORTCUT_FIXTURE_ROOT").expect("owned fixture root"));
    assert!(root.join("fixture-root.txt").is_file());
    let image = env::current_exe()?;
    let mode = fs::read_to_string(root.join("mode.txt")).unwrap_or_default();
    let mut args: Vec<_> = env::args().skip(1).collect();
    let name = image.file_stem().unwrap().to_str().unwrap();
    let mut calls = fs::OpenOptions::new().create(true).append(true).open(root.join("calls.txt"))?;
    writeln!(calls, "{name}|{}", args.join("|"))?;
    match name {
        "adb" => {
            if args == ["devices","-l"] {
                println!("List of devices attached\nfixed       device product:test");
                return Ok(());
            }
            assert_eq!(args[..2], ["-s","fixed"]);
            args.drain(..2);
            match args[0].as_str() {
                "root" if mode=="deny" => println!("adbd cannot run as root in production builds"),
                "root" => println!("restarting adbd as root"),
                "wait-for-device" if mode=="timeout" || mode=="cancel-wait" => thread::sleep(Duration::from_secs(90)),
                "wait-for-device" => thread::sleep(Duration::from_millis(220)),
                "shell" => {
                    assert_eq!(args,["shell","dmesg -w"]);
                    println!("cold boot\npower signal");
                    io::stdout().flush()?;
                    if mode=="interactive" {
                        for line in io::stdin().lock().lines() {
                            let line=line?;
                            println!("power input {line}");
                            io::stdout().flush()?;
                        }
                    }
                }
                other => panic!("unknown fixture ADB operation {other}"),
            }
        }
        "grep" => {
            assert_eq!(args,["power"]);
            for line in io::stdin().lock().lines() {
                let line=line?;
                if line.contains("power") {
                    println!("LOCAL_GREP:{line}");
                    io::stdout().flush()?;
                }
            }
        }
        "probe" => match args[0].as_str() {
            "tail" => println!("TAIL_SHOULD_RUN"),
            "fail" => std::process::exit(7),
            "delay" => {
                println!("WAITING_FOR_RELEASE");
                io::stdout().flush()?;
                while !root.join("release").exists(){thread::sleep(Duration::from_millis(20));}
                println!("released");
            }
            _=>panic!("invalid fixture probe"),
        },
        _=>panic!("invalid fixture program"),
    }
    Ok(())
}
