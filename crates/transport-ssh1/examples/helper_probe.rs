#[cfg(windows)]
mod windows;

#[cfg(windows)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    windows::run().await
}

#[cfg(not(windows))]
fn main() {}
