use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

pub const COPY_CHUNK: usize = 1 << 20;

pub fn ensure_dir(dir: &str) -> io::Result<()> {
    fs::create_dir_all(dir)
}

pub fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

pub fn to_posix(p: &str) -> String {
    p.replace("\\", "/")
}

pub fn assert_inside(child: &str, root: &str) -> Result<(), String> {
    let c = to_posix(&fs::canonicalize(child).unwrap_or_else(|_| std::path::PathBuf::from(child)).to_string_lossy());
    let r_path = fs::canonicalize(root).unwrap_or_else(|_| std::path::PathBuf::from(root));
    let r = to_posix(&r_path.to_string_lossy());
    let r = r.trim_end_matches('/');
    if c != r && !c.starts_with(&format!("{}/", r)) {
        return Err(format!("Path out of bounds: {} not inside {}", c, r));
    }
    Ok(())
}

pub fn atomic_write_file(file: &str, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = Path::new(file).parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = format!("{}.tmp", file);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, file)?;
    flush_file(file);
    Ok(())
}

pub fn flush_file(file: &str) -> bool {
    match fs::OpenOptions::new().read(true).write(true).open(file) {
        Ok(f) => { let _ = f.sync_all(); true }
        Err(_) => false,
    }
}

pub fn flush_volume(drive_letter: &str) -> bool {
    let letter = drive_letter.trim_end_matches(':');
    let dev = format!("\\\\.\\{}:", letter);
    match fs::OpenOptions::new().read(true).write(true).open(&dev) {
        Ok(f) => { let _ = f.sync_all(); true }
        Err(_) => false,
    }
}

pub fn copy_file_sync(src: &str, dst: &str, _on_progress: Option<&dyn Fn(u64, u64)>) -> io::Result<u64> {
    let _total = fs::metadata(src)?.len();
    if let Some(parent) = Path::new(dst).parent() {
        fs::create_dir_all(parent)?;
    }
    let mut rf = fs::File::open(src)?;
    let mut wf = fs::File::create(dst)?;
    let mut buf = vec![0u8; COPY_CHUNK];
    let mut copied: u64 = 0;
    loop {
        let n = rf.read(&mut buf)?;
        if n == 0 { break; }
        wf.write_all(&buf[..n])?;
        copied += n as u64;
    }
    wf.sync_all()?;
    Ok(copied)
}

pub fn remove_file_safe(file: &str, allowed_root: &str) -> Result<(), String> {
    assert_inside(file, allowed_root)?;
    if !exists(file) { return Ok(()); }
    #[cfg(windows)]
    {
        if let Ok(meta) = fs::metadata(file) {
            use std::os::windows::fs::MetadataExt;
            let attrs = meta.file_attributes();
            if attrs & 0x01 != 0 {
                let _ = std::process::Command::new("attrib")
                    .args(["-R", file])
                    .output();
            }
        }
    }
    fs::remove_file(file).map_err(|e| format!("Failed to remove {}: {}", file, e))
}

pub fn backup_file(file: &Path, backups_root: &str, label: &str, rel_hint: Option<&str>) -> io::Result<String> {
    let ts = timestamp();
    let dir = Path::new(backups_root).join(format!("{}-{}", ts, label));
    fs::create_dir_all(&dir)?;
    let file_str = file.to_string_lossy().to_string();
    let flat = rel_hint.unwrap_or_else(|| {
        Path::new(&file_str).file_name().and_then(|n| n.to_str()).unwrap_or("unknown")
    }).replace(['\\', '/'], "__");
    let dst = dir.join(&flat);
    fs::copy(&file_str, &dst)?;
    flush_file(&dst.to_string_lossy());
    Ok(to_posix(&dst.to_string_lossy()))
}

fn timestamp() -> String {
    let now = chrono::Local::now();
    now.format("%Y%m%d-%H%M%S").to_string()
}

#[allow(dead_code)]
pub fn dir_size(dir: &str) -> u64 {
    let mut total = 0u64;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() {
                total += dir_size(&p.to_string_lossy());
            } else if let Ok(meta) = fs::metadata(&p) {
                total += meta.len();
            }
        }
    }
    total
}