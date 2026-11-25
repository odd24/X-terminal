fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let script = "../../../scripts/Build-PsReadLineCompatibility.ps1";
        println!("cargo:rerun-if-changed={script}");
        println!("cargo:rerun-if-changed=../../../vendor/psreadline/PSReadLine-2.0.0.tar.gz");
        println!("cargo:rerun-if-changed=../../../vendor/psreadline/LICENSE.txt");
        let status = std::process::Command::new("pwsh")
            .args(["-NoProfile", "-File", script, "-OutputDirectory"])
            .arg(std::env::var_os("OUT_DIR").expect("build output directory"))
            .status()
            .expect("start the Windows PSReadLine build");
        assert!(
            status.success(),
            "build the Windows PSReadLine compatibility module"
        );
    }
    tauri_build::build();
}
