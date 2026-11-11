//! aditorrec: Aditor native recording core. Driven by the Electron main process over JSON-lines (spec
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

fn main() {
    if let Err(error) = encode::check_version() {
        eprintln!("internal: {error:#}");
        std::process::exit(1);
    }
    // SAFETY: Adjusts the scheduling priority of this process only; it does not open the game or any other process.
    unsafe {
        use windows::Win32::System::Threading::{
            GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS,
        };
        if let Err(error) = SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS) {
            eprintln!("Failed to set recorder process priority: {error}");
        }
    }
    encode::init_logging();
    let events = ipc::EventSink::new(Box::new(std::io::stdout()));
    let mut backend = session::Recorder;
    ipc::run(std::io::stdin().lock(), events, &mut backend);
}
