use crate::types::{AudioInfo, AudioTag, FILE_TYPE_AAC, FILE_TYPE_MP3};
use std::fs;
use std::path::Path;

const BITRATE_V1_L3: [u32; 16] = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const BITRATE_V2_L3: [u32; 16] = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];

pub const DEFAULT_PREGAP: u32 = 528;

#[derive(Debug)]
pub struct UnsupportedFormatError(pub String);
impl std::fmt::Display for UnsupportedFormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for UnsupportedFormatError {}

pub fn probe_audio_file(path: &Path) -> Result<AudioInfo, Box<dyn std::error::Error>> {
    let buf = fs::read(path)?;
    probe_audio_buffer(&buf, &path.to_string_lossy())
}

pub fn probe_audio_buffer(buf: &[u8], name: &str) -> Result<AudioInfo, Box<dyn std::error::Error>> {
    if buf.len() < 16 {
        return Err(Box::new(UnsupportedFormatError(format!("{}: file too small", name))));
    }
    if buf.len() >= 8 && &buf[4..8] == b"ftyp" {
        return parse_m4a(buf, name);
    }
    if &buf[0..3] == b"ID3" || (buf[0] == 0xff && (buf[1] & 0xe0) == 0xe0) {
        return parse_mp3(buf, name);
    }
    if buf.len() >= 4 && (&buf[0..4] == b"RIFF" || &buf[0..4] == b"FORM") {
        return Err(Box::new(UnsupportedFormatError(
            format!("{}: WAV/AIFF not supported. Convert to MP3 or M4A.", name)
        )));
    }
    Err(Box::new(UnsupportedFormatError(format!("{}: unrecognized audio container", name))))
}

fn read_u16_be(b: &[u8], off: usize) -> u16 {
    u16::from_be_bytes([b[off], b[off + 1]])
}
fn read_u32_be(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off+1], b[off+2], b[off+3]])
}

fn syncsafe(b: &[u8], off: usize) -> u32 {
    ((b[off] as u32 & 0x7f) << 21)
    | ((b[off+1] as u32 & 0x7f) << 14)
    | ((b[off+2] as u32 & 0x7f) << 7)
    | (b[off+3] as u32 & 0x7f)
}

fn decode_text(b: &[u8]) -> String {
    if b.is_empty() { return String::new(); }
    let enc = b[0];
    let body = &b[1..];
    let s = match enc {
        1 => {
            // UTF-16LE with possible BOM
            let mut start = 0;
            if body.len() >= 2 {
                if body[0] == 0xff && body[1] == 0xfe { start = 2; }
                else if body[0] == 0xfe && body[1] == 0xff {
                    // UTF-16BE BOM in a LE context - swap
                    let swapped: Vec<u8> = body.chunks(2).flat_map(|c| {
                        if c.len() == 2 { vec![c[1], c[0]] } else { c.to_vec() }
                    }).collect();
                    let s = String::from_utf16_lossy(
                        &swapped[start..].chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .collect::<Vec<u16>>()
                    );
                    return s.trim_end_matches('\0').trim().to_string();
                }
            }
            let u16s: Vec<u16> = body[start..].chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16s)
        }
        2 => {
            // UTF-16BE without BOM
            let u16s: Vec<u16> = body.chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16s)
        }
        3 => String::from_utf8_lossy(body).to_string(),
        _ => body.iter().map(|&b| b as char).collect(),
    };
    s.trim_end_matches('\0').trim().to_string()
}

struct Id3v2 {
    size: usize,
    tag: AudioTag,
}

fn parse_id3v2(buf: &[u8]) -> Option<Id3v2> {
    if buf.len() < 10 || &buf[0..3] != b"ID3" { return None; }
    let major = buf[3];
    let flags = buf[5];
    let declared = syncsafe(buf, 6) as usize;
    let footer = if flags & 0x10 != 0 { 10 } else { 0 };
    let size = 10 + declared + footer;
    if size > buf.len() { return None; }

    let body_ref: Vec<u8>;
    if flags & 0x80 != 0 {
        // Unsync
        let raw = &buf[10..10+declared];
        let mut un = Vec::with_capacity(raw.len());
        let mut r = 0;
        while r < raw.len() {
            un.push(raw[r]);
            if raw[r] == 0xff && r + 1 < raw.len() && raw[r+1] == 0x00 {
                r += 2;
            } else {
                r += 1;
            }
        }
        body_ref = un;
    } else {
        body_ref = buf[10..10+declared].to_vec();
    }

    let mut p = 0usize;
    // Extended header
    if flags & 0x40 != 0 && body_ref.len() >= 4 {
        if major >= 4 {
            p += syncsafe(&body_ref, 0) as usize;
        } else {
            p += read_u32_be(&body_ref, 0) as usize + 4;
        }
    }

    let mut tag = AudioTag::default();
    let hdr_len: usize = if major == 2 { 6 } else { 10 };

    while p + hdr_len <= body_ref.len() {
        let id: String = if major == 2 {
            if p + 3 > body_ref.len() { break; }
            String::from_utf8_lossy(&body_ref[p..p+3]).to_string()
        } else {
            if p + 4 > body_ref.len() { break; }
            String::from_utf8_lossy(&body_ref[p..p+4]).to_string()
        };
        if !id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) { break; }

        let frame_size: usize = if major == 2 {
            if p + 6 > body_ref.len() { break; }
            ((body_ref[p+3] as usize) << 16) | ((body_ref[p+4] as usize) << 8) | (body_ref[p+5] as usize)
        } else if major == 3 {
            if p + 8 > body_ref.len() { break; }
            read_u32_be(&body_ref, p + 4) as usize
        } else {
            if p + 8 > body_ref.len() { break; }
            syncsafe(&body_ref, p + 4) as usize
        };
        if frame_size == 0 || p + hdr_len + frame_size > body_ref.len() { break; }

        let data = &body_ref[p + hdr_len..p + hdr_len + frame_size];
        p += hdr_len + frame_size;

        let text = || decode_text(data);
        match id.as_str() {
            "TIT2" | "TT2" => tag.title = Some(text()).filter(|s: &String| !s.is_empty()),
            "TPE1" | "TP1" => tag.artist = Some(text()).filter(|s: &String| !s.is_empty()),
            "TALB" | "TAL" => tag.album = Some(text()).filter(|s: &String| !s.is_empty()),
            "TCON" | "TCO" => tag.genre = Some(text()).filter(|s: &String| !s.is_empty()),
            "TDRC" | "TYER" | "TYE" => {
                let y: String = text().chars().take(10).collect();
                tag.year = Some(y).filter(|s: &String| !s.is_empty());
            }
            "TRCK" | "TRK" => {
                let t = text();
                let parts: Vec<&str> = t.split('/').collect();
                if let Ok(n) = parts[0].parse::<u16>() { tag.track_no = Some(n); }
                if parts.len() > 1 {
                    if let Ok(n) = parts[1].parse::<u16>() { tag.track_total = Some(n); }
                }
            }
            "TPOS" | "TPA" => {
                let t = text();
                let parts: Vec<&str> = t.split('/').collect();
                if let Ok(n) = parts[0].parse::<u16>() { tag.disc_no = Some(n); }
            }
            "COMM" | "COM" => {
                if data.len() > 4 {
                    tag.comment = Some(decode_text(&data[4..])).filter(|s: &String| !s.is_empty());
                }
            }
            _ => {}
        }
    }

    Some(Id3v2 { size, tag })
}

fn parse_id3v1(buf: &[u8]) -> Option<AudioTag> {
    if buf.len() < 128 || &buf[0..3] != b"TAG" { return None; }
    let get = |start: usize, len: usize| -> Option<String> {
        let slice = &buf[start..start+len];
        let s: String = slice.iter().take_while(|&&b| b != 0).map(|&b| b as char).collect();
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    };
    let mut tag = AudioTag::default();
    tag.title = get(3, 30);
    tag.artist = get(33, 30);
    tag.album = get(63, 30);
    tag.year = get(93, 4);
    if buf[125] == 0 && buf[126] != 0 {
        tag.track_no = Some(buf[126] as u16);
        tag.comment = get(97, 28);
    } else {
        tag.comment = get(97, 30);
    }
    Some(tag)
}

fn merge_tags(a: &Option<AudioTag>, b: &Option<AudioTag>) -> AudioTag {
    let mut out = AudioTag::default();
    out.title = a.as_ref().and_then(|t| t.title.clone()).or_else(|| b.as_ref().and_then(|t| t.title.clone()));
    out.artist = a.as_ref().and_then(|t| t.artist.clone()).or_else(|| b.as_ref().and_then(|t| t.artist.clone()));
    out.album = a.as_ref().and_then(|t| t.album.clone()).or_else(|| b.as_ref().and_then(|t| t.album.clone()));
    out.genre = a.as_ref().and_then(|t| t.genre.clone()).or_else(|| b.as_ref().and_then(|t| t.genre.clone()));
    out.year = a.as_ref().and_then(|t| t.year.clone()).or_else(|| b.as_ref().and_then(|t| t.year.clone()));
    out.track_no = a.as_ref().and_then(|t| t.track_no).or_else(|| b.as_ref().and_then(|t| t.track_no));
    out.track_total = a.as_ref().and_then(|t| t.track_total).or_else(|| b.as_ref().and_then(|t| t.track_total));
    out.disc_no = a.as_ref().and_then(|t| t.disc_no).or_else(|| b.as_ref().and_then(|t| t.disc_no));
    out.comment = a.as_ref().and_then(|t| t.comment.clone()).or_else(|| b.as_ref().and_then(|t| t.comment.clone()));
    out
}

fn parse_mp3(buf: &[u8], name: &str) -> Result<AudioInfo, Box<dyn std::error::Error>> {
    let v2 = parse_id3v2(buf);
    let v2_size = v2.as_ref().map(|v| v.size).unwrap_or(0);
    let audio_start = v2_size;

    let mut p = audio_start;
    while p + 4 <= buf.len() {
        if buf[p] == 0xff && (buf[p+1] & 0xe0) == 0xe0 { break; }
        p += 1;
    }
    if p + 4 > buf.len() {
        return Err(Box::new(UnsupportedFormatError(format!("{}: no MPEG sync found", name))));
    }

    let h0 = &buf[p..p+4];
    let ver = (h0[1] >> 3) & 0x03;
    let layer = (h0[1] >> 1) & 0x03;
    let br_idx = (h0[2] >> 4) & 0x0f;
    let sr_idx = ((h0[2] >> 2) & 0x03) as usize;
    let padding = ((h0[2] >> 1) & 1) as u32;
    let channel_mode = (h0[3] >> 6) & 0x03;

    if layer != 1 {
        return Err(Box::new(UnsupportedFormatError(format!("{}: only Layer III supported", name))));
    }

    let version_name: u8 = match ver {
        3 => 1,
        2 => 2,
        0 => 3,
        _ => return Err(Box::new(UnsupportedFormatError(format!("{}: unknown MPEG version", name)))),
    };

    let bitrate = if version_name == 1 {
        BITRATE_V1_L3[br_idx as usize]
    } else {
        BITRATE_V2_L3[br_idx as usize]
    };
    if bitrate == 0 {
        return Err(Box::new(UnsupportedFormatError(format!("{}: invalid bitrate", name))));
    }

    let sample_rates: &[u32] = match ver {
        3 => &[44100, 48000, 32000],
        2 => &[22050, 24000, 16000],
        0 => &[11025, 12000, 8000],
        _ => &[44100],
    };
    let sample_rate = if sr_idx < sample_rates.len() { sample_rates[sr_idx] } else { 44100 };

    let _frame_size = if version_name == 1 {
        (144000 * bitrate / sample_rate) + padding
    } else {
        (72000 * bitrate / sample_rate) + padding
    };

    let has_v1 = buf.len() >= 128 && &buf[buf.len()-128..buf.len()-125] == b"TAG";
    let audio_end = if has_v1 { buf.len() - 128 } else { buf.len() };
    let audio_bytes = if audio_end > audio_start { (audio_end - audio_start) as u64 } else { 0 };

    let duration_ms = if bitrate > 0 {
        ((audio_bytes as f64 * 8.0) / (bitrate as f64 * 1000.0) * 1000.0).round() as u32
    } else {
        0
    };

    let channels: u16 = if channel_mode == 3 { 1 } else { 2 };

    let v1_tag = if has_v1 { parse_id3v1(&buf[buf.len()-128..]) } else { None };
    let v2_tag = v2.as_ref().map(|v| v.tag.clone());
    let tag = merge_tags(&v2_tag, &v1_tag);

    Ok(AudioInfo {
        container: "mp3".to_string(),
        filetype: FILE_TYPE_MP3,
        duration_ms,
        sample_rate,
        channels,
        bitrate: bitrate * 1000,
        audio_bytes,
        file_size: buf.len() as u64,
        tag,
    })
}
struct BoxInfo {
    start: usize,
    end: usize,
    body_start: usize,
    box_type: [u8; 4],
}

struct BoxIter<'a> {
    buf: &'a [u8],
    pos: usize,
    end: usize,
}

impl<'a> Iterator for BoxIter<'a> {
    type Item = BoxInfo;
    fn next(&mut self) -> Option<BoxInfo> {
        if self.pos + 8 > self.end { return None; }
        let sz = read_u32_be(self.buf, self.pos) as usize;
        let box_type = [self.buf[self.pos+4], self.buf[self.pos+5], self.buf[self.pos+6], self.buf[self.pos+7]];
        let end;
        let body_start;
        if sz == 1 && self.pos + 16 <= self.end {
            let hi = read_u32_be(self.buf, self.pos + 8) as u64;
            let lo = read_u32_be(self.buf, self.pos + 12) as u64;
            let sz64 = (hi << 32) | lo;
            end = self.pos + sz64.min((self.end - self.pos) as u64) as usize;
            body_start = self.pos + 16;
        } else if sz == 0 {
            end = self.end;
            body_start = self.pos + 8;
        } else {
            end = self.pos + sz.min(self.end - self.pos);
            body_start = self.pos + 8;
        }
        if end <= self.pos { return None; }
        let info = BoxInfo { start: self.pos, end, body_start, box_type };
        self.pos = end;
        Some(info)
    }
}

fn boxes_iter<'a>(buf: &'a [u8], start: usize, end: usize) -> BoxIter<'a> {
    BoxIter { buf, pos: start, end }
}

fn find_box(buf: &[u8], start: usize, end: usize, path: &[&str]) -> Option<BoxInfo> {
    if path.is_empty() { return None; }
    for b in boxes_iter(buf, start, end) {
        let t = String::from_utf8_lossy(&b.box_type).to_string();
        if t == path[0] {
            if path.len() == 1 { return Some(b); }
            if t == "meta" {
                return find_box(buf, b.body_start + 4, b.end, &path[1..]);
            }
            return find_box(buf, b.body_start, b.end, &path[1..]);
        }
    }
    None
}

#[allow(unused_assignments)]
fn parse_m4a(buf: &[u8], name: &str) -> Result<AudioInfo, Box<dyn std::error::Error>> {
    let moov = find_box(buf, 0, buf.len(), &["moov"])
        .ok_or_else(|| Box::new(UnsupportedFormatError(format!("{}: no moov box", name))))?;

    let mvhd = find_box(buf, moov.body_start, moov.end, &["mvhd"]);
    let mut duration_ms: u32 = 0;
    let mut timescale: u32 = 44100;

    if let Some(mvhd) = mvhd {
        let s = mvhd.body_start;
        let ver = buf[s];
        if ver == 0 && s + 24 <= mvhd.end {
            timescale = read_u32_be(buf, s + 12);
            let dur = read_u32_be(buf, s + 16) as f64;
            if timescale > 0 {
                duration_ms = ((dur / timescale as f64) * 1000.0).round() as u32;
            }
        } else if s + 32 <= mvhd.end {
            timescale = read_u32_be(buf, s + 20);
            let dur = read_u32_be(buf, s + 24) as f64;
            if timescale > 0 {
                duration_ms = ((dur / timescale as f64) * 1000.0).round() as u32;
            }
        }
    }

    let mdhd = find_box(buf, moov.body_start, moov.end, &["trak", "mdia", "mdhd"]);
    if let Some(mdhd) = mdhd {
        let s = mdhd.body_start;
        let ver = buf[s];
        if ver == 0 && s + 24 <= mdhd.end {
            let ts = read_u32_be(buf, s + 12);
            let dur = read_u32_be(buf, s + 16) as f64;
            if ts > 0 {
                duration_ms = ((dur / ts as f64) * 1000.0).round() as u32;
            }
            timescale = ts;
        }
    }

    let mut sample_rate = 0u32;
    let mut channels: u16 = 2;
    let stsd = find_box(buf, moov.body_start, moov.end, &["trak", "mdia", "minf", "stbl", "stsd"]);
    if let Some(stsd) = stsd {
        for e in boxes_iter(buf, stsd.body_start + 8, stsd.end) {
            if e.end - e.start < 36 { continue; }
            channels = read_u16_be(buf, e.start + 24);
            sample_rate = read_u32_be(buf, e.start + 32) >> 16;
            break;
        }
    }

    let mut tag = AudioTag::default();
    let ilst = find_box(buf, moov.body_start, moov.end, &["udta", "meta", "ilst"]);
    if let Some(ilst) = ilst {
        for item in boxes_iter(buf, ilst.body_start, ilst.end) {
            let item_type = String::from_utf8_lossy(&item.box_type).to_string();
            let data_box = boxes_iter(buf, item.body_start, item.end)
                .find(|b| &b.box_type == b"data");
            if let Some(data_box) = data_box {
                let payload_at = data_box.body_start + 8;
                if payload_at > data_box.end { continue; }
                let payload = &buf[payload_at..data_box.end];
                let text = || -> String {
                    String::from_utf8_lossy(payload).trim_end_matches('\0').trim().to_string()
                };
                match item_type.as_str() {
                    "\u{00a9}nam" => tag.title = Some(text()).filter(|s: &String| !s.is_empty()),
                    "\u{00a9}ART" => tag.artist = Some(text()).filter(|s: &String| !s.is_empty()),
                    "aART" => {
                        if tag.artist.is_none() {
                            let a = text();
                            if !a.is_empty() { tag.artist = Some(a); }
                        }
                    }
                    "\u{00a9}alb" => tag.album = Some(text()).filter(|s: &String| !s.is_empty()),
                    "\u{00a9}gen" => tag.genre = Some(text()).filter(|s: &String| !s.is_empty()),
                    "\u{00a9}day" => {
                        let y: String = text().chars().take(10).collect();
                        tag.year = Some(y).filter(|s: &String| !s.is_empty());
                    }
                    "\u{00a9}cmt" => tag.comment = Some(text()).filter(|s: &String| !s.is_empty()),
                    "trkn" => {
                        if payload.len() >= 6 {
                            let n = u16::from_be_bytes([payload[2], payload[3]]);
                            let total = u16::from_be_bytes([payload[4], payload[5]]);
                            if n > 0 { tag.track_no = Some(n); }
                            if total > 0 { tag.track_total = Some(total); }
                        }
                    }
                    "disk" => {
                        if payload.len() >= 4 {
                            let n = u16::from_be_bytes([payload[2], payload[3]]);
                            if n > 0 { tag.disc_no = Some(n); }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let mdat = find_box(buf, 0, buf.len(), &["mdat"]);
    let audio_bytes = if let Some(mdat) = mdat {
        (mdat.end - mdat.start).saturating_sub(8) as u64
    } else {
        buf.len() as u64
    };

    let seconds = duration_ms as f64 / 1000.0;
    let bitrate = if seconds > 0.0 {
        ((audio_bytes as f64 * 8.0) / seconds).round() as u32
    } else {
        0
    };

    Ok(AudioInfo {
        container: "m4a".to_string(),
        filetype: FILE_TYPE_AAC,
        duration_ms,
        sample_rate: if sample_rate > 0 { sample_rate } else { 44100 },
        channels: if channels > 0 { channels } else { 2 },
        bitrate,
        audio_bytes,
        file_size: buf.len() as u64,
        tag,
    })
}

pub fn read_tags(abs_path: &Path) -> AudioTag {
    let data = match fs::read(abs_path) {
        Ok(d) => d,
        Err(_) => return AudioTag::default(),
    };

    if data.len() >= 8 && &data[4..8] == b"ftyp" {
        return parse_m4a(&data, &abs_path.to_string_lossy())
            .map(|i| i.tag)
            .unwrap_or_default();
    }

    let v2 = parse_id3v2(&data);
    if let Some(ref v2r) = v2 {
        if v2r.tag.title.is_some() || v2r.tag.artist.is_some() || v2r.tag.album.is_some() {
            return v2r.tag.clone();
        }
    }

    let v1 = if data.len() >= 128 {
        parse_id3v1(&data[data.len()-128..])
    } else {
        None
    };

    let v2_tag = v2.as_ref().map(|v| v.tag.clone());
    merge_tags(&v2_tag, &v1)
}

#[allow(dead_code)]
pub fn format_duration(ms: u32) -> String {
    if ms == 0 { return "--:--".to_string(); }
    let total = (ms as f64 / 1000.0).round() as u32;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{}:{:02}", m, s)
    }
}