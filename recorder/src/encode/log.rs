//! Retain FFmpeg errors on the calling thread without writing them to stderr.
use std::{
    cell::RefCell,
    ffi::{c_char, c_void},
};

use super::ffi::{av_log_format_line2, av_log_set_callback, av_log_set_level};

thread_local! {
    static LAST_ERROR: RefCell<Option<String>> = const { RefCell::new(None) };
}

pub(crate) fn init_logging() {
    // SAFETY: The callback has process lifetime and matches the Windows x64 va_list ABI.
    unsafe {
        av_log_set_callback(Some(capture_log));
        av_log_set_level(16);
    }
}

fn sanitize(message: &[u8]) -> String {
    let printable: String = message
        .iter()
        .copied()
        .filter(|byte| (b' '..=b'~').contains(byte))
        .map(char::from)
        .collect();
    printable.trim().chars().take(200).collect()
}

unsafe extern "C" fn capture_log(
    ptr: *mut c_void,
    level: i32,
    fmt: *const c_char,
    args: *mut c_void,
) {
    if level > 16 || fmt.is_null() {
        return;
    }
    let mut buffer = [0u8; 1024];
    let mut prefix = 0;
    // SAFETY: FFmpeg supplies the format and va_list; buffer and prefix are writable for this call.
    unsafe {
        av_log_format_line2(
            ptr,
            level,
            fmt,
            args,
            buffer.as_mut_ptr().cast(),
            buffer.len() as i32,
            &mut prefix,
        );
    }
    let length = buffer.iter().take_while(|byte| **byte != 0).count();
    let message = sanitize(&buffer[..length]);
    let _ = LAST_ERROR.try_with(|slot| {
        if let Ok(mut slot) = slot.try_borrow_mut() {
            *slot = if message.is_empty() {
                None
            } else {
                Some(message)
            };
        }
    });
}

pub(super) fn take_error() -> Option<String> {
    LAST_ERROR.with(|slot| slot.borrow_mut().take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_error_messages() {
        assert_eq!(
            sanitize(b" \tNVENC: invalid argument\r\n\x00\xff "),
            "NVENC: invalid argument"
        );
        assert_eq!(sanitize(b"\x00\xff\n"), "");
        assert_eq!(
            sanitize(format!("  {}  ", "x".repeat(201)).as_bytes()),
            "x".repeat(200)
        );
    }
}
