//! 48 kHz 交錯樣本以 FIFO 湊成 AAC 的 1024 樣本影格；缺口補靜音、重疊去除。
use std::{ffi::c_void, ptr};

use anyhow::{ensure, Result};

use super::{
    ffi::*,
    ffmpeg::{check, Encoder, Frame, Packet, AUDIO_BASE},
};

// 單次最多補五秒靜音；拒絕錯誤時間基準，避免累積無上限的編碼封包。
const MAX_SILENCE_SAMPLES: i64 = 5 * 48_000;

pub(super) struct Audio {
    pub encoder: Encoder,
    fifo: *mut AVAudioFifo,
    written: i64,
    encoded: i64,
}
// SAFETY: FIFO 與編碼器的獨佔擁有權會一次移交給編碼執行緒。
unsafe impl Send for Audio {}
impl Audio {
    pub fn new() -> Result<Self> {
        let encoder = Encoder::allocate(c"aac")?;
        // SAFETY: 尚未開啟的獨佔 context，聲道配置由 FFmpeg 初始化。
        unsafe {
            (*encoder.0).sample_rate = 48_000;
            (*encoder.0).sample_fmt = AV_SAMPLE_FMT_FLTP;
            (*encoder.0).bit_rate = 192_000;
            (*encoder.0).time_base = AUDIO_BASE;
            (*encoder.0).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
            av_channel_layout_default(&mut (*encoder.0).ch_layout, 2);
        }
        encoder.open()?;
        // SAFETY: 交錯 FLT 格式、兩聲道、初始 1024 樣本，FIFO 會自行擴充。
        let fifo = unsafe { av_audio_fifo_alloc(AV_SAMPLE_FMT_FLT, 2, 1024) };
        ensure!(!fifo.is_null(), "配置音訊 FIFO 失敗");
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
            "音訊時間戳缺口超過五秒，停止編碼以限制記憶體用量"
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
        // SAFETY: FLT 是單平面交錯資料，輸入包含 count * 2 個樣本，函式只讀取資料。
        let result = unsafe { av_audio_fifo_write(self.fifo, &plane, count) };
        check(result, "寫入音訊 FIFO")?;
        ensure!(result == count, "音訊 FIFO 寫入不完整");
        self.written += i64::from(count);
        Ok(())
    }
    fn drain(&mut self) -> Result<Vec<Packet>> {
        let mut packets = Vec::new();
        // SAFETY: FIFO 在本執行緒獨佔且保持有效。
        while unsafe { av_audio_fifo_size(self.fifo) } >= 1024 {
            let frame = Frame::new()?;
            let mut samples = [0f32; 2048];
            let plane = samples.as_mut_ptr().cast();
            // SAFETY: 影格已配置、輸出緩衝區足夠 1024 個立體聲樣本；配置後的 FLTP 平面各有 1024 個 f32。
            unsafe {
                (*frame.0).nb_samples = 1024;
                (*frame.0).format = AV_SAMPLE_FMT_FLTP;
                (*frame.0).sample_rate = 48_000;
                (*frame.0).pts = self.encoded;
                av_channel_layout_default(&mut (*frame.0).ch_layout, 2);
                check(av_frame_get_buffer(frame.0, 0), "配置 AAC 影格")?;
                ensure!(
                    av_audio_fifo_read(self.fifo, &plane, 1024) == 1024,
                    "讀取音訊 FIFO 不完整"
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
        // SAFETY: FIFO 在本執行緒獨佔。
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
        // SAFETY: 本物件獨佔 FIFO，釋放一次；編碼器另由自身 Drop 管理。
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
