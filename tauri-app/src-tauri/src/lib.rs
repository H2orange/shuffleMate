mod device;
mod audio;
mod fsx;
mod voiceover;
mod sync;
mod hotplug;
mod itunesdb;
mod itunessd;
mod types;

use device::{find_ipod_roots, get_device_info, load_library};
use types::{DeviceInfo, LoadedLibrary, LocalTrack, SyncOptions, SyncResult, TtsDiagnostics, VoiceInfo};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Default)]
#[allow(dead_code)]
struct AppState {
    selected_device: Mutex<Option<String>>,
    hotplug_running: Mutex<Option<Arc<AtomicBool>>>,
}

#[tauri::command]
fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let roots = find_ipod_roots();
    let mut devices = Vec::new();
    for root in roots {
        match get_device_info(&root) {
            Ok(info) => devices.push(info),
            Err(e) => eprintln!("Error getting info for {}: {}", root, e),
        }
    }
    Ok(devices)
}

#[tauri::command]
fn load_device(root: String) -> Result<LoadedLibrary, String> {
    load_library(&root).map_err(|e| e.to_string())
}

#[tauri::command]
fn pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let files = tauri_plugin_dialog::DialogExt::dialog(&app)
        .file()
        .blocking_pick_files();
    match files {
        Some(paths) => Ok(paths.into_iter().map(|p| p.to_string()).collect()),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = tauri_plugin_dialog::DialogExt::dialog(&app)
        .file()
        .blocking_pick_folder();
    match folder {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
fn expand_inputs(inputs: Vec<String>) -> Result<Vec<String>, String> {
    let audio_exts: std::collections::HashSet<&str> = ["mp3","m4a","m4b","aac","wav","flac","ogg","opus","wma","aiff","aif"].iter().cloned().collect();
    let mut result = Vec::new();
    for input in &inputs {
        let path = Path::new(input);
        if path.is_dir() {
            for entry in walkdir::WalkDir::new(path).max_depth(10).into_iter().filter_map(|e| e.ok()) {
                if entry.file_type().is_file() {
                    if let Some(ext) = entry.path().extension() {
                        let ext_lower_owned = ext.to_string_lossy().to_lowercase();
                        if audio_exts.contains(ext_lower_owned.as_str()) {
                            result.push(entry.path().to_string_lossy().to_string());
                        }
                    }
                }
            }
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                let ext_lower_owned = ext.to_string_lossy().to_lowercase();
                if audio_exts.contains(ext_lower_owned.as_str()) {
                    result.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
fn inspect_files(paths: Vec<String>) -> Result<Vec<LocalTrack>, String> {
    let mut tracks = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let ext = path.extension().map(|e| e.to_string_lossy().to_uppercase().to_string()).unwrap_or_default();

        match audio::probe_audio_file(path) {
            Ok(info) => {
                tracks.push(LocalTrack {
                    path: p.clone(),
                    file_name,
                    file_size: info.file_size,
                    title: info.tag.title.unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()),
                    artist: info.tag.artist.unwrap_or_default(),
                    album: info.tag.album.unwrap_or_default(),
                    duration_ms: info.duration_ms,
                    format: info.container.to_uppercase(),
                    error: None,
                });
            }
            Err(e) => {
                tracks.push(LocalTrack {
                    path: p.clone(),
                    file_name,
                    file_size,
                    title: String::new(),
                    artist: String::new(),
                    album: String::new(),
                    duration_ms: 0,
                    format: ext,
                    error: Some(e.to_string()),
                });
            }
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn list_voices() -> Result<Vec<VoiceInfo>, String> {
    voiceover::list_voices_powershell().map_err(|e| e.to_string())
}

#[tauri::command]
fn tts_diagnostics() -> Result<TtsDiagnostics, String> {
    Ok(voiceover::tts_diagnostics())
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::process::Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    } else if p.exists() {
        std::process::Command::new("explorer").args(["/select,", &path]).spawn().map_err(|e| e.to_string())?;
    } else if let Some(parent) = p.parent() {
        if parent.exists() {
            std::process::Command::new("explorer").arg(parent.to_string_lossy().as_ref()).spawn().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn eject(root: String) -> Result<(), String> {
    let dev = get_device_info(&root).map_err(|e| e.to_string())?;
    fsx::flush_volume(&dev.drive_letter);
    let letter = dev.drive_letter.replace(':', "");
    let script = format!(
        "$vol = Get-WmiObject -Class Win32_Volume | Where-Object {{ $_.DriveLetter -eq '{}:' }}; if ($vol) {{ $vol.Dismount($false, $false) }}",
        letter
    );
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output();
    Ok(())
}

#[tauri::command]
fn run_sync(app: tauri::AppHandle, root: String, opts: SyncOptions) -> Result<SyncResult, String> {
    let backups_root = Path::new(&root)
        .join("iPod_Control")
        .join("backups")
        .to_string_lossy()
        .to_string();
    sync::sync_device(&root, &backups_root, opts, Some(&app))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let running = Arc::new(AtomicBool::new(true));
            hotplug::start_hotplug_watch(handle, running.clone());
            let state: tauri::State<AppState> = app.state();
            *state.hotplug_running.lock().unwrap() = Some(running);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            load_device,
            pick_files,
            pick_folder,
            expand_inputs,
            inspect_files,
            list_voices,
            tts_diagnostics,
            reveal,
            eject,
            run_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
