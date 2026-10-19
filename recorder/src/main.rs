//! apexrec：Apex Highlighter 原生錄影核心。由 Electron 主程序以 JSON-lines 驅動（規格
//! `docs/superpowers/specs/2026-10-18-live-recording-design.md`）。

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

unsafe extern "C" {
    fn av_log_set_level(level: i32);
}

fn main() {
    if let Err(error) = encode::check_version() {
        eprintln!("internal: {error:#}");
        std::process::exit(1);
    }
    // SAFETY: 僅調整目前程序的排程優先序，不開啟遊戲或其他程序。
    unsafe {
        use windows::Win32::System::Threading::{
            GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS,
        };
        if let Err(error) = SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS) {
            eprintln!("設定錄影程序優先序失敗：{error}");
        }
        // libavutil/log.h：AV_LOG_QUIET = -8；錯誤由各模組的 Result 回報。
        av_log_set_level(-8);
    }
    let events = ipc::EventSink::new(Box::new(std::io::stdout()));
    let mut backend = session::Recorder;
    ipc::run(std::io::stdin().lock(), events, &mut backend);
}
