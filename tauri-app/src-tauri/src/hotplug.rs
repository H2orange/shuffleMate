use tauri::Emitter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ObserveResult {
    pub changed: bool,
    pub root: Option<String>,
}

pub struct StableDetector {
    current: Option<String>,
    candidate: Option<String>,
    ticks: usize,
    confirm_ticks: usize,
}

impl StableDetector {
    pub fn new(initial: Option<String>, confirm_ticks: usize) -> Self {
        StableDetector {
            current: initial,
            candidate: None,
            ticks: 0,
            confirm_ticks: confirm_ticks.max(1),
        }
    }

    #[allow(dead_code)]
    pub fn value(&self) -> Option<&str> {
        self.current.as_deref()
    }

    pub fn observe(&mut self, now: Option<String>) -> ObserveResult {
        if now == self.current {
            self.candidate = None;
            self.ticks = 0;
            return ObserveResult { changed: false, root: self.current.clone() };
        }
        if now == self.candidate {
            self.ticks += 1;
        } else {
            self.candidate = now.clone();
            self.ticks = 1;
        }
        if self.ticks < self.confirm_ticks {
            return ObserveResult { changed: false, root: self.current.clone() };
        }
        self.current = now;
        self.candidate = None;
        self.ticks = 0;
        ObserveResult { changed: true, root: self.current.clone() }
    }
}

pub fn start_hotplug_watch(
    app: tauri::AppHandle,
    running: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    let initial = crate::device::find_ipod_roots().into_iter().next();
    let mut detector = StableDetector::new(initial, 2);

    std::thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            if !running.load(Ordering::Relaxed) { break; }

            let now = crate::device::find_ipod_roots().into_iter().next();
            let result = detector.observe(now);
            if result.changed {
                let msg = if let Some(ref root) = result.root {
                    format!("[hotplug] Device connected: {}", root)
                } else {
                    "[hotplug] Device disconnected".to_string()
                };
                eprintln!("{}", msg);
                let _ = app.emit("device:changed", serde_json::json!({ "root": result.root }));
            }
        }
    })
}