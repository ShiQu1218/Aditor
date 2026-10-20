//! Custom MP4 AVIO; each frag_custom flush writes one m4s file and syncs it to disk.
//! https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv
use std::{
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    ptr,
    sync::mpsc::Sender,
};

use anyhow::{ensure, Context, Result};

use super::{
    ffi::*,
    ffmpeg::{check, Encoder, Packet, AUDIO_BASE, AV_NOPTS_VALUE, TICK_BASE},
    SegmentInfo,
};

struct Output {
    file: File,
    error: Option<std::io::Error>,
}
// SAFETY: opaque points to the Box<Output> owned by Muxer and is accessed synchronously by one encoding thread.
unsafe extern "C" fn write_output(opaque: *mut c_void, data: *const u8, size: i32) -> i32 {
    // SAFETY: AVIO guarantees data has size bytes; opaque remains valid until AVIO is released.
    let (output, bytes) = unsafe {
        (
            &mut *opaque.cast::<Output>(),
            std::slice::from_raw_parts(data, size as usize),
        )
    };
    match output.file.write_all(bytes) {
        Ok(()) => size,
        Err(error) => {
            output.error = Some(error);
            -5
        }
    }
}

struct Pending {
    packet: Packet,
    ticks: i64,
    video: bool,
}
pub(super) struct Muxer {
    context: *mut AVFormatContext,
    io: *mut AVIOContext,
    output: Box<Output>,
    dir: PathBuf,
    sender: Sender<SegmentInfo>,
    pending: Vec<Pending>,
    boundaries: Vec<i64>,
    audio: bool,
    audio_until: i64,
    start: Option<i64>,
    end: i64,
    seq: u64,
}
// SAFETY: AVFormatContext, AVIO, and Output are used only by one encoding thread.
unsafe impl Send for Muxer {}
impl Muxer {
    pub fn new(
        dir: &Path,
        video: &Encoder,
        audio: Option<&Encoder>,
        sender: Sender<SegmentInfo>,
    ) -> Result<Self> {
        fs::create_dir_all(dir).context("Failed to create recording directory")?;
        let file = create_file(&dir.join("init.mp4"))?;
        let mut muxer = Self {
            context: ptr::null_mut(),
            io: ptr::null_mut(),
            output: Box::new(Output { file, error: None }),
            dir: dir.to_owned(),
            sender,
            pending: Vec::new(),
            boundaries: Vec::new(),
            audio: audio.is_some(),
            audio_until: i64::MIN,
            start: None,
            end: 0,
            seq: 0,
        };
        // SAFETY: All media packets are complete; skip_trailer avoids indexes and absolute offsets across files.
        unsafe {
            check(
                avformat_alloc_output_context2(
                    &mut muxer.context,
                    ptr::null(),
                    c"mp4".as_ptr(),
                    ptr::null(),
                ),
                "Create MP4 muxer",
            )?;
            ensure!(!muxer.context.is_null(), "MP4 muxer returned no context");
            let buffer = av_malloc(32_768).cast::<u8>();
            ensure!(!buffer.is_null(), "Failed to allocate AVIO buffer");
            muxer.io = avio_alloc_context(
                buffer,
                32_768,
                1,
                (&mut *muxer.output as *mut Output).cast(),
                None,
                Some(write_output),
                None,
            );
            if muxer.io.is_null() {
                av_free(buffer.cast());
                anyhow::bail!("Failed to allocate AVIO context");
            }
            (*muxer.context).pb = muxer.io;
            (*muxer.context).flags |= AVFMT_FLAG_CUSTOM_IO as i32;
            for (encoder, base) in
                std::iter::once((video, TICK_BASE)).chain(audio.map(|a| (a, AUDIO_BASE)))
            {
                let stream = avformat_new_stream(muxer.context, ptr::null());
                ensure!(!stream.is_null(), "Failed to allocate MP4 stream");
                check(
                    avcodec_parameters_from_context((*stream).codecpar, encoder.0),
                    "Copy stream parameters",
                )?;
                // Parameter sets are in hvcC (global header); the hvc1 tag has the best compatibility with Chromium MSE and most players.
                if (*(*stream).codecpar).codec_id == AV_CODEC_ID_HEVC {
                    (*(*stream).codecpar).codec_tag = u32::from_le_bytes(*b"hvc1");
                }
                (*stream).time_base = base;
            }
            // Split segments at video keyframes to prevent AAC ordering or automatic flushes from moving boundaries.
            let mut options = ptr::null_mut();
            let option_result = av_dict_set(
                &mut options,
                c"movflags".as_ptr(),
                c"frag_custom+empty_moov+default_base_moof+cmaf+skip_trailer".as_ptr(),
                0,
            );
            let result = if option_result < 0 {
                option_result
            } else {
                avformat_write_header(muxer.context, &mut options)
            };
            av_dict_free(&mut options);
            check(result, "Write MP4 initialization segment")?;
        }
        muxer.sync()?;
        muxer.output.file = create_file(&dir.join("seg_000001.m4s"))?;
        Ok(muxer)
    }
    pub fn push(&mut self, packets: Vec<Packet>, video: bool) -> Result<()> {
        for packet in packets {
            // SAFETY: The packet and stream belong to this muxer; write_header established the stream time_base.
            unsafe {
                let p = &mut *packet.0;
                ensure!(p.pts != AV_NOPTS_VALUE, "Encoded packet is missing a valid PTS timestamp");
                if !video && p.pts < 0 {
                    continue;
                } // AAC encoder preroll is outside the recording timeline.
                let base = if video { TICK_BASE } else { AUDIO_BASE };
                let ticks =
                    ((p.pts as i128 * base.num as i128 * 10_000_000) / base.den as i128) as i64;
                if video {
                    if self.start.is_none() {
                        self.start = Some(ticks);
                    } else if p.flags & AV_PKT_FLAG_KEY as i32 != 0 {
                        self.boundaries.push(ticks);
                    }
                    self.end = self.end.max(ticks + p.duration);
                } else {
                    self.audio_until = ticks;
                }
                let stream = *(*self.context).streams.add(if video { 0 } else { 1 });
                p.stream_index = if video { 0 } else { 1 };
                p.pos = -1;
                av_packet_rescale_ts(packet.0, base, (*stream).time_base);
                self.pending.push(Pending {
                    packet,
                    ticks,
                    video,
                });
            }
        }
        ensure!(
            self.pending.len() <= 2048,
            "Audio/video timestamp gap is too large; stop muxing to limit memory usage"
        );
        self.progress(false)
    }
    fn progress(&mut self, force: bool) -> Result<()> {
        while let Some(&boundary) = self.boundaries.first() {
            if !force && self.audio && self.audio_until < boundary {
                break;
            }
            self.flush_segment(boundary)?;
            self.boundaries.remove(0);
        }
        Ok(())
    }
    fn flush_segment(&mut self, end: i64) -> Result<()> {
        let start = self.start.context("Missing video start time")?;
        if self.seq > 0 {
            self.output.file = create_file(&self.dir.join(format!("seg_{:06}.m4s", self.seq + 1)))?;
        }
        let (mut current, future): (Vec<_>, Vec<_>) =
            self.pending.drain(..).partition(|p| p.ticks < end);
        self.pending = future;
        current.sort_by_key(|p| (p.ticks, !p.video));
        ensure!(current.iter().any(|p| p.video), "Segment contains no video frames");
        // SAFETY: Each packet has a valid stream_index; frag_custom completes a fragment with a null packet.
        unsafe {
            for p in current {
                check(av_write_frame(self.context, p.packet.0), "Write media packet")?;
            }
            check(
                av_write_frame(self.context, ptr::null_mut()),
                "Finish MP4 segment",
            )?;
        }
        self.sync()?;
        self.seq += 1;
        let bytes = self.output.file.metadata()?.len();
        ensure!(bytes > 0, "MP4 segment is empty");
        // A closed receiver must not prevent the recording core from finishing the current file.
        let _ = self.sender.send(SegmentInfo {
            seq: self.seq,
            pts_secs: start as f64 / 10_000_000.,
            dur_secs: (end - start) as f64 / 10_000_000.,
            bytes,
        });
        self.start = Some(end);
        Ok(())
    }
    fn sync(&mut self) -> Result<()> {
        // SAFETY: AVIO is initialized; flush writes the buffer to the current file.
        unsafe {
            avio_flush(self.io);
            check((*self.io).error, "Write recording file")?;
        }
        if let Some(error) = self.output.error.take() {
            return Err(error).context("Failed to write recording file");
        }
        self.output.file.sync_data().context("Failed to sync recording file")
    }
    pub fn finish(&mut self) -> Result<()> {
        self.progress(true)?;
        if self.start.is_some_and(|start| self.end > start) {
            self.flush_segment(self.end)?;
        }
        // SAFETY: All media packets are complete; skip_trailer avoids indexes and absolute offsets across files.
        unsafe {
            check(av_write_trailer(self.context), "Finish MP4")?;
        }
        self.sync()
    }
}
fn create_file(path: &Path) -> Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("Failed to create recording file: {}", path.display()))
}
impl Drop for Muxer {
    fn drop(&mut self) {
        // SAFETY: The format context does not free custom IO; FFmpeg may replace the AVIO buffer, so free the current buffer.
        unsafe {
            if !self.context.is_null() {
                avformat_free_context(self.context);
            }
            if !self.io.is_null() {
                av_free((*self.io).buffer.cast());
                avio_context_free(&mut self.io);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_pts_is_rejected_before_updating_the_timeline() {
        let dir = std::env::temp_dir().join(format!("aditorrec-missing-pts-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let (sender, _receiver) = std::sync::mpsc::channel();
        let mut muxer = Muxer {
            context: ptr::null_mut(),
            io: ptr::null_mut(),
            output: Box::new(Output {
                file: create_file(&dir.join("unused.mp4")).unwrap(),
                error: None,
            }),
            dir: dir.clone(),
            sender,
            pending: Vec::new(),
            boundaries: Vec::new(),
            audio: true,
            audio_until: i64::MIN,
            start: None,
            end: 0,
            seq: 0,
        };
        for video in [true, false] {
            let packet = Packet::new().unwrap();
            // SAFETY: The test exclusively owns the packet and simulates an encoder packet with no timestamp.
            unsafe {
                (*packet.0).pts = AV_NOPTS_VALUE;
            }
            let error = muxer.push(vec![packet], video).unwrap_err();
            assert!(error.to_string().contains("PTS"));
            assert!(muxer.pending.is_empty());
            assert!(muxer.boundaries.is_empty());
            assert_eq!(muxer.start, None);
            assert_eq!(muxer.end, 0);
            assert_eq!(muxer.audio_until, i64::MIN);
        }
        drop(muxer);
        fs::remove_dir_all(dir).unwrap();
    }
}
