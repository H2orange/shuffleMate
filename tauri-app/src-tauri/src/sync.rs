use tauri::Emitter;
use crate::audio::{self, DEFAULT_PREGAP};
use crate::device;
use crate::fsx;
use crate::itunessd;
use crate::types::*;
use crate::voiceover;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

const MUSIC_REL: &str = "iPod_Control/Music";
const SD_REL: &str = "iPod_Control/iTunes/iTunesSD";
const FOLDER_CAPACITY: usize = 40;

pub struct PathAllocator {
    counts: HashMap<String, usize>,
    names: HashSet<String>,
}

impl PathAllocator {
    pub fn new(existing: impl Iterator<Item = String>) -> Self {
        let mut counts = HashMap::new();
        let mut names = HashSet::new();
        for rel in existing {
            let parts: Vec<&str> = rel.split('/').collect();
            let folder = if parts.len() >= 2 { parts[parts.len()-2].to_string() } else { String::new() };
            let base = parts.last()
                .map(|f| f.rsplit('.').skip(1).collect::<Vec<_>>().join(".").to_uppercase())
                .unwrap_or_default();
            if !folder.is_empty() {
                *counts.entry(folder).or_insert(0) += 1;
            }
            names.insert(base);
        }
        PathAllocator { counts, names }
    }

    fn pick_folder(&mut self) -> String {
        if self.counts.is_empty() {
            self.counts.insert("F00".to_string(), 0);
            return "F00".to_string();
        }
        let mut best = String::new();
        let mut best_count = usize::MAX;
        for (folder, &n) in &self.counts {
            if n < best_count || (n == best_count && *folder < best) {
                best = folder.clone();
                best_count = n;
            }
        }
        if best_count >= FOLDER_CAPACITY {
            let used: HashSet<String> = self.counts.keys().cloned().collect();
            for i in 0..100 {
                let name = format!("F{:02}", i);
                if !used.contains(&name) {
                    self.counts.insert(name.clone(), 0);
                    return name;
                }
            }
        }
        best
    }

    pub fn alloc(&mut self, source_name: &str) -> String {
        let folder = self.pick_folder();
        let ext = Path::new(source_name).extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp3")
            .to_lowercase();
        let stem = Path::new(source_name).file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("track")
            .to_string();
        let base = stem.to_uppercase();
        let mut n = 0usize;
        loop {
            let candidate = if n == 0 { base.clone() } else { format!("{}{}", base, n) };
            if !self.names.contains(&candidate) {
                self.names.insert(candidate.clone());
                *self.counts.entry(folder.clone()).or_insert(0) += 1;
                return format!("{}/{}/{}.{}", MUSIC_REL, folder, candidate, ext);
            }
            n += 1;
        }
    }
}

fn stable_id(text: &str, fallback: u32) -> u32 {
    let t = text.trim();
    if t.is_empty() { return fallback; }
    let digest = md5::compute(t.as_bytes());
    let h = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) & 0x7fffffff;
    if h == 0 { fallback } else { h }
}

fn most_common(values: &[u32]) -> Option<u32> {
    if values.is_empty() { return None; }
    let mut counts: HashMap<u32, usize> = HashMap::new();
    for &v in values { *counts.entry(v).or_insert(0) += 1; }
    counts.into_iter().max_by_key(|&(_, n)| n).map(|(v, _)| v)
}

pub fn sync_device(
    root: &str,
    backups_root: &str,
    opts: SyncOptions,
    app: Option<&tauri::AppHandle>,
) -> Result<SyncResult, String> {
    let add_sources = opts.add_sources.unwrap_or_default();
    let remove_ids: HashSet<String> = opts.remove_ids.unwrap_or_default().into_iter().collect();
    let generate_voiceover = opts.generate_voiceover.unwrap_or(false);
    let enable_voiceover_flag = opts.enable_voiceover.unwrap_or(false);
    let voiceover_rate = opts.voiceover_rate.map(|r| r as u32);
    let voiceover_speed = opts.voiceover_speed.unwrap_or(0);
    let voiceover_voice = opts.voiceover_voice;
    let volume_gain = opts.volume_gain.unwrap_or(0);
    let skip_duplicates = opts.skip_duplicates.unwrap_or(false);
    let prune_orphans = opts.prune_orphans.unwrap_or(true);

    let report = |phase: &str, message: &str, current: usize, total: usize| {
        if let Some(a) = app {
            let _ = a.emit("sync:progress", serde_json::json!({
                "phase": phase, "message": message, "current": current, "total": total
            }));
        }
    };

    let mut warnings: Vec<String> = Vec::new();
    let mut result = SyncResult {
        added: 0, removed: 0, voiceover_created: 0, voiceover_skipped: 0,
        bytes_written: 0, backup_path: None, ghost_pruned: 0, orphan_removed: 0,
        orphan_voice_removed: 0, orphan_kept: 0, warnings: Vec::new(),
    };

    // 1. Load library
    report("prepare", "Loading library...", 0, 0);
    let lib = device::load_library(root).map_err(|e| e.to_string())?;
    let model = device::read_model(root).map_err(|e| e.to_string())?;

    // 2. Backup
    let sd_path = Path::new(root).join(SD_REL);
    if sd_path.exists() {
        match fsx::backup_file(&sd_path, backups_root, "pre-sync", None) {
            Ok(p) => result.backup_path = Some(p),
            Err(e) => warnings.push(format!("Backup failed: {}", e)),
        }
    }

    // 3. Determine what to keep
    let mut final_tracks: Vec<TrackRecord> = Vec::new();
    let mut titles: Vec<String> = Vec::new();
    let mut artists: Vec<String> = Vec::new();

    for (i, track_view) in lib.tracks.iter().enumerate() {
        if remove_ids.contains(&track_view.id) {
            result.removed += 1;
            continue;
        }
        if !track_view.exists {
            result.ghost_pruned += 1;
            continue;
        }
        if i < model.tracks.len() {
            final_tracks.push(model.tracks[i].clone());
            titles.push(track_view.title.clone());
            artists.push(track_view.artist.clone());
        }
    }

    // 4. Copy new files
    let mut alloc = PathAllocator::new(final_tracks.iter().map(|t| t.filename.trim_start_matches('/').to_string()));
    let music_root = Path::new(root).join(MUSIC_REL);
    let mut added_infos: Vec<(String, crate::types::AudioInfo)> = Vec::new();

    if !add_sources.is_empty() {
        report("copy", "Copying files...", 0, add_sources.len());
        for (i, src) in add_sources.iter().enumerate() {
            report("copy", &format!("Copy {}/{}", i+1, add_sources.len()), i+1, add_sources.len());
            let info = match audio::probe_audio_file(Path::new(src)) {
                Ok(i) => i,
                Err(e) => {
                    warnings.push(format!("Skip {}: {}", src, e));
                    continue;
                }
            };

            if skip_duplicates {
                let title = info.tag.title.as_deref().unwrap_or("");
                let dup = titles.iter().enumerate().any(|(j, t)| {
                    t == title && !title.is_empty() &&
                    j < final_tracks.len() &&
                    (final_tracks[j].stop_ms as i64 - info.duration_ms as i64).abs() < 2000
                });
                if dup { continue; }
            }

            let rel = alloc.alloc(&Path::new(src).file_name().unwrap_or_default().to_string_lossy());
            let abs_dst = Path::new(root).join(&rel);
            if let Some(parent) = abs_dst.parent() {
                let _ = fsx::ensure_dir(&parent.to_string_lossy());
            }

            match fsx::copy_file_sync(src, &abs_dst.to_string_lossy(), None) {
                Ok(bytes) => {
                    result.bytes_written += bytes;
                    result.added += 1;
                    added_infos.push((rel, info));
                }
                Err(e) => {
                    warnings.push(format!("Copy failed {}: {}", src, e));
                }
            }
        }
    }

    // 5. Build new track records for added files
    let pregap = most_common(&final_tracks.iter().map(|t| t.pregap).collect::<Vec<_>>()).unwrap_or(DEFAULT_PREGAP);

    for (rel, info) in &added_infos {
        let dbid = voiceover::dbid_from_text(rel);
        let title = info.tag.title.as_deref().unwrap_or("");
        let artist_str = info.tag.artist.as_deref().unwrap_or("");
        let album_str = info.tag.album.as_deref().unwrap_or("");

        let track = itunessd::make_track_record(
            &format!("/{}", rel),
            info.filetype,
            info.duration_ms,
            info.sample_rate,
            info.audio_bytes as u32,
            dbid,
            pregap,
            stable_id(album_str, 1),
            stable_id(artist_str, 1),
            info.tag.track_no.unwrap_or(0),
            info.tag.disc_no.unwrap_or(0),
            volume_gain,
        );
        final_tracks.push(track);
        titles.push(title.to_string());
        artists.push(artist_str.to_string());
    }

    // 6. Rebuild iTunesSD
    report("database", "Rebuilding database...", 0, 0);
    let max_vol: Option<u8> = if enable_voiceover_flag { Some(1) } else { None };
    let new_model = itunessd::with_tracks(&model, final_tracks.clone(), max_vol);
    let sd_data = itunessd::build_sd(&new_model);

    let vo_enable_warning = generate_voiceover && new_model.root.voiceover == 0;
    fsx::atomic_write_file(&sd_path.to_string_lossy(), &sd_data).map_err(|e| format!("Write iTunesSD failed: {}", e))?;

    // 7. Orphan cleanup
    if prune_orphans && itunessd::round_trips(&sd_path) {
        report("delete", "Checking orphans...", 0, 0);
        let music_root_str = music_root.to_string_lossy().to_string();
        let files = device::scan_music_files(root);
        let referenced: HashSet<String> = final_tracks.iter()
            .map(|t| t.filename.trim_start_matches('/').to_string())
            .collect();

        let orphan_audio: Vec<String> = files.keys()
            .filter(|k| !referenced.contains(*k))
            .cloned()
            .collect();

        let (_playlists, tracks_dir) = voiceover::speakable_dirs(root);
        let voice_set: HashSet<String> = final_tracks.iter()
            .map(|t| voiceover::voice_filename(&t.dbid).to_lowercase())
            .collect();
        let orphan_voice: Vec<String> = fs::read_dir(&tracks_dir)
            .map(|entries| entries.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.to_lowercase().ends_with(".wav") && !voice_set.contains(&name.to_lowercase()) {
                        Some(name)
                    } else { None }
                })
                .collect())
            .unwrap_or_default();

        let total = orphan_audio.len() + orphan_voice.len();
        let mut done = 0usize;
        for rel in &orphan_audio {
            let abs = Path::new(root).join(rel).to_string_lossy().to_string();
            match fsx::remove_file_safe(&abs, &music_root_str) {
                Ok(_) => result.orphan_removed += 1,
                Err(_) => result.orphan_kept += 1,
            }
            done += 1;
            report("delete", &format!("Cleanup {}/{}", done, total), done, total);
        }
        for f in &orphan_voice {
            let abs = Path::new(&tracks_dir).join(f).to_string_lossy().to_string();
            match fsx::remove_file_safe(&abs, &tracks_dir) {
                Ok(_) => result.orphan_voice_removed += 1,
                Err(_) => result.orphan_kept += 1,
            }
            done += 1;
            report("delete", &format!("Cleanup voice {}/{}", done, total), done, total);
        }
    }

    // 8. VoiceOver
    if generate_voiceover {
        let (_playlists, tracks_dir) = voiceover::speakable_dirs(root);
        let _ = fsx::ensure_dir(&tracks_dir);

        let rate = voiceover_rate.or_else(|| {
            voiceover::detect_speakable_format(root).map(|(info, _)| info.rate)
        }).unwrap_or(voiceover::DEFAULT_RATE);

        let mut missing: Vec<(usize, String, [u8; 8])> = Vec::new();
        for (i, t) in final_tracks.iter().enumerate() {
            let dst = Path::new(&tracks_dir).join(voiceover::voice_filename(&t.dbid));
            if dst.exists() {
                result.voiceover_skipped += 1;
                continue;
            }
            let text = voiceover::announce_text(&titles[i], Some(&artists[i]));
            missing.push((i, text, t.dbid));
        }

        if !missing.is_empty() {
            report("voiceover", "Generating voices...", 0, missing.len());
        }
        for (i, (_idx, text, dbid)) in missing.iter().enumerate() {
            report("voiceover", &format!("Voice: {}", text), i+1, missing.len());
            if text.is_empty() { continue; }
            match voiceover::synthesize(text, rate, voiceover_voice.as_deref(), voiceover_speed) {
                Ok(wav) => {
                    match voiceover::write_voice_file(&tracks_dir, dbid, &wav) {
                        Ok(_) => result.voiceover_created += 1,
                        Err(e) => warnings.push(format!("Voice write failed: {}", e)),
                    }
                }
                Err(e) => warnings.push(format!("TTS failed '{}': {}", text, e)),
            }
        }

        if vo_enable_warning {
            warnings.push("Voice files generated, but device VoiceOver switch is OFF.".to_string());
        }
    } else {
        result.voiceover_skipped = final_tracks.len();
    }

    // 9. Flush
    report("flush", "Flushing...", 0, 0);
    let letter = root.chars().next().unwrap_or('A').to_string();
    if !fsx::flush_volume(&letter) {
        warnings.push("Volume flush requires admin rights. Use Safe Remove before unplugging.".to_string());
    }

    report("done", "Complete", 0, 0);
    result.warnings = warnings;
    Ok(result)
}