//! 共享記憶體環形緩衝（任務 B4），Python live 引擎是讀端（規格 §3.3）。
//!
//! 具名 file mapping `Local\apexrec-<sessionId>`，所有整數為 little-endian。
//!
//! ```text
//! Header（64 bytes）
//!   0  [u8; 8]  magic = b"APXSHM01"
//!   8  u32      version = 1
//!  12  u32      slot_count = 16
//!  16  u32      slot_size（bytes，含槽頭，8 對齊）
//!  20  u32      banner_w   24 u32 banner_h
//!  28  u32      spec_w     32 u32 spec_h
//!  36  u32      thumb_w    40 u32 thumb_h
//!  44  u32      reserved
//!  48  u64      latest_seq（最新寫完的槽序號；0 = 尚無）
//!  56  u64      reserved
//! Slot i 位於 64 + i * slot_size，seq 對應槽 = (seq - 1) % slot_count
//!   0  u64      seq_begin
//!   8  i64      pts（100 ns tick）
//!  16  u32      has_thumb（0/1）
//!  20  u32      reserved
//!  24  [u8]     banner（banner_w*banner_h*3，BGR24）
//!      [u8]     spec（spec_w*spec_h*3，BGR24）
//!      [u8]     thumb（thumb_w*thumb_h，GRAY8；has_thumb=0 時內容無意義）
//!      pad 到 8 對齊
//!  slot_size-8  u64  seq_end
//! ```
//!
//! 寫入順序：`seq_end = 0` → `seq_begin = s` → 資料 → `seq_end = s` → header `latest_seq = s`
//! （每步之間 Release fence）。讀端：讀 `seq_end` → 複製資料 → 讀 `seq_begin`；兩者相等且非 0 才有效，
//! 否則視為撕裂丟棄。寫端永不等待讀端。

use anyhow::{bail, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShmLayout {
    pub banner: (u32, u32),
    pub spec: (u32, u32),
    pub thumb: (u32, u32),
}

pub const SHM_MAGIC: &[u8; 8] = b"APXSHM01";
pub const SHM_VERSION: u32 = 1;
pub const SHM_SLOTS: u32 = 16;
pub const SHM_HEADER_BYTES: usize = 64;

pub fn shm_name(session_id: &str) -> String {
    format!("Local\\apexrec-{session_id}")
}

pub struct ShmWriter {
    _private: (),
}

impl ShmWriter {
    pub fn create(_name: &str, _layout: ShmLayout) -> Result<Self> {
        bail!("shm 尚未實作")
    }

    /// 寫入一槽並回傳其 seq（從 1 開始遞增）。資料長度必須符合 layout，否則回傳錯誤。
    pub fn write(
        &mut self,
        _pts: i64,
        _banner: &[u8],
        _spec: &[u8],
        _thumb: Option<&[u8]>,
    ) -> Result<u64> {
        bail!("shm 尚未實作")
    }
}
