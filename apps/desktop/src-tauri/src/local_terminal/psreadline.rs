use serde::Deserialize;
use std::{
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

const MODULE: &str = "PSReadLine";
const MANIFEST: &str = "PSReadLine.psd1";
const ASSEMBLY: &str = "Microsoft.PowerShell.PSReadLine2.dll";
const DLL: &[u8] = include_bytes!(concat!(
    env!("OUT_DIR"),
    "/Microsoft.PowerShell.PSReadLine2.dll"
));
const MODULE_MANIFEST: &[u8] = br#"@{
    RootModule = 'Microsoft.PowerShell.PSReadLine2.dll'
    ModuleVersion = '2.0.0'
    GUID = '5714753b-2afd-4492-a5fd-01d9e2cff8b5'
    PowerShellVersion = '5.1'
    CmdletsToExport = @('Get-PSReadLineKeyHandler','Set-PSReadLineKeyHandler','Remove-PSReadLineKeyHandler','Get-PSReadLineOption','Set-PSReadLineOption')
}
"#;

// Read the paths constructed by Windows PowerShell itself. An inherited
// PowerShell 7 path can resolve incompatible modules. Only shadow the inbox
// 2.0 copy, leaving earlier user paths and other editor versions alone.
const DISCOVER: &str = r#"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$editor = Get-Module -ListAvailable -Name PSReadLine | Select-Object -First 1
$root = @((Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'), (Join-Path $PSHOME 'Modules')) |
    Where-Object { $editor.Path -ieq (Join-Path $_ 'PSReadLine\2.0.0\PSReadLine.psd1') } | Select-Object -First 1
if ($root -and $editor.Version -eq [Version]'2.0.0') {
    [Console]::Write((@{ paths=$env:PSModulePath; root=$root } | ConvertTo-Json -Compress))
}
"#;

#[derive(Deserialize)]
struct SearchPath {
    paths: String,
    root: PathBuf,
}

pub(super) struct CompatibilityModule {
    directory: PathBuf,
    pub(super) paths: OsString,
    pub(super) original_paths: String,
}

impl CompatibilityModule {
    pub(super) async fn prepare(executable: &Path, root: &Path, task: Uuid) -> Option<Self> {
        let mut command = tokio::process::Command::new(executable);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                DISCOVER,
            ])
            .env_remove("PSModulePath")
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true);
        let discovery = tokio::time::timeout(Duration::from_secs(3), command.output())
            .await
            .ok()?
            .ok()?;
        if !discovery.status.success() {
            return None;
        }
        let search: SearchPath = serde_json::from_slice(&discovery.stdout).ok()?;
        let directory = root.join(format!("psreadline-{}", task.simple()));
        let mut paths: Vec<_> = env::split_paths(&search.paths).collect();
        let index = paths.iter().position(|path| {
            path.to_string_lossy()
                .eq_ignore_ascii_case(&search.root.to_string_lossy())
        })?;
        paths.insert(index, directory.clone());
        let paths = env::join_paths(paths).ok()?;
        fs::create_dir(&directory).ok()?;
        let result = Self {
            directory,
            paths,
            original_paths: search.paths,
        };
        result.write().ok()?;
        Some(result)
    }

    pub(super) fn assembly(&self) -> PathBuf {
        self.directory.join(MODULE).join(ASSEMBLY)
    }

    fn write(&self) -> io::Result<()> {
        let module = self.directory.join(MODULE);
        fs::create_dir(&module)?;
        for (name, content) in [(MANIFEST, MODULE_MANIFEST), (ASSEMBLY, DLL)] {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(module.join(name))?
                .write_all(content)?;
        }
        Ok(())
    }
}

impl Drop for CompatibilityModule {
    fn drop(&mut self) {
        let module = self.directory.join(MODULE);
        let _ = fs::remove_file(module.join(ASSEMBLY));
        let _ = fs::remove_file(module.join(MANIFEST));
        let _ = fs::remove_dir(module);
        let _ = fs::remove_dir(&self.directory);
    }
}
