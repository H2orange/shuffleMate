use crate::fsx;
use base64::{Engine as _, engine::general_purpose};
use std::fs;
use std::path::Path;
use std::process::Command;

pub const APPLE_HEADER_LEN: usize = 4096;
pub const DEFAULT_RATE: u32 = 22050;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct WavInfo {
    pub file_size: usize,
    pub audio_format: u16,
    pub channels: u16,
    pub rate: u32,
    pub bits: u16,
    pub byte_rate: u32,
    pub block_align: u16,
    pub data_offset: usize,
    pub data_size: usize,
    pub duration: f64,
    pub pcm: bool,
    pub is_apple_container: bool,
}

pub fn voice_filename(dbid: &[u8; 8]) -> String {
    let mut rev = *dbid;
    rev.reverse();
    format!("{}.wav", hex::encode(rev).to_uppercase())
}

pub fn dbid_from_text(text: &str) -> [u8; 8] {
    let digest = md5::compute(text.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

#[allow(dead_code)]
pub fn unique_dbids(texts: &[String]) -> Vec<[u8; 8]> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    texts.iter().map(|t| {
        let n = *seen.get(t).unwrap_or(&0);
        seen.insert(t.clone(), n + 1);
        let key = if n == 0 { t.clone() } else { format!("{}\\x1f#{}", t, n + 1) };
        dbid_from_text(&key)
    }).collect()
}

pub fn announce_text(title: &str, artist: Option<&str>) -> String {
    let mut parts = Vec::new();
    let t = title.trim();
    if !t.is_empty() { parts.push(t.to_string()); }
    if let Some(a) = artist {
        let a = a.trim();
        if !a.is_empty() { parts.push(a.to_string()); }
    }
    parts.join(" - ")
}

pub fn parse_wav(data: &[u8]) -> Option<WavInfo> {
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return None;
    }
    let mut i = 12;
    let mut fmt_format = 0u16;
    let mut fmt_channels = 0u16;
    let mut fmt_rate = 0u32;
    let mut fmt_byte_rate = 0u32;
    let mut fmt_block_align = 0u16;
    let mut fmt_bits = 0u16;
    let mut data_offset = 0usize;
    let mut data_size = 0usize;
    let mut found_fmt = false;

    while i + 8 <= data.len() {
        let cid = &data[i..i+4];
        let sz = u32::from_le_bytes([data[i+4], data[i+5], data[i+6], data[i+7]]) as usize;
        if cid == b"fmt " && sz >= 16 && i + 8 + sz <= data.len() {
            fmt_format = u16::from_le_bytes([data[i+8], data[i+9]]);
            fmt_channels = u16::from_le_bytes([data[i+10], data[i+11]]);
            fmt_rate = u32::from_le_bytes([data[i+12], data[i+13], data[i+14], data[i+15]]);
            fmt_byte_rate = u32::from_le_bytes([data[i+16], data[i+17], data[i+18], data[i+19]]);
            fmt_block_align = u16::from_le_bytes([data[i+20], data[i+21]]);
            fmt_bits = u16::from_le_bytes([data[i+22], data[i+23]]);
            found_fmt = true;
        } else if cid == b"data" {
            data_offset = i + 8;
            data_size = sz;
        }
        i += 8 + sz;
        if sz % 2 != 0 { i += 1; }
    }

    if !found_fmt { return None; }
    let pcm = fmt_format == 1;
    let duration = if fmt_byte_rate > 0 { data_size as f64 / fmt_byte_rate as f64 } else { 0.0 };
    let is_apple = data.len() >= APPLE_HEADER_LEN && data_offset == APPLE_HEADER_LEN;

    Some(WavInfo {
        file_size: data.len(), audio_format: fmt_format, channels: fmt_channels,
        rate: fmt_rate, bits: fmt_bits, byte_rate: fmt_byte_rate,
        block_align: fmt_block_align, data_offset, data_size, duration, pcm,
        is_apple_container: is_apple,
    })
}

fn powershell_path() -> String {
    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&sys_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
        .to_string_lossy()
        .to_string()
}

fn base64_encode_utf16le(s: &str) -> String {
    let utf16: Vec<u8> = s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    general_purpose::STANDARD.encode(&utf16)
}

pub fn list_voices_powershell() -> Result<Vec<crate::types::VoiceInfo>, Box<dyn std::error::Error>> {
    let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
 = New-Object -ComObject SAPI.SpVoice
foreach ( in .GetVoices()) {
     = .GetDescription()
     = try { .GetAttribute('Gender') } catch { '' }
     = try { .GetAttribute('Language') } catch { '' }
    Write-Output ('{0}|{1}|{2}' -f , , )
}"#;
    let encoded = base64_encode_utf16le(script);
    let ps = powershell_path();
    let output = Command::new(&ps)
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded])
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let voices: Vec<crate::types::VoiceInfo> = stdout.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '|').collect();
            if parts.len() >= 3 {
                Some(crate::types::VoiceInfo {
                    name: parts[0].trim().to_string(),
                    culture: parts[1].trim().to_string(),
                    gender: parts[2].trim().to_string(),
                })
            } else if parts.len() == 1 && !parts[0].trim().is_empty() {
                Some(crate::types::VoiceInfo {
                    name: parts[0].trim().to_string(),
                    culture: String::new(),
                    gender: String::new(),
                })
            } else {
                None
            }
        })
        .collect();
    Ok(voices)
}

pub fn synthesize(text: &str, rate: u32, voice: Option<&str>, speed: i32) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let temp_dir = std::env::temp_dir();
    let temp_wav = temp_dir.join(format!("shufflemate_tts_{}.wav", uuid::Uuid::new_v4()));

    let saft: u32 = match rate {
        8000 => 6, 11025 => 10, 12000 => 14, 16000 => 18,
        22050 => 22, 24000 => 26, 32000 => 30, 44100 => 34, 48000 => 38,
        _ => 22,
    };

    let voice_select = if let Some(name) = voice {
        format!(" = .GetVoices() | Where-Object {{ .GetDescription() -eq '{}' }}; if () {{ .Voice =  }}", name.replace("'", "''"))
    } else {
        String::new()
    };

    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n = New-Object -ComObject SAPI.SpVoice\n{}\n.Rate = {}\n = New-Object -ComObject SAPI.SpFileStream\n.Format.Type = {}\n.Open('{}', 3, False)\n.AudioOutputStream = \n.Speak('{}')\n.Close()",
        voice_select,
        speed.clamp(-10, 10),
        saft,
        temp_wav.to_string_lossy().replace("'", "''"),
        text.replace("'", "''")
    );

    let encoded = base64_encode_utf16le(&script);
    let ps = powershell_path();
    let result = Command::new(&ps)
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded])
        .output();

    match result {
        Ok(output) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("PowerShell TTS failed: {}", stderr).into());
            }
        }
        Err(e) => return Err(format!("PowerShell not available: {}", e).into()),
    }

    if !temp_wav.exists() {
        return Err("TTS produced no output".into());
    }

    let raw_wav = fs::read(&temp_wav)?;
    let _ = fs::remove_file(&temp_wav);

    let info = parse_wav(&raw_wav).ok_or("Failed to parse TTS WAV output")?;
    let pcm = &raw_wav[info.data_offset..info.data_offset + info.data_size];
    let apple_wav = repackage_apple_wav(pcm, rate);
    Ok(apple_wav)
}

fn repackage_apple_wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let total_size = APPLE_HEADER_LEN + pcm.len();
    let mut out = vec![0u8; total_size];
    out[0..4].copy_from_slice(b"RIFF");
    out[4..8].copy_from_slice(&((total_size - 8) as u32).to_le_bytes());
    out[8..12].copy_from_slice(b"WAVE");
    out[12..16].copy_from_slice(b"fmt ");
    out[16..20].copy_from_slice(&16u32.to_le_bytes());
    out[20..22].copy_from_slice(&1u16.to_le_bytes());
    out[22..24].copy_from_slice(&1u16.to_le_bytes());
    out[24..28].copy_from_slice(&rate.to_le_bytes());
    out[28..32].copy_from_slice(&((rate * 2) as u32).to_le_bytes());
    out[32..34].copy_from_slice(&2u16.to_le_bytes());
    out[34..36].copy_from_slice(&16u16.to_le_bytes());
    let fllr_size = (APPLE_HEADER_LEN - 44) as u32;
    out[36..40].copy_from_slice(b"FLLR");
    out[40..44].copy_from_slice(&fllr_size.to_le_bytes());
    out[APPLE_HEADER_LEN..APPLE_HEADER_LEN+4].copy_from_slice(b"data");
    out[APPLE_HEADER_LEN+4..APPLE_HEADER_LEN+8].copy_from_slice(&(pcm.len() as u32).to_le_bytes());
    out[APPLE_HEADER_LEN+8..].copy_from_slice(pcm);
    out
}

pub fn detect_speakable_format(ipod_root: &str) -> Option<(WavInfo, String)> {
    let (_playlists, tracks_dir) = speakable_dirs(ipod_root);
    let entries = match fs::read_dir(&tracks_dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    let mut files: Vec<String> = entries.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.to_lowercase().ends_with(".wav") { Some(e.path().to_string_lossy().to_string()) } else { None }
        })
        .collect();
    files.sort();
    for f in files {
        if let Ok(data) = fs::read(&f) {
            if let Some(info) = parse_wav(&data) {
                if info.pcm {
                    return Some((info, f));
                }
            }
        }
    }
    None
}

pub fn speakable_dirs(ipod_root: &str) -> (String, String) {
    let base = Path::new(ipod_root).join("iPod_Control").join("Speakable");
    let tracks = base.join("Tracks").to_string_lossy().to_string();
    let playlists = base.join("Playlists").to_string_lossy().to_string();
    (playlists, tracks)
}

pub fn write_voice_file(tracks_dir: &str, dbid: &[u8; 8], wav: &[u8]) -> Result<String, Box<dyn std::error::Error>> {
    fsx::ensure_dir(tracks_dir)?;
    let dst = Path::new(tracks_dir).join(voice_filename(dbid));
    let dst_str = dst.to_string_lossy().to_string();
    fsx::atomic_write_file(&dst_str, wav)?;
    Ok(dst_str)
}

pub fn tts_diagnostics() -> crate::types::TtsDiagnostics {
    let ps = powershell_path();
    let ps_exists = Path::new(&ps).exists();
    let voices = list_voices_powershell().unwrap_or_default();
    let voice_names: Vec<String> = voices.iter().map(|v| v.name.clone()).collect();
    let preferred = ["Microsoft Huihui Desktop", "Microsoft Xiaoxiao", "Microsoft Yaoyao", "Microsoft Kangkang", "Microsoft HuiHui"];
    let found = preferred.iter().find(|&&p| voice_names.iter().any(|v| v.contains(p))).map(|s| s.to_string());

    crate::types::TtsDiagnostics {
        powershell: ps_exists,
        voices: voice_names,
        preferred_found: found,
    }
}