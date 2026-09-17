use serde::{Deserialize, Serialize};

pub const FILE_TYPE_MP3: u32 = 1;
pub const FILE_TYPE_AAC: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackRecord {
    pub header_length: u32,
    pub start_ms: u32,
    pub stop_ms: u32,
    pub volume_gain: u32,
    pub filetype: u32,
    pub filename: String,
    pub bookmark: u32,
    pub dontskip: u8,
    pub remember: u8,
    pub unintalbum: u8,
    pub unknown_byte: u8,
    pub pregap: u32,
    pub postgap: u32,
    pub numsamples: u32,
    pub unk12c: u32,
    pub audio_bytes: u32,
    pub unk134: u32,
    pub albumid: u32,
    pub track_no: u16,
    pub disc: u16,
    pub unk140: u64,
    pub dbid: [u8; 8],
    pub artistid: u32,
    pub tail: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistRecord {
    pub header: Vec<u8>,
    pub total_length: u32,
    pub n_songs: u32,
    pub n_nonaudio: u32,
    pub dbid: [u8; 8],
    pub listtype: u32,
    pub members: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdRoot {
    pub version: u32,
    pub total_len: u32,
    pub n_tracks: u32,
    pub n_playlists: u32,
    pub unk_q: u64,
    pub max_volume: u8,
    pub voiceover: u8,
    pub unk_h: u16,
    pub tracks_wo_podcasts: u32,
    pub track_header_offset: u32,
    pub playlist_header_offset: u32,
    pub tail: [u8; 20],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdModel {
    pub root: SdRoot,
    pub tracks: Vec<TrackRecord>,
    pub playlist_header: Vec<u8>,
    pub playlists: Vec<PlaylistRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTag {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track_no: Option<u16>,
    pub track_total: Option<u16>,
    pub disc_no: Option<u16>,
    pub comment: Option<String>,
}

impl Default for AudioTag {
    fn default() -> Self {
        Self {
            title: None,
            artist: None,
            album: None,
            genre: None,
            year: None,
            track_no: None,
            track_total: None,
            disc_no: None,
            comment: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioInfo {
    pub container: String,
    pub filetype: u32,
    pub duration_ms: u32,
    pub sample_rate: u32,
    pub channels: u16,
    pub bitrate: u32,
    pub audio_bytes: u64,
    pub file_size: u64,
    pub tag: AudioTag,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackView {
    pub id: String,
    pub filename: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u32,
    pub file_size: u64,
    pub format: String,
    pub source: String,
    pub exists: bool,
    pub has_voiceover: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalTrack {
    pub path: String,
    pub file_name: String,
    pub file_size: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u32,
    pub format: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub root: String,
    pub drive_letter: String,
    pub volume_label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub track_count: usize,
    pub file_count: usize,
    pub used_by_music_bytes: u64,
    pub voiceover_supported: bool,
    pub voiceover_enabled: bool,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub added: usize,
    pub removed: usize,
    pub voiceover_created: usize,
    pub voiceover_skipped: usize,
    pub bytes_written: u64,
    pub backup_path: Option<String>,
    pub ghost_pruned: usize,
    pub orphan_removed: usize,
    pub orphan_voice_removed: usize,
    pub orphan_kept: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedLibrary {
    pub tracks: Vec<TrackView>,
    pub missing_files: usize,
    pub orphan_files: usize,
    pub voiceover_enabled: bool,
    pub voiceover_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct SyncProgress {
    pub phase: String,
    pub message: String,
    pub current: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOptions {
    pub add_sources: Option<Vec<String>>,
    pub remove_ids: Option<Vec<String>>,
    pub generate_voiceover: Option<bool>,
    pub enable_voiceover: Option<bool>,
    pub voiceover_rate: Option<f64>,
    pub voiceover_speed: Option<i32>,
    pub voiceover_voice: Option<String>,
    pub volume_gain: Option<u32>,
    pub skip_duplicates: Option<bool>,
    pub prune_orphans: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceInfo {
    pub name: String,
    pub culture: String,
    pub gender: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsDiagnostics {
    pub powershell: bool,
    pub voices: Vec<String>,
    pub preferred_found: Option<String>,
}