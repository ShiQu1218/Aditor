//! Packs 48 kHz interleaved samples into 1024-sample AAC frames using a FIFO; fills gaps with silence and removes overlaps.
use std::{ffi::c_void, ptr};

use anyhow::{ensure, Result};

use super::{
    ffi::*,
    ffmpeg::{check, Encoder, Frame, Packet, AUDIO_BASE},
};

// Fills at most five seconds of silence per call; rejects invalid time bases to bound encoded packet accumulation.
const MAX_SILENCE_SAMPLES: i64 = 5 * 48_000;

pub(super) struct Audio {
    pub encoder: Encoder,
    fifo: *mut AVAudioFifo,
    written: i64,
    encoded: i64,
}
// SAFETY: Exclusive ownership of the FIFO and encoder is transferred to the encoding thread together.
unsafe impl Send for Audio {}
impl Audio {
    pub fn new() -> Result<Self> {
        let encoder = Encoder::allocate(c"aac")?;
        // SAFETY: The context is exclusively owned and unopened; FFmpeg initializes the channel layout.
        unsafe {
            (*encoder.0).sample_rate = 48_000;
            (*encoder.0).sample_fmt = AV_SAMPLE_FMT_FLTP;
            (*encoder.0).bit_rate = 192_000;
            (*encoder.0).time_base = AUDIO_BASE;
            (*encoder.0).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
            av_channel_layout_default(&mut (*encoder.0).ch_layout, 2);
        }
        encoder.open()?;
        // SAFETY: Interleaved FLT, two channels, and an initial 1024 samples; the FIFO grows as needed.
        let fifo = unsafe { av_audio_fifo_alloc(AV_SAMPLE_FMT_FLT, 2, 1024) };
        ensure!(!fifo.is_null(), "Failed to allocate audio FIFO");
        Ok(Self {
            encoder,
            fifo,
            written: 0,
            encoded: 0,
        })
    }
    pub fn push(&mut self, samples: &[f32], pts: i64) -> Result<Vec<Packet>> {
        let target = ((pts as i128 * 48_000 + 5_000_000) / 10_000_000) as i64;
        let mut packets = self.advance(target.max(0))?;
        let skip = (self.written - target).max(0).min(samples.len() as i64 / 2) as usize;
        for chunk in samples[skip * 2..].chunks(2048) {
            self.write(chunk)?;
            packets.extend(self.drain()?);
        }
        Ok(packets)
    }
    pub fn advance(&mut self, target: i64) -> Result<Vec<Packet>> {
        ensure!(
            target.saturating_sub(self.written) <= MAX_SILENCE_SAMPLES,
            "Audio timestamp gap exceeds five seconds; stop encoding to limit memory usage"
        );
        let silence = [0f32; 2048];
        let mut packets = Vec::new();
        while self.written < target {
            let count = (target - self.written).min(1024) as usize;
            self.write(&silence[..count * 2])?;
            packets.extend(self.drain()?);
        }
        Ok(packets)
    }
    fn write(&mut self, samples: &[f32]) -> Result<()> {
        let plane = samples.as_ptr() as *mut c_void;
        let count = (samples.len() / 2) as i32;
        // SAFETY: FLT is single-plane interleaved data with count * 2 samples; the function only reads the data.
        let result = unsafe { av_audio_fifo_write(self.fifo, &plane, count) };
        check(result, "Write audio FIFO")?;
        ensure!(result == count, "Incomplete write to audio FIFO");
        self.written += i64::from(count);
        Ok(())
    }
    fn drain(&mut self) -> Result<Vec<Packet>> {
        let mut packets = Vec::new();
        // SAFETY: The FIFO is valid and exclusively owned by this thread.
        while unsafe { av_audio_fifo_size(self.fifo) } >= 1024 {
            let frame = Frame::new()?;
            let mut samples = [0f32; 2048];
            let plane = samples.as_mut_ptr().cast();
            // SAFETY: The frame is allocated and the output buffer holds 1024 stereo samples; each allocated FLTP plane has 1024 f32 values.
            unsafe {
                (*frame.0).nb_samples = 1024;
                (*frame.0).format = AV_SAMPLE_FMT_FLTP;
                (*frame.0).sample_rate = 48_000;
                (*frame.0).pts = self.encoded;
                av_channel_layout_default(&mut (*frame.0).ch_layout, 2);
                check(av_frame_get_buffer(frame.0, 0), "Allocate AAC frame")?;
                ensure!(
                    av_audio_fifo_read(self.fifo, &plane, 1024) == 1024,
                    "Audio FIFO read was incomplete"
                );
                for channel in 0..2 {
                    let out = std::slice::from_raw_parts_mut(
                        (*frame.0).data[channel].cast::<f32>(),
                        1024,
                    );
                    for (i, value) in out.iter_mut().enumerate() {
                        *value = samples[i * 2 + channel];
                    }
                }
            }
            self.encoded += 1024;
            packets.extend(self.encoder.send(Some(&frame))?);
        }
        Ok(packets)
    }
    pub fn finish(&mut self, end_ticks: i64) -> Result<Vec<Packet>> {
        let end = ((end_ticks as i128 * 48_000) / 10_000_000) as i64;
        let mut packets = self.advance(end)?;
        // SAFETY: The FIFO is valid and exclusively owned by this thread.
        let remaining = unsafe { av_audio_fifo_size(self.fifo) };
        if remaining > 0 {
            self.write(&vec![0.; (1024 - remaining) as usize * 2])?;
            packets.extend(self.drain()?);
        }
        packets.extend(self.encoder.send(None)?);
        Ok(packets)
    }
}
impl Drop for Audio {
    fn drop(&mut self) {
        // SAFETY: This object exclusively owns and releases the FIFO once; Drop manages the encoder.
        unsafe {
            av_audio_fifo_free(self.fifo);
        }
        self.fifo = ptr::null_mut();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excessive_silence_is_rejected_without_advancing() {
        let mut audio = Audio::new().unwrap();
        assert!(audio.push(&[0.; 2048], i64::MAX).is_err());
        assert!(audio.advance(MAX_SILENCE_SAMPLES + 1).is_err());
        assert!(audio.finish(i64::MAX).is_err());
        assert_eq!(audio.written, 0);
        assert_eq!(audio.encoded, 0);
    }

    #[test]
    fn silence_limit_is_inclusive_and_relative_to_written_samples() {
        let mut audio = Audio::new().unwrap();
        for target in [MAX_SILENCE_SAMPLES, 2 * MAX_SILENCE_SAMPLES] {
            let packets = audio.advance(target).unwrap();
            assert!(!packets.is_empty());
            assert_eq!(audio.written, target);
        }
        assert!(audio
            .advance(audio.written + MAX_SILENCE_SAMPLES + 1)
            .is_err());
        audio.finish(100_000_000).unwrap();
    }
}
