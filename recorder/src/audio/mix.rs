//! 純函式混音與格式轉換（任務 B3）：聲道數轉換、重取樣到 48 kHz、增益、夾值。
//! 不依賴 WASAPI，全部可單元測試。

use anyhow::{bail, Result};

use crate::clock::TICKS_PER_SEC;
use crate::types::AUDIO_RATE;

pub(super) const BLOCK_FRAMES: usize = AUDIO_RATE as usize / 100;

#[derive(Clone, Copy, Debug)]
pub(super) enum Sample {
    Pcm(u16),
    Float(u16),
}

#[derive(Clone, Debug)]
pub(super) struct Format {
    pub rate: u32,
    pub channels: usize,
    pub block_align: usize,
    pub mono: bool,
    sample: Sample,
    positions: [Option<usize>; 3],
}

impl Format {
    pub fn new(
        rate: u32,
        channels: u16,
        block_align: u16,
        sample: Sample,
        mask: u32,
    ) -> Result<Self> {
        let bits = match sample {
            Sample::Pcm(bits @ (8 | 16 | 24 | 32)) | Sample::Float(bits @ (32 | 64)) => bits,
            _ => bail!("不支援的音訊樣本格式"),
        };
        if !(8_000..=384_000).contains(&rate)
            || !(1..=32).contains(&channels)
            || usize::from(block_align) != usize::from(channels) * usize::from(bits / 8)
            || (mask != 0 && mask.count_ones() != u32::from(channels))
        {
            bail!("裝置音訊格式的取樣率、聲道或區塊大小無效");
        }
        let positions = if channels == 1 {
            [Some(0), Some(0), None]
        } else if mask == 0 {
            [Some(0), Some(1), (channels > 2).then_some(2)]
        } else {
            [1u32, 2, 4]
                .map(|bit| (mask & bit != 0).then(|| (mask & (bit - 1)).count_ones() as usize))
        };
        Ok(Self {
            rate,
            channels: usize::from(channels),
            block_align: usize::from(block_align),
            mono: false,
            sample,
            positions,
        })
    }

    pub fn decode(&self, bytes: &[u8], frames: usize, silent: bool) -> Result<Vec<[f32; 2]>> {
        if silent {
            return Ok(vec![[0.0; 2]; frames]);
        }
        if frames.checked_mul(self.block_align) != Some(bytes.len()) {
            bail!("音訊封包長度與格式不符");
        }
        let width = self.block_align / self.channels;
        Ok(bytes
            .chunks_exact(self.block_align)
            .map(|frame| {
                let channel = |position: Option<usize>| {
                    position.map_or(0.0, |index| {
                        let sample = &frame[index * width..(index + 1) * width];
                        finite(match self.sample {
                            Sample::Pcm(8) => (f32::from(sample[0]) - 128.0) / 128.0,
                            Sample::Pcm(16) => {
                                f32::from(i16::from_le_bytes([sample[0], sample[1]])) / 32768.0
                            }
                            Sample::Pcm(24) => {
                                let value =
                                    i32::from_le_bytes([0, sample[0], sample[1], sample[2]]);
                                value as f32 / 2_147_483_648.0
                            }
                            Sample::Pcm(32) => {
                                i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])
                                    as f32
                                    / 2_147_483_648.0
                            }
                            Sample::Float(32) => {
                                f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])
                            }
                            Sample::Float(64) => f64::from_le_bytes([
                                sample[0], sample[1], sample[2], sample[3], sample[4], sample[5],
                                sample[6], sample[7],
                            ]) as f32,
                            _ => 0.0, // 建構時已驗證所有可接受的格式。
                        })
                    })
                };
                if self.mono {
                    let sample = (0..self.channels)
                        .map(|index| channel(Some(index)))
                        .sum::<f32>()
                        / self.channels as f32;
                    return [sample; 2];
                }
                let center = channel(self.positions[2]) * std::f32::consts::FRAC_1_SQRT_2;
                [
                    channel(self.positions[0]) + center,
                    channel(self.positions[1]) + center,
                ]
            })
            .collect())
    }
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// 保留跨封包的相位與前一個樣本，避免 44.1 kHz 的逐塊四捨五入造成累積漂移。
pub(super) struct Resampler {
    rate: u32,
    input_frames: u64,
    next_position: u64,
    previous: [f32; 2],
}

impl Resampler {
    pub fn new(rate: u32) -> Self {
        Self {
            rate,
            input_frames: 0,
            next_position: 0,
            previous: [0.0; 2],
        }
    }

    pub fn push(&mut self, input: &[[f32; 2]]) -> Vec<[f32; 2]> {
        let capacity =
            (input.len() as u64 * u64::from(AUDIO_RATE) / u64::from(self.rate) + 2) as usize;
        let mut output = Vec::with_capacity(capacity);
        for &sample in input {
            let position = self.input_frames * u64::from(AUDIO_RATE);
            while self.next_position <= position {
                let fraction = if self.input_frames == 0 {
                    1.0
                } else {
                    (self.next_position - (position - u64::from(AUDIO_RATE))) as f32
                        / AUDIO_RATE as f32
                };
                output.push(std::array::from_fn(|channel| {
                    self.previous[channel] + (sample[channel] - self.previous[channel]) * fraction
                }));
                self.next_position += u64::from(self.rate);
            }
            self.previous = sample;
            self.input_frames += 1;
        }
        output
    }
}

pub(super) fn frames_from_ticks(ticks: i64) -> i64 {
    (i128::from(ticks) * i128::from(AUDIO_RATE) / i128::from(TICKS_PER_SEC)) as i64
}

pub(super) fn ticks_from_frames(frames: i64) -> i64 {
    (i128::from(frames) * i128::from(TICKS_PER_SEC) / i128::from(AUDIO_RATE)) as i64
}

/// 固定一秒的環形緩衝；缺樣本預設為靜音，已輸出的資料與過遠的未來資料直接丟棄。
pub(super) struct Timeline {
    samples: Vec<[f32; 2]>,
    pub cursor: i64,
    through: i64,
}

impl Timeline {
    pub fn new(cursor: i64) -> Self {
        Self {
            samples: vec![[0.0; 2]; AUDIO_RATE as usize],
            cursor,
            through: cursor,
        }
    }

    pub fn write(&mut self, start: i64, samples: &[[f32; 2]]) {
        let end = start + samples.len() as i64;
        let first = start.max(self.cursor);
        let last = end.min(self.cursor + self.samples.len() as i64);
        for frame in first..last {
            let slot = frame.rem_euclid(self.samples.len() as i64) as usize;
            self.samples[slot] = samples[(frame - start) as usize];
        }
        if last > first {
            self.through = self.through.max(last);
        }
    }

    pub fn ready(&self, frames: usize, now: i64, grace: i64) -> bool {
        let end = self.cursor + frames as i64;
        self.through >= end || now >= end + grace
    }

    pub fn take(&mut self, frames: usize) -> Vec<[f32; 2]> {
        (0..frames)
            .map(|_| {
                let slot = self.cursor.rem_euclid(self.samples.len() as i64) as usize;
                self.cursor += 1;
                std::mem::replace(&mut self.samples[slot], [0.0; 2])
            })
            .collect()
    }
}

pub(super) fn mix(
    system: &[[f32; 2]],
    mic: &[[f32; 2]],
    render_gain: f32,
    gain: f32,
    mic_mono: bool,
) -> Vec<f32> {
    system
        .iter()
        .zip(mic)
        .flat_map(|(system, mic)| {
            let mic = if mic_mono {
                [(finite(mic[0]) + finite(mic[1])) * 0.5; 2]
            } else {
                *mic
            };
            std::array::from_fn::<_, 2, _>(|channel| {
                (finite(system[channel]) * render_gain + finite(mic[channel]) * gain)
                    .clamp(-1.0, 1.0)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn float_bytes(values: &[f32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    #[test]
    fn downmix_uses_front_and_center_only_and_respects_mask() {
        let format = Format::new(48_000, 6, 24, Sample::Float(32), 0x3f).unwrap();
        let decoded = format
            .decode(&float_bytes(&[0.1, 0.2, 0.4, 0.9, 0.8, 0.7]), 1, false)
            .unwrap();
        assert!((decoded[0][0] - (0.1 + 0.4 * 0.5f32.sqrt())).abs() < 1e-6);
        assert!((decoded[0][1] - (0.2 + 0.4 * 0.5f32.sqrt())).abs() < 1e-6);
        let center_lfe = Format::new(48_000, 2, 8, Sample::Float(32), 12).unwrap();
        let center = center_lfe
            .decode(&float_bytes(&[0.5, 1.0]), 1, false)
            .unwrap();
        assert_eq!(center[0][0], center[0][1]);
        assert!((center[0][0] - 0.5 * 0.5f32.sqrt()).abs() < 1e-6);
    }

    #[test]
    fn pcm_formats_mono_silence_and_invalid_data() {
        for (bits, bytes) in [
            (8, vec![192]),
            (16, 16_384i16.to_le_bytes().to_vec()),
            (24, vec![0, 0, 64]),
            (32, 1_073_741_824i32.to_le_bytes().to_vec()),
        ] {
            let format = Format::new(44_100, 1, bits / 8, Sample::Pcm(bits), 0).unwrap();
            assert_eq!(format.decode(&bytes, 1, false).unwrap(), [[0.5, 0.5]]);
            assert_eq!(format.decode(&[], 2, true).unwrap(), [[0.0; 2]; 2]);
            assert!(format.decode(&[], 1, false).is_err());
        }
        let float = Format::new(48_000, 1, 8, Sample::Float(64), 0).unwrap();
        assert_eq!(
            float.decode(&0.25f64.to_le_bytes(), 1, false).unwrap(),
            [[0.25; 2]]
        );
        assert!(Format::new(0, 2, 8, Sample::Float(32), 0).is_err());
        assert!(Format::new(48_000, 2, 8, Sample::Float(32), 4).is_err());
        assert!(Format::new(48_000, 2, 6, Sample::Float(24), 0).is_err());
    }

    #[test]
    fn resampling_preserves_length_frequency_and_packet_phase() {
        let input: Vec<_> = (0..44_100)
            .map(|frame| [(std::f32::consts::TAU * 1000.0 * frame as f32 / 44_100.0).sin(); 2])
            .collect();
        let output = Resampler::new(44_100).push(&input);
        assert!((output.len() as i64 - 48_000).abs() <= 1);
        let crossings = output
            .windows(2)
            .filter(|pair| pair[0][0] <= 0.0 && pair[1][0] > 0.0)
            .count();
        assert!((crossings as i32 - 1000).abs() <= 1);
        let mut streaming = Resampler::new(44_100);
        let chunked: Vec<_> = input
            .chunks(137)
            .flat_map(|chunk| streaming.push(chunk))
            .collect();
        assert_eq!(chunked, output);
        assert_eq!(
            Resampler::new(48_000).push(&[[0.2, -0.3]; 480]),
            [[0.2, -0.3]; 480]
        );
        assert_eq!(
            Resampler::new(96_000).push(&[[0.2, -0.3]; 960]),
            [[0.2, -0.3]; 480]
        );
    }

    #[test]
    fn mixing_applies_gain_clips_and_removes_nonfinite_samples() {
        assert_eq!(
            mix(&[[0.8, -0.8]], &[[0.4, -0.4]], 1.0, 2.0, false),
            [1.0, -1.0]
        );
        assert_eq!(
            mix(&[[0.1, 0.2]], &[[0.4, 0.6]], 1.0, 0.5, false),
            [0.3, 0.5]
        );
        assert_eq!(
            mix(&[[f32::NAN, 0.2]], &[[0.3, f32::INFINITY]], 1.0, 0.0, false),
            [0.0, 0.2]
        );
    }

    #[test]
    fn timeline_aligns_gaps_discards_late_data_and_caps_mic_wait() {
        let mut timeline = Timeline::new(1000);
        timeline.write(998, &[[0.5; 2]; 4]);
        timeline.write(1004, &[[0.8; 2]; 2]);
        assert_eq!(
            timeline.take(6),
            [[0.5; 2], [0.5; 2], [0.0; 2], [0.0; 2], [0.8; 2], [0.8; 2]]
        );
        timeline.write(1000, &[[1.0; 2]; 6]);
        let end = timeline.cursor + BLOCK_FRAMES as i64;
        assert!(!timeline.ready(BLOCK_FRAMES, end + 9599, 9600));
        assert!(timeline.ready(BLOCK_FRAMES, end + 9600, 9600));
        assert_eq!(timeline.take(BLOCK_FRAMES), vec![[0.0; 2]; BLOCK_FRAMES]);
        timeline.write(timeline.cursor + AUDIO_RATE as i64 + 100, &[[1.0; 2]; 10]);
        assert_eq!(timeline.take(BLOCK_FRAMES), vec![[0.0; 2]; BLOCK_FRAMES]);
    }

    #[test]
    fn render_gain_and_mic_mono_are_independent() {
        let mut format = Format::new(48_000, 4, 16, Sample::Float(32), 0).unwrap();
        format.mono = true;
        assert_eq!(
            format
                .decode(&float_bytes(&[0.0, 0.2, 0.4, 0.6]), 1, false)
                .unwrap(),
            [[0.3; 2]]
        );
        assert_eq!(
            mix(&[[0.4, 0.8]], &[[0.8, 0.0]], 0.5, 1.0, true),
            [0.6, 0.8]
        );
        assert_eq!(
            mix(&[[0.4, 0.8]], &[[0.8, 0.0]], 0.0, 1.0, false),
            [0.8, 0.0]
        );
        assert_eq!(
            mix(&[[0.8, -0.8]], &[[0.0; 2]], 2.0, 0.0, true),
            [1.0, -1.0]
        );
        assert_eq!(mix(&[[0.0; 2]], &[[0.0; 2]], 1.0, 1.0, true), [0.0, 0.0]);
    }

    #[test]
    fn timeline_wraps_without_reusing_old_samples() {
        let mut timeline = Timeline::new(0);
        for _ in 0..110 {
            timeline.write(timeline.cursor, &[[0.5; 2]; BLOCK_FRAMES]);
            assert_eq!(timeline.take(BLOCK_FRAMES), vec![[0.5; 2]; BLOCK_FRAMES]);
        }
        assert_eq!(timeline.take(BLOCK_FRAMES), vec![[0.0; 2]; BLOCK_FRAMES]);
        assert_eq!(frames_from_ticks(TICKS_PER_SEC), i64::from(AUDIO_RATE));
        assert_eq!(ticks_from_frames(i64::from(AUDIO_RATE)), TICKS_PER_SEC);
    }
}
