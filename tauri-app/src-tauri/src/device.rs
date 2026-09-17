use crate::audio;

use crate::itunesdb;
use crate::itunessd;
use crate::types::*;
use crate::voiceover;
use base64::{Engine as _, engine::general_purpose};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;

const IPOD_SD_REL: &str = "iPod_Control/iTunes/iTunesSD";
const MUSIC_REL: &str = "iPod_Control/Music";

#[derive(Debug, Clone)]
pub struct MusicFile {
    pub abs_path: String,
    pub size: u64,
}

pub fn find_ipod_roots() -> Vec<String> {
    let mut roots = Vec::new();
    for c in b'A'..=b'Z' {
        let letter = c as char;
        let root = format!("{}:/", letter);
        let sd_path = Path::new(&root).join(IPOD_SD_REL);
        if sd_path.exists() {
            roots.push(root);
        }
    }
    roots
}

#[allow(dead_code)]
pub fn find_first_ipod() -> Option<String> {
    find_ipod_roots().into_iter().next()
}

fn volume_label(root: &str) -> String {
    let letter = root.trim_end_matches(":/").trim_end_matches(':').trim_end_matches('/');
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write((Get-Volume -DriveLetter {} -ErrorAction Stop).FileSystemLabel)",
        letter
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    let encoded = general_purpose::STANDARD.encode(&utf16);

    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\\\Windows".to_string());
    let ps = Path::new(&sys_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");

    match Command::new(ps)
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

fn disk_usage(root: &str) -> (u64, u64) {
    match fs2::statvfs(root) {
        Ok(stat) => (stat.total_space(), stat.available_space()),
        Err(_) => (0, 0),
    }
}

pub fn scan_music_files(root: &str) -> HashMap<String, MusicFile> {
    let mut files = HashMap::new();
    let music_dir = Path::new(root).join(MUSIC_REL);
    let entries = match fs::read_dir(&music_dir) {
        Ok(e) => e,
        Err(_) => return files,
    };

    for entry in entries.flatten() {
        if !entry.path().is_dir() { continue; }
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let sub_entries = match fs::read_dir(entry.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for sub_entry in sub_entries.flatten() {
            let path = sub_entry.path();
            if !path.is_file() { continue; }
            let file_name = path.file_name().unwrap().to_string_lossy().to_string();
            if file_name.starts_with('.') { continue; }
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let rel_path = format!("{}/{}/{}", MUSIC_REL, folder_name, file_name);
            files.insert(rel_path, MusicFile {
                abs_path: path.to_string_lossy().to_string(),
                size,
            });
        }
    }
    files
}

pub fn read_model(root: &str) -> Result<SdModel, String> {
    let sd_path = Path::new(root).join(IPOD_SD_REL);
    let data = fs::read(&sd_path).map_err(|e| format!("Failed to read iTunesSD: {}", e))?;
    itunessd::parse_sd(&data)
}

pub fn load_library(root: &str) -> Result<LoadedLibrary, Box<dyn std::error::Error>> {
    let model = read_model(root)?;
    let files = scan_music_files(root);
    let db = itunesdb::read_itunes_db(root);

    let speakable = voiceover::speakable_dirs(root);
    let voice_files: HashSet<String> = fs::read_dir(&speakable.1)
        .map(|entries| entries.flatten()
            .filter_map(|e| Some(e.file_name().to_string_lossy().to_lowercase()))
            .collect())
        .unwrap_or_default();

    let mut known = HashSet::new();
    let mut missing = 0usize;

    let tracks: Vec<TrackView> = model.tracks.iter().map(|t| {
        let rel = t.filename.trim_start_matches('/').to_string();
        known.insert(rel.clone());
        let file = files.get(&rel);
        if file.is_none() { missing += 1; }

        let db_entry = db.get(&rel);
        let stem = Path::new(&rel).file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();

        let tag = if let Some(f) = file {
            audio::read_tags(Path::new(&f.abs_path))
        } else {
            AudioTag::default()
        };

        let title = tag.title.as_deref()
            .or(db_entry.map(|e| e.title.as_str()))
            .unwrap_or(&stem)
            .to_string();
        let artist = tag.artist.as_deref()
            .or(db_entry.map(|e| e.artist.as_str()))
            .unwrap_or("")
            .to_string();
        let album = tag.album.as_deref()
            .or(db_entry.map(|e| e.album.as_str()))
            .unwrap_or("")
            .to_string();

        let source = if tag.title.is_some() { "id3" }
            else if db_entry.map(|e| !e.title.is_empty()).unwrap_or(false) { "itunesdb" }
            else { "filename" };

        let has_vo = voice_files.contains(&voiceover::voice_filename(&t.dbid).to_lowercase());

        TrackView {
            id: hex::encode(t.dbid),
            filename: rel,
            title,
            artist,
            album,
            duration_ms: t.stop_ms,
            file_size: file.map(|f| f.size).unwrap_or(0),
            format: if t.filetype == FILE_TYPE_AAC { "AAC".to_string() } else { "MP3".to_string() },
            source: source.to_string(),
            exists: file.is_some(),
            has_voiceover: has_vo,
        }
    }).collect();

    let orphan = files.keys().filter(|k| !known.contains(*k)).count();
    let speakable_path = Path::new(root).join("iPod_Control").join("Speakable").join("Tracks");

    Ok(LoadedLibrary {
        tracks,
        missing_files: missing,
        orphan_files: orphan,
        voiceover_enabled: model.root.voiceover != 0,
        voiceover_supported: speakable_path.exists(),
    })
}

pub fn get_device_info(root: &str) -> Result<DeviceInfo, Box<dyn std::error::Error>> {
    let (total, free) = disk_usage(root);
    let files = scan_music_files(root);
    let used: u64 = files.values().map(|f| f.size).sum();

    let sd_path = Path::new(root).join(IPOD_SD_REL);
    let (track_count, voiceover_enabled, version) = if sd_path.exists() {
        match read_model(root) {
            Ok(model) => (model.tracks.len(), model.root.voiceover != 0, model.root.version),
            Err(_) => (0, false, 0),
        }
    } else {
        (0, false, 0)
    };

    let speakable_dir = Path::new(root).join("iPod_Control").join("Speakable").join("Tracks");

    let drive_letter = if root.len() >= 2 {
        format!("{}:", root.chars().next().unwrap())
    } else {
        root.to_string()
    };

    Ok(DeviceInfo {
        root: root.to_string(),
        drive_letter,
        volume_label: volume_label(root),
        total_bytes: total,
        free_bytes: free,
        track_count,
        file_count: files.len(),
        used_by_music_bytes: used,
        voiceover_supported: speakable_dir.exists(),
        voiceover_enabled,
        version,
    })
}

// Library functions (expand_inputs, inspect_local_files)

#[allow(dead_code)]
const AUDIO_EXTS: &[&str] = &[".mp3", ".m4a", ".mp4", ".aac"];

#[allow(dead_code)]
fn is_audio_file(p: &str) -> bool {
    let ext = Path::new(p).extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()));
    ext.map(|e| AUDIO_EXTS.contains(&e.as_str())).unwrap_or(false)
}

#[allow(dead_code)]
fn list_audio_files(dir: &str, recursive: bool) -> Vec<String> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let p = entry.path().to_string_lossy().to_string();
        if entry.path().is_dir() {
            if recursive { out.extend(list_audio_files(&p, true)); }
        } else if entry.path().is_file() && is_audio_file(&p) {
            out.push(p);
        }
    }
    out
}

#[allow(dead_code)]
pub fn expand_inputs(inputs: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in inputs {
        let key = raw.to_lowercase();
        if seen.contains(&key) { continue; }
        match fs::metadata(raw) {
            Ok(meta) if meta.is_dir() => {
                for f in list_audio_files(raw, true) {
                    let k = f.to_lowercase();
                    if !seen.contains(&k) {
                        seen.insert(k);
                        out.push(f);
                    }
                }
            }
            Ok(_) if is_audio_file(raw) => {
                seen.insert(key);
                out.push(raw.clone());
            }
            _ => {}
        }
    }
    out
}

#[allow(dead_code)]
pub fn inspect_local_files(paths: &[String]) -> Vec<LocalTrack> {
    paths.iter().map(|p| inspect_local_file(p)).collect()
}

fn inspect_local_file(abs_path: &str) -> LocalTrack {
    let file_name = Path::new(abs_path).file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    let _stem = file_name.trim_end_matches(|c: char| c == '.' || c.is_alphanumeric())
        .to_string();
    let stem = Path::new(&file_name).file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&file_name)
        .to_string();
    let ext = Path::new(abs_path).extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_uppercase();

    let mut track = LocalTrack {
        path: abs_path.to_string(),
        file_name: file_name.clone(),
        file_size: 0,
        title: stem.clone(),
        artist: String::new(),
        album: String::new(),
        duration_ms: 0,
        format: ext.clone(),
        error: None,
    };

    match fs::metadata(abs_path) {
        Ok(meta) => track.file_size = meta.len(),
        Err(e) => {
            track.error = Some(format!("Cannot read file: {}", e));
            return track;
        }
    }

    match audio::probe_audio_file(Path::new(abs_path)) {
        Ok(info) => {
            track.title = info.tag.title.unwrap_or(stem);
            track.artist = info.tag.artist.unwrap_or_default();
            track.album = info.tag.album.unwrap_or_default();
            track.duration_ms = info.duration_ms;
            track.format = if info.container == "m4a" { "AAC".to_string() } else { "MP3".to_string() };
        }
        Err(e) => {
            track.error = Some(e.to_string());
        }
    }

    track
}