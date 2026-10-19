//! MP4 自訂 AVIO，每次 frag_custom flush 對應一個已同步至磁碟的 m4s。
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
// SAFETY: opaque 是 Muxer 持有的 Box<Output>，僅在單一編碼執行緒同步呼叫。
unsafe extern "C" fn write_output(opaque: *mut c_void, data: *const u8, size: i32) -> i32 {
    // SAFETY: AVIO 保證 data 有 size bytes，opaque 在 AVIO 釋放前持續有效。
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
// SAFETY: AVFormatContext、AVIO 及 Output 只會在單一編碼執行緒使用。
unsafe impl Send for Muxer {}
impl Muxer {
    pub fn new(
        dir: &Path,
        video: &Encoder,
        audio: Option<&Encoder>,
        sender: Sender<SegmentInfo>,
    ) -> Result<Self> {
        fs::create_dir_all(dir).context("建立錄影目錄失敗")?;
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
        // SAFETY: 所有輸出指標初始化為 null；資源由 muxer 的 Drop 收回。AVIO opaque 指向穩定 Box。
        unsafe {
            check(
                avformat_alloc_output_context2(
                    &mut muxer.context,
                    ptr::null(),
                    c"mp4".as_ptr(),
                    ptr::null(),
                ),
                "建立 MP4 muxer",
            )?;
            ensure!(!muxer.context.is_null(), "MP4 muxer 沒有回傳 context");
            let buffer = av_malloc(32_768).cast::<u8>();
            ensure!(!buffer.is_null(), "配置 AVIO 緩衝區失敗");
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
                anyhow::bail!("配置 AVIO context 失敗");
            }
            (*muxer.context).pb = muxer.io;
            (*muxer.context).flags |= AVFMT_FLAG_CUSTOM_IO as i32;
            for (encoder, base) in
                std::iter::once((video, TICK_BASE)).chain(audio.map(|a| (a, AUDIO_BASE)))
            {
                let stream = avformat_new_stream(muxer.context, ptr::null());
                ensure!(!stream.is_null(), "配置 MP4 軌道失敗");
                check(
                    avcodec_parameters_from_context((*stream).codecpar, encoder.0),
                    "複製軌道參數",
                )?;
                // 參數集在 hvcC（全域標頭）裡，用 hvc1 標籤；Chromium MSE 與多數播放器對 hvc1 相容性最好。
                if (*(*stream).codecpar).codec_id == AV_CODEC_ID_HEVC {
                    (*(*stream).codecpar).codec_tag = u32::from_le_bytes(*b"hvc1");
                }
                (*stream).time_base = base;
            }
            // 自行按視訊關鍵影格切段，避免 AAC 排序或自動 flush 把邊界移動。
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
            check(result, "寫入 MP4 初始化段")?;
        }
        muxer.sync()?;
        muxer.output.file = create_file(&dir.join("seg_000001.m4s"))?;
        Ok(muxer)
    }
    pub fn push(&mut self, packets: Vec<Packet>, video: bool) -> Result<()> {
        for packet in packets {
            // SAFETY: 新封包與 stream 都屬於本 muxer，stream time_base 已由 write_header 確定。
            unsafe {
                let p = &mut *packet.0;
                ensure!(p.pts != AV_NOPTS_VALUE, "編碼封包缺少有效的 PTS 時間戳");
                if !video && p.pts < 0 {
                    continue;
                } // AAC 的編碼預滾不在錄影時間軸內。
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
            "影音時間差過大，停止封裝以限制記憶體用量"
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
        let start = self.start.context("缺少視訊起點")?;
        if self.seq > 0 {
            self.output.file = create_file(&self.dir.join(format!("seg_{:06}.m4s", self.seq + 1)))?;
        }
        let (mut current, future): (Vec<_>, Vec<_>) =
            self.pending.drain(..).partition(|p| p.ticks < end);
        self.pending = future;
        current.sort_by_key(|p| (p.ticks, !p.video));
        ensure!(current.iter().any(|p| p.video), "段落沒有視訊影格");
        // SAFETY: 每個封包有正確的 stream_index；frag_custom 以 null 封包完成一個 fragment。
        unsafe {
            for p in current {
                check(av_write_frame(self.context, p.packet.0), "寫入媒體封包")?;
            }
            check(
                av_write_frame(self.context, ptr::null_mut()),
                "完成 MP4 段落",
            )?;
        }
        self.sync()?;
        self.seq += 1;
        let bytes = self.output.file.metadata()?.len();
        ensure!(bytes > 0, "MP4 段落為空");
        // 接收端已關閉不應阻止錄影核心完成既有檔案。
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
        // SAFETY: AVIO 已初始化；flush 將 buffer 寫入目前的 file。
        unsafe {
            avio_flush(self.io);
            check((*self.io).error, "寫入錄影檔")?;
        }
        if let Some(error) = self.output.error.take() {
            return Err(error).context("寫入錄影檔失敗");
        }
        self.output.file.sync_data().context("同步錄影檔失敗")
    }
    pub fn finish(&mut self) -> Result<()> {
        self.progress(true)?;
        if self.start.is_some_and(|start| self.end > start) {
            self.flush_segment(self.end)?;
        }
        // SAFETY: 所有媒體封包已完成，skip_trailer 避免跨檔案的索引與絕對 offset。
        unsafe {
            check(av_write_trailer(self.context), "完成 MP4")?;
        }
        self.sync()
    }
}
fn create_file(path: &Path) -> Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("建立錄影檔失敗：{}", path.display()))
}
impl Drop for Muxer {
    fn drop(&mut self) {
        // SAFETY: custom IO 不由 format context 釋放；AVIO buffer 可能被 FFmpeg 替換，必須釋放目前的 buffer。
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
        let dir = std::env::temp_dir().join(format!("apexrec-missing-pts-{}", std::process::id()));
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
            // SAFETY: 封包由測試獨佔，模擬編碼器回傳缺少時間戳的封包。
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
