use std::{env, fs, io::{self, Write}, thread, time::Duration};

fn main() -> io::Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let index = args.iter().position(|arg|
        ["devices", "pull", "shell", "logcat"].contains(&arg.as_str())).unwrap_or(args.len());
    let operation = args.get(index).map(String::as_str).unwrap_or("");
    let target = args.windows(2).find(|pair| pair[0] == "-s").map(|pair| pair[1].clone())
        .or_else(|| env::var("ANDROID_SERIAL").ok()).unwrap_or_default();
    let mut events = fs::OpenOptions::new().create(true).append(true).open("adb-calls.txt")?;
    writeln!(events, "{}|{}|{}", operation, target, args.join("|"))?;
    match operation {
        "devices" => {
            println!("List of devices attached");
            print!("{}", fs::read_to_string("inventory.txt").unwrap_or_default());
        }
        "pull" => {
            let devices = fs::read_to_string("inventory.txt").unwrap_or_default();
            if !devices.lines().any(|line| line.starts_with(&format!("{target}\tdevice"))) {
                eprintln!("ADB_FIXTURE_TARGET_GONE");
                std::process::exit(1);
            }
            let destination = args.get(index + 2).expect("missing fixture destination");
            fs::write(destination, b"observed fixture download")?;
            println!("ADB_FIXTURE_PULLED");
        }
        "shell" | "logcat" => {
            println!("ADB_FIXTURE_FOREGROUND:{}", std::process::id());
            io::stdout().flush()?;
            if operation == "shell" {
                let mut input = String::new();
                while io::stdin().read_line(&mut input)? != 0 {
                    println!("ADB_FIXTURE_ECHO:{}", input.trim_end());
                    io::stdout().flush()?;
                    input.clear();
                }
                return Ok(());
            }
            loop { thread::sleep(Duration::from_millis(100)); }
        }
        _ => {
            println!("ADB_FIXTURE_UNKNOWN");
        }
    }
    Ok(())
}
