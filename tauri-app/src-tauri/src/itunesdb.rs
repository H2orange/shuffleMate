use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DbEntry {
    pub title: String,
    pub album: String,
    pub artist: String,
    pub genre: String,
}

const MHOD_TITLE: u32 = 1;
const MHOD_PATH: u32 = 2;
const MHOD_ALBUM: u32 = 3;
const MHOD_ARTIST: u32 = 4;
const MHOD_GENRE: u32 = 5;

fn rd_u32_le(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]])
}

pub fn read_itunes_db(ipod_root: &str) -> HashMap<String, DbEntry> {
    let mut out = HashMap::new();
    let file = Path::new(ipod_root).join("iPod_Control").join("iTunes").join("iTunesDB");
    let db = match fs::read(&file) {
        Ok(d) => d,
        Err(_) => return out,
    };

    let _result = (|| -> Option<()> {
        // Find mhlt
        let i = db.windows(4).position(|w| w == b"mhlt")?;
        if i + 12 > db.len() { return None; }
        let hl = rd_u32_le(&db, i + 4) as usize;
        let n = rd_u32_le(&db, i + 8) as usize;

        let mut q = i + hl;
        for _t in 0..n {
            if q + 16 > db.len() { break; }
            if &db[q..q+4] != b"mhit" { break; }
            let mhit_header_len = rd_u32_le(&db, q + 4) as usize;
            let mhit_total_len = rd_u32_le(&db, q + 8) as usize;
            let n_hod = rd_u32_le(&db, q + 12) as usize;

            let mut fields: HashMap<u32, String> = HashMap::new();
            let mut c = q + mhit_header_len;
            for _h in 0..n_hod {
                if c + 16 > db.len() || &db[c..c+4] != b"mhod" { break; }
                let hod_header_len = rd_u32_le(&db, c + 4) as usize;
                let hod_total_len = rd_u32_le(&db, c + 8) as usize;
                if hod_total_len == 0 { break; }
                let mhod_type = rd_u32_le(&db, c + 12);
                let str_len_at = c + hod_header_len + 4;
                let data_at = c + hod_header_len + 16;
                if str_len_at + 4 <= db.len() && data_at <= db.len() {
                    let str_len = rd_u32_le(&db, str_len_at) as usize;
                    let end = (data_at + str_len).min(db.len());
                    if end > data_at {
                        // UTF-16LE decode
                        let raw = &db[data_at..end];
                        let u16s: Vec<u16> = raw.chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .collect();
                        let s = String::from_utf16_lossy(&u16s);
                        fields.insert(mhod_type, s);
                    }
                }
                c += hod_total_len;
            }

            let raw_path = fields.get(&MHOD_PATH).cloned().unwrap_or_default()
                .replace(':', "/");
            if !raw_path.is_empty() {
                let key = raw_path.trim_start_matches('/').to_string();
                out.insert(key, DbEntry {
                    title: fields.get(&MHOD_TITLE).cloned().unwrap_or_default(),
                    album: fields.get(&MHOD_ALBUM).cloned().unwrap_or_default(),
                    artist: fields.get(&MHOD_ARTIST).cloned().unwrap_or_default(),
                    genre: fields.get(&MHOD_GENRE).cloned().unwrap_or_default(),
                });
            }

            if mhit_total_len == 0 { break; }
            q += mhit_total_len;
        }
        Some(())
    })();

    out
}