use crate::types::*;

pub const TRACK_RECORD_SIZE: usize = 372;
pub const ROOT_HEADER_SIZE: usize = 64;
pub const TRACK_HEADER_SIZE: usize = 20;
pub const PLAYLIST_RECORD_HEADER: usize = 44;
pub const PLAYLIST_HEADER_PREFIX: usize = 68;

const MAGIC_ROOT: &[u8; 4] = b"bdhs";
const MAGIC_TRACK_HEADER: &[u8; 4] = b"hths";
const MAGIC_TRACK: &[u8; 4] = b"rths";
const MAGIC_PLAYLIST_HEADER: &[u8; 4] = b"hphs";
const MAGIC_PLAYLIST: &[u8; 4] = b"lphs";

fn check_magic(data: &[u8], offset: usize, expected: &[u8; 4]) -> Result<(), String> {
    if offset + 4 > data.len() {
        return Err(format!("iTunesSD: offset {} out of bounds (len={})", offset, data.len()));
    }
    if &data[offset..offset+4] != expected {
        let got = String::from_utf8_lossy(&data[offset..offset+4]);
        let exp = String::from_utf8_lossy(expected);
        return Err(format!("iTunesSD: expected '{}' at offset {}, got '{}'", exp, offset, got));
    }
    Ok(())
}

fn rd_u16_le(data: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([data[off], data[off+1]])
}
fn rd_u32_le(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]])
}
fn rd_u64_le(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3],
                         data[off+4], data[off+5], data[off+6], data[off+7]])
}

fn read_utf16le_string(data: &[u8], off: usize, max_bytes: usize) -> String {
    let end = (off + max_bytes).min(data.len());
    let raw = &data[off..end];
    let u16s: Vec<u16> = raw.chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&c| c != 0)
        .collect();
    String::from_utf16_lossy(&u16s)
}

fn write_utf16le(buf: &mut [u8], off: usize, max_bytes: usize, s: &str) {
    let u16s: Vec<u16> = s.encode_utf16().collect();
    let max_chars = max_bytes / 2;
    let chars_to_write = u16s.len().min(max_chars.saturating_sub(1));
    for i in 0..chars_to_write {
        let bytes = u16s[i].to_le_bytes();
        buf[off + i * 2] = bytes[0];
        buf[off + i * 2 + 1] = bytes[1];
    }
}

pub fn parse_sd(data: &[u8]) -> Result<SdModel, String> {
    if data.len() < ROOT_HEADER_SIZE {
        return Err(format!("iTunesSD too short: {} bytes", data.len()));
    }
    check_magic(data, 0, MAGIC_ROOT)?;

    let mut tail = [0u8; 20];
    tail.copy_from_slice(&data[0x2c..0x40]);

    let root = SdRoot {
        version: rd_u32_le(data, 0x04),
        total_len: rd_u32_le(data, 0x08),
        n_tracks: rd_u32_le(data, 0x0c),
        n_playlists: rd_u32_le(data, 0x10),
        unk_q: rd_u64_le(data, 0x14),
        max_volume: data[0x1c],
        voiceover: data[0x1d],
        unk_h: rd_u16_le(data, 0x1e),
        tracks_wo_podcasts: rd_u32_le(data, 0x20),
        track_header_offset: rd_u32_le(data, 0x24),
        playlist_header_offset: rd_u32_le(data, 0x28),
        tail,
    };

    let trk_off = root.track_header_offset as usize;
    check_magic(data, trk_off, MAGIC_TRACK_HEADER)?;
    let th_n = rd_u32_le(data, trk_off + 0x08) as usize;

    let mut offsets = Vec::with_capacity(th_n);
    for i in 0..th_n {
        let p = trk_off + TRACK_HEADER_SIZE + i * 4;
        if p + 4 > data.len() {
            return Err("iTunesSD: track offset table out of bounds".to_string());
        }
        offsets.push(rd_u32_le(data, p) as usize);
    }

    let mut tracks = Vec::with_capacity(th_n);
    for &o in &offsets {
        if o + TRACK_RECORD_SIZE > data.len() {
            return Err(format!("iTunesSD: track record out of bounds at offset {}", o));
        }
        tracks.push(parse_track(&data[o..o + TRACK_RECORD_SIZE])?);
    }

    let pl_off = root.playlist_header_offset as usize;
    check_magic(data, pl_off, MAGIC_PLAYLIST_HEADER)?;
    let pl_count = rd_u32_le(data, pl_off + 0x08) as usize;
    let header_size = PLAYLIST_HEADER_PREFIX + pl_count * 4;
    let playlist_header = data[pl_off..pl_off + header_size].to_vec();

    let mut playlists = Vec::new();
    for k in 0..pl_count {
        let slot = pl_off + PLAYLIST_HEADER_PREFIX + k * 4;
        if slot + 4 > data.len() { break; }
        let lo = rd_u32_le(data, slot) as usize;
        if lo == 0 { continue; }
        playlists.push(parse_playlist(data, lo)?);
    }

    Ok(SdModel { root, tracks, playlist_header, playlists })
}

fn parse_track(r: &[u8]) -> Result<TrackRecord, String> {
    check_magic(r, 0, MAGIC_TRACK)?;

    let filename = read_utf16le_string(r, 0x18, 512);

    let mut dbid = [0u8; 8];
    dbid.copy_from_slice(&r[0x148..0x150]);

    let mut tail = [0u8; 32];
    tail.copy_from_slice(&r[0x154..0x174]);

    Ok(TrackRecord {
        header_length: rd_u32_le(r, 0x04),
        start_ms: rd_u32_le(r, 0x08),
        stop_ms: rd_u32_le(r, 0x0c),
        volume_gain: rd_u32_le(r, 0x10),
        filetype: rd_u32_le(r, 0x14),
        filename,
        bookmark: rd_u32_le(r, 0x118),
        dontskip: r[0x11c],
        remember: r[0x11d],
        unintalbum: r[0x11e],
        unknown_byte: r[0x11f],
        pregap: rd_u32_le(r, 0x120),
        postgap: rd_u32_le(r, 0x124),
        numsamples: rd_u32_le(r, 0x128),
        unk12c: rd_u32_le(r, 0x12c),
        audio_bytes: rd_u32_le(r, 0x130),
        unk134: rd_u32_le(r, 0x134),
        albumid: rd_u32_le(r, 0x138),
        track_no: rd_u16_le(r, 0x13c),
        disc: rd_u16_le(r, 0x13e),
        unk140: rd_u64_le(r, 0x140),
        dbid,
        artistid: rd_u32_le(r, 0x150),
        tail,
    })
}

fn parse_playlist(data: &[u8], off: usize) -> Result<PlaylistRecord, String> {
    if off + PLAYLIST_RECORD_HEADER > data.len() {
        return Err("iTunesSD: playlist record out of bounds".to_string());
    }
    check_magic(data, off, MAGIC_PLAYLIST)?;

    let total_length = rd_u32_le(data, off + 0x04);
    let n_songs = rd_u32_le(data, off + 0x08);
    let n_nonaudio = rd_u32_le(data, off + 0x0c);
    let mut dbid = [0u8; 8];
    dbid.copy_from_slice(&data[off + 0x10..off + 0x18]);
    let listtype = rd_u32_le(data, off + 0x18);
    let header_end = off + PLAYLIST_RECORD_HEADER;
    let header = data[off..header_end].to_vec();

    let mut members = Vec::with_capacity(n_songs as usize);
    for i in 0..n_songs as usize {
        let p = header_end + i * 4;
        if p + 4 > data.len() { break; }
        members.push(rd_u32_le(data, p));
    }

    Ok(PlaylistRecord { header, total_length, n_songs, n_nonaudio, dbid, listtype, members })
}

fn build_track_header(total_size: u32, n_tracks: u32) -> Vec<u8> {
    let mut h = vec![0u8; TRACK_HEADER_SIZE];
    h[0..4].copy_from_slice(MAGIC_TRACK_HEADER);
    h[4..8].copy_from_slice(&total_size.to_le_bytes());
    h[8..12].copy_from_slice(&n_tracks.to_le_bytes());
    h
}

fn write_track(t: &TrackRecord) -> Vec<u8> {
    let mut buf = vec![0u8; TRACK_RECORD_SIZE];
    buf[0..4].copy_from_slice(MAGIC_TRACK);
    buf[0x04..0x08].copy_from_slice(&t.header_length.to_le_bytes());
    buf[0x08..0x0c].copy_from_slice(&t.start_ms.to_le_bytes());
    buf[0x0c..0x10].copy_from_slice(&t.stop_ms.to_le_bytes());
    buf[0x10..0x14].copy_from_slice(&t.volume_gain.to_le_bytes());
    buf[0x14..0x18].copy_from_slice(&t.filetype.to_le_bytes());
    write_utf16le(&mut buf, 0x18, 512, &t.filename);
    buf[0x118..0x11c].copy_from_slice(&t.bookmark.to_le_bytes());
    buf[0x11c] = t.dontskip;
    buf[0x11d] = t.remember;
    buf[0x11e] = t.unintalbum;
    buf[0x11f] = t.unknown_byte;
    buf[0x120..0x124].copy_from_slice(&t.pregap.to_le_bytes());
    buf[0x124..0x128].copy_from_slice(&t.postgap.to_le_bytes());
    buf[0x128..0x12c].copy_from_slice(&t.numsamples.to_le_bytes());
    buf[0x12c..0x130].copy_from_slice(&t.unk12c.to_le_bytes());
    buf[0x130..0x134].copy_from_slice(&t.audio_bytes.to_le_bytes());
    buf[0x134..0x138].copy_from_slice(&t.unk134.to_le_bytes());
    buf[0x138..0x13c].copy_from_slice(&t.albumid.to_le_bytes());
    buf[0x13c..0x13e].copy_from_slice(&t.track_no.to_le_bytes());
    buf[0x13e..0x140].copy_from_slice(&t.disc.to_le_bytes());
    buf[0x140..0x148].copy_from_slice(&t.unk140.to_le_bytes());
    buf[0x148..0x150].copy_from_slice(&t.dbid);
    buf[0x150..0x154].copy_from_slice(&t.artistid.to_le_bytes());
    buf[0x154..0x174].copy_from_slice(&t.tail);
    buf
}

pub fn build_sd(model: &SdModel) -> Vec<u8> {
    let n = model.tracks.len();
    let mut out = vec![0u8; ROOT_HEADER_SIZE];
    out[0..4].copy_from_slice(MAGIC_ROOT);
    out[0x04..0x08].copy_from_slice(&model.root.version.to_le_bytes());
    out[0x0c..0x10].copy_from_slice(&(n as u32).to_le_bytes());
    out[0x10..0x14].copy_from_slice(&model.root.n_playlists.to_le_bytes());
    out[0x14..0x1c].copy_from_slice(&model.root.unk_q.to_le_bytes());
    out[0x1c] = model.root.max_volume;
    out[0x1d] = if model.root.voiceover != 0 { 1 } else { 0 };
    out[0x1e..0x20].copy_from_slice(&0u16.to_le_bytes());
    out[0x20..0x24].copy_from_slice(&(n as u32).to_le_bytes());
    out[0x2c..0x40].copy_from_slice(&model.root.tail);

    let th_size = TRACK_HEADER_SIZE + n * 4;
    let mut offsets_buf = vec![0u8; n * 4];
    let mut track_hunks = Vec::new();
    let mut cursor = ROOT_HEADER_SIZE + th_size;
    for i in 0..n {
        offsets_buf[i*4..i*4+4].copy_from_slice(&(cursor as u32).to_le_bytes());
        track_hunks.push(write_track(&model.tracks[i]));
        cursor += TRACK_RECORD_SIZE;
    }

    let th_header = build_track_header(th_size as u32, n as u32);
    let mut trk = Vec::new();
    trk.extend_from_slice(&th_header);
    trk.extend_from_slice(&offsets_buf);
    for h in &track_hunks {
        trk.extend_from_slice(h);
    }

    let mut ph = model.playlist_header.clone();
    let ph_len = ph.len();
    if ph_len >= 12 {
        ph[0x04..0x08].copy_from_slice(&(ph_len as u32).to_le_bytes());
        ph[0x08..0x0c].copy_from_slice(&(model.playlists.len() as u32).to_le_bytes());
    }
    let first_lphs = ROOT_HEADER_SIZE + trk.len() + ph_len;
    let pl_count_in_header = model.playlists.len().min((ph_len.saturating_sub(PLAYLIST_HEADER_PREFIX)) / 4);
    for k in 0..pl_count_in_header {
        let slot = PLAYLIST_HEADER_PREFIX + k * 4;
        if slot + 4 > ph_len { break; }
        let val = if k == 0 { first_lphs as u32 } else { 0u32 };
        ph[slot..slot+4].copy_from_slice(&val.to_le_bytes());
    }

    out[0x24..0x28].copy_from_slice(&(ROOT_HEADER_SIZE as u32).to_le_bytes());
    out[0x28..0x2c].copy_from_slice(&((ROOT_HEADER_SIZE + trk.len()) as u32).to_le_bytes());

    let mut pl_parts = Vec::new();
    for p in &model.playlists {
        let mut h = p.header.clone();
        if h.len() >= PLAYLIST_RECORD_HEADER {
            let rec_len = (PLAYLIST_RECORD_HEADER + p.n_songs as usize * 4) as u32;
            h[0x04..0x08].copy_from_slice(&rec_len.to_le_bytes());
            h[0x08..0x0c].copy_from_slice(&p.n_songs.to_le_bytes());
            h[0x0c..0x10].copy_from_slice(&p.n_nonaudio.to_le_bytes());
        }
        let mut mem = Vec::with_capacity(p.members.len() * 4);
        for &m in &p.members {
            mem.extend_from_slice(&m.to_le_bytes());
        }
        pl_parts.push(h);
        pl_parts.push(mem);
    }

    let mut result = Vec::new();
    result.extend_from_slice(&out);
    result.extend_from_slice(&trk);
    result.extend_from_slice(&ph);
    for part in &pl_parts {
        result.extend_from_slice(part);
    }

    let total_len = result.len() as u32;
    result[0x08..0x0c].copy_from_slice(&total_len.to_le_bytes());
    result
}

pub fn make_track_record(
    filename: &str,
    filetype: u32,
    duration_ms: u32,
    sample_rate: u32,
    audio_bytes: u32,
    dbid: [u8; 8],
    pregap: u32,
    albumid: u32,
    artistid: u32,
    track_no: u16,
    disc: u16,
    volume_gain: u32,
) -> TrackRecord {
    let duration_secs = duration_ms as f64 / 1000.0;
    TrackRecord {
        header_length: TRACK_RECORD_SIZE as u32,
        start_ms: 0,
        stop_ms: duration_ms,
        volume_gain,
        filetype,
        filename: filename.to_string(),
        bookmark: 0,
        dontskip: 1,
        remember: 0,
        unintalbum: 0,
        unknown_byte: 0,
        pregap,
        postgap: 0,
        numsamples: (duration_secs * sample_rate as f64).round() as u32,
        unk12c: 0,
        audio_bytes,
        unk134: 0,
        albumid,
        track_no,
        disc,
        unk140: 0,
        dbid,
        artistid,
        tail: [0u8; 32],
    }
}

pub fn with_tracks(template: &SdModel, tracks: Vec<TrackRecord>, max_volume: Option<u8>) -> SdModel {
    let mv = max_volume.unwrap_or(template.root.max_volume);
    let master = template.playlists.first();
    let header = if let Some(m) = master {
        m.header.clone()
    } else {
        let mut h = vec![0u8; PLAYLIST_RECORD_HEADER];
        h[0..4].copy_from_slice(MAGIC_PLAYLIST);
        h
    };
    let listtype = master.map(|m| m.listtype).unwrap_or(1);
    let n = tracks.len() as u32;
    let members: Vec<u32> = (0..n).collect();

    let playlists = vec![PlaylistRecord {
        header,
        total_length: (PLAYLIST_RECORD_HEADER + tracks.len() * 4) as u32,
        n_songs: n,
        n_nonaudio: n,
        dbid: [0u8; 8],
        listtype,
        members,
    }];

    SdModel {
        root: SdRoot {
            n_tracks: n,
            n_playlists: 1,
            max_volume: mv,
            ..template.root.clone()
        },
        tracks,
        playlist_header: template.playlist_header.clone(),
        playlists,
    }
}

pub fn round_trips(sd_path: &std::path::Path) -> bool {
    let raw = match std::fs::read(sd_path) {
        Ok(d) => d,
        Err(_) => return false,
    };
    match parse_sd(&raw) {
        Ok(model) => build_sd(&model) == raw,
        Err(_) => false,
    }
}
