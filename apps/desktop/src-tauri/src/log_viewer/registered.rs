//! Turn Windows Open With registrations into bounded, verified local images.
use super::{Apartment, executable};
use std::path::Path;
use uuid::Uuid;
use windows::{
    Win32::{
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree},
        UI::Shell::{
            ASSOC_FILTER_NONE, ASSOCF_NONE, ASSOCSTR, ASSOCSTR_EXECUTABLE,
            ASSOCSTR_FRIENDLYAPPNAME, AssocQueryStringW, IAssocHandler, SHAssocEnumHandlers,
        },
    },
    core::{PCWSTR, PWSTR, w},
};
use windows_sys::Win32::{
    Storage::FileSystem::GetBinaryTypeW,
    System::WindowsProgramming::{SCS_32BIT_BINARY, SCS_64BIT_BINARY},
};

pub(super) const UNAVAILABLE: &str = "LOG_VIEWER_CATALOG";
const MAX_HANDLERS_PER_EXTENSION: usize = 128;
const MAX_CANDIDATES: usize = 48;

pub(super) struct Candidate {
    pub id: Uuid,
    pub label: String,
    pub path: String,
}

fn take_string(value: windows::core::Result<PWSTR>) -> Option<String> {
    let value = value.ok()?;
    if value.is_null() {
        return None;
    }
    let text = unsafe { value.to_string() };
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    text.ok()
}

fn association(extension: PCWSTR, kind: ASSOCSTR) -> Option<String> {
    let mut data = vec![0u16; 32768];
    let mut len = data.len() as u32;
    unsafe {
        AssocQueryStringW(
            ASSOCF_NONE,
            kind,
            extension,
            w!("open"),
            Some(PWSTR(data.as_mut_ptr())),
            &mut len,
        )
    }
    .ok()
    .ok()?;
    let text = data.get(..len as usize)?.split(|&c| c == 0).next()?;
    (!text.is_empty())
        .then(|| String::from_utf16(text).ok())
        .flatten()
}

fn add(candidates: &mut Vec<Candidate>, name: Option<String>, image: &str) {
    if candidates.len() >= MAX_CANDIDATES {
        return;
    }
    let Ok((path, _file, _guards)) = executable(Path::new(image)) else {
        return;
    };
    if candidates
        .iter()
        .any(|item| item.path.eq_ignore_ascii_case(&path))
    {
        return;
    }
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut binary = 0;
    if unsafe { GetBinaryTypeW(wide.as_ptr(), &mut binary) } == 0
        || !matches!(binary, SCS_32BIT_BINARY | SCS_64BIT_BINARY)
    {
        return;
    }
    let label: String = name
        .unwrap_or_default()
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(120)
        .collect();
    let label = if label.trim().is_empty() {
        Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Windows 程序")
            .to_owned()
    } else {
        label.trim().to_owned()
    };
    candidates.push(Candidate {
        id: Uuid::new_v4(),
        label,
        path,
    });
}

fn enumerate(extension: PCWSTR, candidates: &mut Vec<Candidate>) -> bool {
    let Ok(list) = (unsafe { SHAssocEnumHandlers(extension, ASSOC_FILTER_NONE) }) else {
        return false;
    };
    for _ in 0..MAX_HANDLERS_PER_EXTENSION {
        let mut slot: [Option<IAssocHandler>; 1] = [None];
        let mut fetched = 0;
        if unsafe { list.Next(&mut slot, Some(&mut fetched)) }.is_err() {
            return false;
        }
        if fetched == 0 || candidates.len() >= MAX_CANDIDATES {
            break;
        }
        if let Some(handler) = slot[0].take() {
            if let Some(image) = take_string(unsafe { handler.GetName() }) {
                add(
                    candidates,
                    take_string(unsafe { handler.GetUIName() }),
                    &image,
                );
            }
        }
    }
    true
}

pub(super) fn discover() -> Result<Vec<Candidate>, String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|_| UNAVAILABLE)?;
    let _apartment = Apartment;
    let mut candidates = Vec::new();
    let mut enumerated = false;
    for extension in [w!(".log"), w!(".txt")] {
        if let Some(image) = association(extension, ASSOCSTR_EXECUTABLE) {
            add(
                &mut candidates,
                association(extension, ASSOCSTR_FRIENDLYAPPNAME),
                &image,
            );
        }
        enumerated |= enumerate(extension, &mut candidates);
    }
    if !enumerated && candidates.is_empty() {
        return Err(UNAVAILABLE.into());
    }
    candidates.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    Ok(candidates)
}
