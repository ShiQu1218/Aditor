//! 僅在擁有者執行緒存取的 FFmpeg 資源；所有失敗路徑都交由 Drop 釋放。
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
// libavutil/avutil.h：未提供時間戳的哨兵值，不得當成錄影時間使用。
pub(super) const AV_NOPTS_VALUE: i64 = i64::MIN;

pub(crate) fn check_version() -> Result<()> {
    static VERSION: OnceLock<Result<(), String>> = OnceLock::new();
    let result = VERSION.get_or_init(|| {
        // SAFETY: 版本查詢不存取任何 FFmpeg 結構；確認 ABI 後才可配置及讀寫欄位。
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
            "FFmpeg {library} DLL 主版本不相容：綁定需要 {expected}，實際載入 {major}；請使用與綁定相符的 FFmpeg DLL"
        );
    }
    Ok(())
}

pub(super) fn check(code: i32, action: &str) -> Result<()> {
    if code < 0 {
        let mut buffer = [0i8; 256];
        // SAFETY: buffer 是可寫且有指定長度的錯誤訊息緩衝區。
        unsafe {
            av_strerror(code, buffer.as_mut_ptr(), buffer.len());
            bail!(
                "{action}失敗：{} ({code})",
                CStr::from_ptr(buffer.as_ptr()).to_string_lossy()
            );
        }
    }
    Ok(())
}

pub(super) struct Buffer(pub *mut AVBufferRef);
impl Buffer {
    pub fn owned(raw: *mut AVBufferRef) -> Result<Self> {
        ensure!(!raw.is_null(), "配置 FFmpeg 硬體緩衝區失敗");
        Ok(Self(raw))
    }
    pub fn reference(&self) -> Result<*mut AVBufferRef> {
        // SAFETY: self 保持有效的 AVBufferRef；新參照交給 FFmpeg context 管理。
        let raw = unsafe { av_buffer_ref(self.0) };
        ensure!(!raw.is_null(), "複製 FFmpeg 緩衝區參照失敗");
        Ok(raw)
    }
}
impl Drop for Buffer {
    fn drop(&mut self) {
        // SAFETY: 本物件擁有且只釋放一次這個參照。
        unsafe { av_buffer_unref(&mut self.0) }
    }
}

pub(super) struct Frame(pub *mut AVFrame);
// SAFETY: AVFrame 的獨佔擁有權隨物件移交；GPU 資源由 D3D11 multithread 保護。
unsafe impl Send for Frame {}
impl Frame {
    pub fn new() -> Result<Self> {
        check_version()?;
        // SAFETY: 配置函式沒有前置條件。
        let raw = unsafe { av_frame_alloc() };
        ensure!(!raw.is_null(), "配置 AVFrame 失敗");
        Ok(Self(raw))
    }
    pub fn duplicate(&self) -> Result<Self> {
        // SAFETY: 有效影格；新影格擁有獨立的 AVBuffer 參照。
        let raw = unsafe { av_frame_clone(self.0) };
        ensure!(!raw.is_null(), "複製 AVFrame 參照失敗");
        Ok(Self(raw))
    }
}
impl Drop for Frame {
    fn drop(&mut self) {
        // SAFETY: 本物件擁有影格；FFmpeg 同時釋放影格的參照。
        unsafe { av_frame_free(&mut self.0) }
    }
}

pub(super) struct Packet(pub *mut AVPacket);
impl Packet {
    pub fn new() -> Result<Self> {
        check_version()?;
        // SAFETY: 配置函式沒有前置條件。
        let raw = unsafe { av_packet_alloc() };
        ensure!(!raw.is_null(), "配置 AVPacket 失敗");
        Ok(Self(raw))
    }
}
impl Drop for Packet {
    fn drop(&mut self) {
        // SAFETY: 本物件擁有封包；av_packet_free 接受空指標。
        unsafe { av_packet_free(&mut self.0) }
    }
}

pub(super) struct Encoder(pub *mut AVCodecContext);
// SAFETY: context 建立後只由單一編碼執行緒存取，移交期間沒有並行呼叫。
unsafe impl Send for Encoder {}
impl Encoder {
    pub fn allocate(name: &CStr) -> Result<Self> {
        check_version()?;
        // SAFETY: name 是以 NUL 結尾的有效字串；codec 是 FFmpeg 靜態物件。
        unsafe {
            let codec = avcodec_find_encoder_by_name(name.as_ptr());
            ensure!(!codec.is_null(), "找不到編碼器 {}", name.to_string_lossy());
            let raw = avcodec_alloc_context3(codec);
            ensure!(!raw.is_null(), "配置編碼器失敗");
            Ok(Self(raw))
        }
    }
    pub fn open(&self) -> Result<()> {
        // SAFETY: context 已配置完成；codec 在配置時已指定。
        unsafe {
            check(
                avcodec_open2(self.0, ptr::null(), ptr::null_mut()),
                "開啟編碼器",
            )
        }
    }
    pub fn option(&self, name: &CStr, value: &CStr) -> Result<()> {
        // SAFETY: priv_data 由 avcodec_alloc_context3 建立，字串在呼叫期間有效。
        unsafe {
            check(
                av_opt_set((*self.0).priv_data, name.as_ptr(), value.as_ptr(), 0),
                "設定編碼選項",
            )
        }
    }
    pub fn send(&self, frame: Option<&Frame>) -> Result<Vec<Packet>> {
        let mut mapped = None;
        if let Some(source) = frame {
            // SAFETY: context 與 source 皆有效；QSV 必須映射同一 D3D11 表面，完全不讀回 CPU。
            unsafe {
                if (*self.0).pix_fmt == AV_PIX_FMT_QSV {
                    let output = Frame::new()?;
                    (*output.0).format = AV_PIX_FMT_QSV;
                    (*output.0).hw_frames_ctx = av_buffer_ref((*self.0).hw_frames_ctx);
                    ensure!(
                        !(*output.0).hw_frames_ctx.is_null(),
                        "取得 QSV 表面池參照失敗"
                    );
                    check(
                        av_hwframe_map(output.0, source.0, AV_HWFRAME_MAP_READ),
                        "映射 D3D11 至 QSV",
                    )?;
                    (*output.0).pts = (*source.0).pts;
                    (*output.0).duration = (*source.0).duration;
                    (*output.0).pict_type = (*source.0).pict_type;
                    mapped = Some(output);
                }
            }
        }
        let frame = mapped.as_ref().or(frame);
        // SAFETY: 編碼器及可選影格均有效；空影格表示完成輸入。
        unsafe {
            check(
                avcodec_send_frame(self.0, frame.map_or(ptr::null(), |f| f.0)),
                "送出編碼影格",
            )?;
            let mut packets = Vec::new();
            loop {
                let packet = Packet::new()?;
                let code = avcodec_receive_packet(self.0, packet.0);
                if code == AGAIN || code == EOF {
                    break;
                }
                check(code, "接收編碼封包")?;
                packets.push(packet);
            }
            Ok(packets)
        }
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: 本物件獨佔 context；釋放會一併歸還硬體參照。
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
                assert!(error.contains(&format!("綁定需要 {expected}")));
                assert!(error.contains(&format!("實際載入 {actual}")));
            }
        }
    }
}
