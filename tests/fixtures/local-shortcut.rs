use std::{
    env, fs,
    io::{self, BufRead, IsTerminal, Write},
    path::PathBuf,
    thread,
    time::Duration,
};

#[repr(C)]
struct Coord {
    x: i16,
    y: i16,
}
#[repr(C)]
struct Rect {
    left: i16,
    top: i16,
    right: i16,
    bottom: i16,
}
#[repr(C)]
struct ScreenInfo {
    size: Coord,
    cursor: Coord,
    attributes: u16,
    window: Rect,
    maximum: Coord,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetStdHandle(kind: u32) -> *mut core::ffi::c_void;
    fn GetConsoleScreenBufferInfo(handle: *mut core::ffi::c_void, info: *mut ScreenInfo) -> i32;
}
fn size() -> io::Result<Coord> {
    let mut info = std::mem::MaybeUninit::uninit();
    if unsafe { GetConsoleScreenBufferInfo(GetStdHandle((-11i32) as u32), info.as_mut_ptr()) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { info.assume_init() }.size)
}

fn bare_shell(calls: &mut fs::File) -> io::Result<()> {
    let terminal = io::stdin().is_terminal() && io::stdout().is_terminal();
    writeln!(calls, "bare-shell-terminal|{terminal}")?;
    if terminal {
        print!("fixture:/ # ");
        io::stdout().flush()?;
    }
    for line in io::stdin().lock().lines() {
        let line = line?;
        writeln!(calls, "bare-shell-input|{line}")?;
        match line.as_str() {
            "pwd" => println!("/fixture-read-only"),
            "size" if terminal => {
                let dimensions = size()?;
                println!("FIXTURE_SIZE:{}x{}", dimensions.x, dimensions.y);
            }
            "exit" => return Ok(()),
            "exit 7" => std::process::exit(7),
            _ => println!("FIXTURE_BAD_COMMAND"),
        }
        if terminal {
            print!("fixture:/ # ");
            io::stdout().flush()?;
        }
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let root = PathBuf::from(env::var_os("SHORTCUT_FIXTURE_ROOT").expect("owned fixture root"));
    assert!(root.join("fixture-root.txt").is_file());
    let image = env::current_exe()?;
    let mode = fs::read_to_string(root.join("mode.txt")).unwrap_or_default();
    let mut args: Vec<_> = env::args().skip(1).collect();
    let name = image.file_stem().unwrap().to_str().unwrap();
    let mut calls = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("calls.txt"))?;
    writeln!(calls, "{name}|{}", args.join("|"))?;
    match name {
        "adb" => {
            if args == ["devices", "-l"] {
                println!("List of devices attached\nfixed       device product:test");
                return Ok(());
            }
            assert_eq!(args[..2], ["-s", "fixed"]);
            args.drain(..2);
            match args[0].as_str() {
                "root" if mode == "deny" => {
                    println!("adbd cannot run as root in production builds")
                }
                "root" if mode == "already-root" => println!("adbd is already running as root"),
                "root" => println!("restarting adbd as root"),
                "wait-for-device" if mode == "timeout" || mode == "cancel-wait" => {
                    thread::sleep(Duration::from_secs(90))
                }
                "wait-for-device" => thread::sleep(Duration::from_millis(220)),
                "get-state" => println!("device"),
                "shell" if args == ["shell"] => return bare_shell(&mut calls),
                "shell" => {
                    assert_eq!(args, ["shell", "dmesg -w"]);
                    assert!(!io::stdin().is_terminal() && !io::stdout().is_terminal());
                    println!("cold boot\npower signal");
                    io::stdout().flush()?;
                    if mode == "interactive" {
                        for line in io::stdin().lock().lines() {
                            let line = line?;
                            println!("power input {line}");
                            io::stdout().flush()?;
                        }
                    }
                }
                other => panic!("unknown fixture ADB operation {other}"),
            }
        }
        "grep" => {
            assert_eq!(args, ["power"]);
            for line in io::stdin().lock().lines() {
                let line = line?;
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
                while !root.join("release").exists() {
                    thread::sleep(Duration::from_millis(20));
                }
                println!("released");
            }
            _ => panic!("invalid fixture probe"),
        },
        _ => panic!("invalid fixture program"),
    }
    Ok(())
}
