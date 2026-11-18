#[cfg(all(windows, target_arch = "x86_64", target_env = "msvc"))]
mod windows;

#[cfg(all(windows, target_arch = "x86_64", target_env = "msvc"))]
fn main() -> std::process::ExitCode {
    windows::run()
}

#[cfg(not(all(windows, target_arch = "x86_64", target_env = "msvc")))]
compile_error!("The PuTTY helper requires Windows x64 MSVC");
