//! FFmpeg resources accessed only on their owning thread; Drop releases them on all failure paths.
use std::{ffi::CStr, ptr, sync::OnceLock};

use anyhow::{bail, ensure, Result};

use super::ffi::*;

pub(super) const TICK_BASE: AVRational = AVRational {
    num: 1,
    den: 10_000_000,
};
pub(super) const AUDIO_BASE: AVRational = AVRational {
    num: 1,
    den: 48_000,
};
pub(super) const EOF: i32 = -541478725;
pub(super) const AGAIN: i32 = -11;
// libavutil/avutil.h: sentinel for an unset timestamp; do not use as recording time.
pub(super) const AV_NOPTS_VALUE: i64 = i64::MIN;

pub(crate) fn check_version() -> Result<()> {
    static VERSION: OnceLock<Result<(), String>> = OnceLock::new();
    let result = VERSION.get_or_init(|| {
        // SAFETY: Version queries do not access FFmpeg structures; verify the ABI before allocating or reading/writing fields.
        let versions = unsafe { [avutil_version(), avcodec_version(), avformat_version()] };
        validate_versions(versions).map_err(|error| error.to_string())
    });
    match result {
        Ok(()) => Ok(()),
        Err(error) => bail!("{error}"),
    }
}

fn validate_versions(versions: [u32; 3]) -> Result<()> {
    for ((library, expected), version) in [
        ("avutil", LIBAVUTIL_VERSION_MAJOR),
        ("avcodec", LIBAVCODEC_VERSION_MAJOR),
        ("avformat", LIBAVFORMAT_VERSION_MAJOR),
    ]
    .into_iter()
    .zip(versions)
    {
        let major = version >> 16;
        ensure!(
            major == expected,
            "FFmpeg {library} DLL major version mismatch: bindings require {expected}, loaded {major}; use an FFmpeg DLL matching the bindings"
        );
    }
    Ok(())
}

pub(super) fn check(code: i32, action: &str) -> Result<()> {
    if code < 0 {
        let mut buffer = [0i8; 256];
        // SAFETY: buffer is a writable error-message buffer with a specified length.
        unsafe {
            av_strerror(code, buffer.as_mut_ptr(), buffer.len());
            bail!(
                "{action} failed: {} ({code})",
                CStr::from_ptr(buffer.as_ptr()).to_string_lossy()
            );
        }
    }
    Ok(())
}

pub(super) struct Buffer(pub *mut AVBufferRef);
impl Buffer {
    pub fn owned(raw: *mut AVBufferRef) -> Result<Self> {
        ensure!(!raw.is_null(), "Failed to allocate FFmpeg hardware buffer");
        Ok(Self(raw))
    }
    pub fn reference(&self) -> Result<*mut AVBufferRef> {
        // SAFETY: self retains a valid AVBufferRef; FFmpeg context takes ownership of the new reference.
        let raw = unsafe { av_buffer_ref(self.0) };
        ensure!(!raw.is_null(), "Failed to clone FFmpeg buffer reference");
        Ok(raw)
    }
}
impl Drop for Buffer {
    fn drop(&mut self) {
        // SAFETY: This object owns this reference and releases it exactly once.
        unsafe { av_buffer_unref(&mut self.0) }
    }
}

pub(super) struct Frame(pub *mut AVFrame);
// SAFETY: Exclusive AVFrame ownership moves with the object; D3D11 multithread protection guards GPU resources.
unsafe impl Send for Frame {}
impl Frame {
    pub fn new() -> Result<Self> {
        check_version()?;
        // SAFETY: The allocation function has no preconditions.
        let raw = unsafe { av_frame_alloc() };
        ensure!(!raw.is_null(), "Failed to allocate AVFrame");
        Ok(Self(raw))
    }
    pub fn duplicate(&self) -> Result<Self> {
        // SAFETY: The frame is valid; the new frame owns an independent AVBuffer reference.
        let raw = unsafe { av_frame_clone(self.0) };
        ensure!(!raw.is_null(), "Failed to clone AVFrame reference");
        Ok(Self(raw))
    }
}
impl Drop for Frame {
    fn drop(&mut self) {
        // SAFETY: This object owns the frame; FFmpeg also releases the frame reference.
        unsafe { av_frame_free(&mut self.0) }
    }
}

pub(super) struct Packet(pub *mut AVPacket);
impl Packet {
    pub fn new() -> Result<Self> {
        check_version()?;
        // SAFETY: The allocation function has no preconditions.
        let raw = unsafe { av_packet_alloc() };
        ensure!(!raw.is_null(), "Failed to allocate AVPacket");
        Ok(Self(raw))
    }
}
impl Drop for Packet {
    fn drop(&mut self) {
        // SAFETY: This object owns the packet; av_packet_free accepts a null pointer.
        unsafe { av_packet_free(&mut self.0) }
    }
}

pub(super) struct Encoder(pub *mut AVCodecContext);
// SAFETY: Once created, the context is accessed by a single encoding thread, with no concurrent calls during transfer.
unsafe impl Send for Encoder {}
impl Encoder {
    pub fn allocate(name: &CStr) -> Result<Self> {
        check_version()?;
        // SAFETY: name is a valid NUL-terminated string; codec is a static FFmpeg object.
        unsafe {
            let codec = avcodec_find_encoder_by_name(name.as_ptr());
            ensure!(!codec.is_null(), "Encoder not found: {}", name.to_string_lossy());
            let raw = avcodec_alloc_context3(codec);
            ensure!(!raw.is_null(), "Failed to allocate encoder");
            Ok(Self(raw))
        }
    }
    pub fn open(&self) -> Result<()> {
        // SAFETY: The context is allocated and the codec was specified during allocation.
        unsafe {
            check(
                avcodec_open2(self.0, ptr::null(), ptr::null_mut()),
                "Open encoder",
            )
        }
    }
    pub fn option(&self, name: &CStr, value: &CStr) -> Result<()> {
        // SAFETY: priv_data was created by avcodec_alloc_context3; the strings remain valid for the call.
        unsafe {
            check(
                av_opt_set((*self.0).priv_data, name.as_ptr(), value.as_ptr(), 0),
                "Set encoder options",
            )
        }
    }
    pub fn send(&self, frame: Option<&Frame>) -> Result<Vec<Packet>> {
        let mut mapped = None;
        if let Some(source) = frame {
            // SAFETY: context and source are valid; QSV maps the same D3D11 surface without reading it back to the CPU.
            unsafe {
                if (*self.0).pix_fmt == AV_PIX_FMT_QSV {
                    let output = Frame::new()?;
                    (*output.0).format = AV_PIX_FMT_QSV;
                    (*output.0).hw_frames_ctx = av_buffer_ref((*self.0).hw_frames_ctx);
                    ensure!(
                        !(*output.0).hw_frames_ctx.is_null(),
                        "Failed to get QSV frame-pool reference"
                    );
                    check(
                        av_hwframe_map(output.0, source.0, AV_HWFRAME_MAP_READ),
                        "Map D3D11 to QSV",
                    )?;
                    (*output.0).pts = (*source.0).pts;
                    (*output.0).duration = (*source.0).duration;
                    (*output.0).pict_type = (*source.0).pict_type;
                    mapped = Some(output);
                }
            }
        }
        let frame = mapped.as_ref().or(frame);
        // SAFETY: The encoder and optional frame are valid; an empty frame signals end of input.
        unsafe {
            check(
                avcodec_send_frame(self.0, frame.map_or(ptr::null(), |f| f.0)),
                "Send encoded frame",
            )?;
            let mut packets = Vec::new();
            loop {
                let packet = Packet::new()?;
                let code = avcodec_receive_packet(self.0, packet.0);
                if code == AGAIN || code == EOF {
                    break;
                }
                check(code, "Receive encoded packet")?;
                packets.push(packet);
            }
            Ok(packets)
        }
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: This object exclusively owns the context; freeing it also releases hardware references.
        unsafe { avcodec_free_context(&mut self.0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_require_matching_majors_only() {
        let versions = [
            LIBAVUTIL_VERSION_MAJOR << 16 | 0x1234,
            LIBAVCODEC_VERSION_MAJOR << 16 | 0x5678,
            LIBAVFORMAT_VERSION_MAJOR << 16 | 0x9abc,
        ];
        validate_versions(versions).unwrap();
        for (index, library) in ["avutil", "avcodec", "avformat"].into_iter().enumerate() {
            for delta in [-1, 1] {
                let mut mismatched = versions;
                let expected = versions[index] >> 16;
                let actual = (expected as i32 + delta) as u32;
                mismatched[index] = actual << 16;
                let error = validate_versions(mismatched).unwrap_err().to_string();
                assert!(error.contains(library));
                assert!(error.contains(&format!("bindings require {expected}")));
                assert!(error.contains(&format!("loaded {actual}")));
            }
        }
    }
}
