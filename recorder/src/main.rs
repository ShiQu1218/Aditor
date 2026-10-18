//! apexrec：Apex Highlighter 原生錄影核心。由 Electron 主程序以 JSON-lines 驅動（規格
//! `docs/superpowers/specs/2026-10-18-live-recording-design.md`）。

#![allow(dead_code)] // 骨架期間各模組尚未接線；整合任務 C 移除

mod audio;
mod capture;
mod clock;
mod encode;
mod gpu;
mod index;
mod ipc;
mod protocol;
mod session;
mod shm;
mod types;

fn main() {
    let events = ipc::EventSink::new(Box::new(std::io::stdout()));
    let mut backend = session::Recorder;
    ipc::run(std::io::stdin().lock(), events, &mut backend);
}
