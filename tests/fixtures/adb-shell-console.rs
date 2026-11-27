use std::{
    fs::File,
    io::{self, Write},
    thread,
    time::{Duration, Instant},
};

#[repr(C)]
struct Event {
    kind: u16,
    padding: u16,
    down: i32,
    repeat: u16,
    key: u16,
    scan: u16,
    character: u16,
    state: u32,
}
#[repr(C)]
struct Point {
    x: i16,
    y: i16,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetStdHandle(kind: u32) -> *mut core::ffi::c_void;
    fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
    fn SetConsoleMode(handle: *mut core::ffi::c_void, mode: u32) -> i32;
    fn GetNumberOfConsoleInputEvents(handle: *mut core::ffi::c_void, count: *mut u32) -> i32;
    fn ReadConsoleInputW(
        handle: *mut core::ffi::c_void,
        events: *mut Event,
        length: u32,
        read: *mut u32,
    ) -> i32;
    fn SetConsoleCursorPosition(handle: *mut core::ffi::c_void, point: Point) -> i32;
}

pub fn run(calls: &mut File) -> io::Result<()> {
    let input = unsafe { GetStdHandle((-10i32) as u32) };
    let mut mode = 0;
    if unsafe { GetConsoleMode(input, &mut mode) } == 0
        || unsafe { SetConsoleMode(input, mode & !7) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let identity = std::process::id();
    writeln!(calls, "proof-instance|{identity}")?;
    let prompt = || -> io::Result<()> {
        write!(io::stdout(), "proof:/ # ")?;
        io::stdout().flush()
    };
    prompt()?;
    let mut draft = String::new();
    let mut child = None;
    loop {
        if child.is_some_and(|started: Instant| started.elapsed() > Duration::from_secs(20)) {
            println!("OWNED_SLEEP_FINISHED");
            child = None;
            prompt()?;
        }
        let mut count = 0;
        if unsafe { GetNumberOfConsoleInputEvents(input, &mut count) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if count == 0 {
            thread::sleep(Duration::from_millis(10));
            continue;
        }
        let mut event = std::mem::MaybeUninit::<Event>::uninit();
        let mut read = 0;
        if unsafe { ReadConsoleInputW(input, event.as_mut_ptr(), 1, &mut read) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if read != 1 {
            continue;
        }
        let event = unsafe { event.assume_init() };
        if event.kind != 1 || event.down == 0 || event.character == 0 {
            continue;
        }
        for _ in 0..event.repeat.max(1) {
            writeln!(calls, "proof-unit|{:02x}", event.character)?;
            match char::from_u32(event.character.into()) {
                Some('\x03') => {
                    println!("^C");
                    if child.take().is_some() {
                        println!("OWNED_SLEEP_INTERRUPTED");
                    }
                    draft.clear();
                    prompt()?;
                }
                Some('\r' | '\n') if child.is_none() => {
                    println!();
                    writeln!(calls, "proof-line|{draft}")?;
                    match draft.as_str() {
                        "echo FIRST" => println!("RESULT_FIRST"),
                        "echo SECOND" => println!("RESULT_SECOND"),
                        "identity" => println!("IDENTITY_{identity}"),
                        "redraw" => {
                            let output = unsafe { GetStdHandle((-11i32) as u32) };
                            if unsafe { SetConsoleCursorPosition(output, Point { x: 0, y: 0 }) }
                                == 0
                            {
                                return Err(io::Error::last_os_error());
                            }
                            println!("OWNED_PTY_REDRAW");
                        }
                        "sleep 20" => {
                            child = Some(Instant::now());
                            println!("OWNED_SLEEP_STARTED");
                        }
                        "exit" => return Ok(()),
                        "disconnect" => {
                            println!("fixture: original transport disconnected");
                            std::process::exit(255);
                        }
                        "" => {}
                        _ => println!("UNEXPECTED_INPUT"),
                    }
                    draft.clear();
                    if child.is_none() {
                        prompt()?;
                    }
                }
                Some(character) if child.is_none() => {
                    draft.push(character);
                    print!("{character}");
                    io::stdout().flush()?;
                }
                _ => {}
            }
        }
    }
}
