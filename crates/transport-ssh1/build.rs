use std::{env, path::PathBuf};

fn main() {
    if env::var_os("CARGO_FEATURE_NATIVE_HELPER").is_none() {
        return;
    }
    println!("cargo:rerun-if-env-changed=SSH1_NATIVE_DIR");
    let dir = PathBuf::from(
        env::var_os("SSH1_NATIVE_DIR")
            .expect("build the native helper with scripts/Build-Ssh1Helper.ps1"),
    );
    let build = dir.join("build");
    for file in [
        dir.join("owner.obj"),
        dir.join("no-storage.obj"),
        build.join("CMakeFiles/plink-be-list.dir/be_list.c.obj"),
        build.join("CMakeFiles/plink.dir/stubs/no-lineedit.c.obj"),
        build.join("CMakeFiles/plink.dir/windows/no-jump-list.c.obj"),
        build.join("CMakeFiles/plink.dir/windows/nohelp.c.obj"),
        build.join("eventloop.lib"),
        build.join("noterminal.lib"),
        build.join("console.lib"),
        build.join("ssh/sshclient.lib"),
        build.join("otherbackends.lib"),
        build.join("settings.lib"),
        build.join("network.lib"),
        build.join("crypto.lib"),
        build.join("utils.lib"),
    ] {
        assert!(
            file.is_file(),
            "missing native build artifact: {}",
            file.display()
        );
        println!("cargo:rerun-if-changed={}", file.display());
        println!("cargo:rustc-link-arg-bin=ssh1-helper={}", file.display());
    }
    for lib in [
        "advapi32", "comdlg32", "gdi32", "imm32", "ole32", "shell32", "user32", "ws2_32",
    ] {
        println!("cargo:rustc-link-arg-bin=ssh1-helper={lib}.lib");
    }
    println!(
        "cargo:rustc-link-arg-bin=ssh1-helper=/MAP:{}",
        dir.join("ssh1-helper.map").display()
    );
}
