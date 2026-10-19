//! 共享記憶體環形緩衝（任務 B4），Python live 引擎是讀端（規格 §3.3）。
//!
//! 具名 file mapping `Local\aditorrec-<sessionId>`，所有整數為 little-endian。
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
//! （每步之間 Release fence）。序號以對齊的 64 位元原子操作存取；可變資料以逐 byte 原子操作存取，
//! 避免同一程序內的讀寫形成資料競爭。讀端：Acquire 讀 `latest_seq`，定位該槽，Acquire 讀 `seq_end`
//! → 複製資料 → Acquire fence → Acquire 讀 `seq_begin`；兩者都等於預期 seq 且非 0 才有效，
//! 否則視為撕裂丟棄。不可用未同步的 Rust slice 複製可變資料。寫端永不等待讀端。
//! 讀端應在收到 started 後開啟 mapping、驗證 header；不可快取槽內資料的參照。

use std::sync::atomic::{fence, AtomicU64, AtomicU8, Ordering};

use anyhow::{bail, Context, Result};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, INVALID_HANDLE_VALUE,
};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};

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
    format!("Local\\aditorrec-{session_id}")
}

pub struct ShmWriter {
    mapping: Mapping,
    sizes: Sizes,
    seq: u64,
}

impl ShmWriter {
    pub fn create(name: &str, layout: ShmLayout) -> Result<Self> {
        let sizes = Sizes::new(layout)?;
        if name.is_empty() || name.contains('\0') {
            bail!("共享記憶體名稱不可為空或含 NUL");
        }
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let total = sizes.total as u64;
        // SAFETY: 名稱以 NUL 結尾；大小已檢查，INVALID_HANDLE_VALUE 表示分頁檔支援的 mapping。
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                (total >> 32) as u32,
                total as u32,
                PCWSTR(name.as_ptr()),
            )
            .context("建立共享記憶體失敗")?
        };
        // SAFETY: 緊接建立呼叫讀取本執行緒的錯誤碼，不受其他 Windows 呼叫干擾。
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let mut mapping = Mapping {
            handle,
            view: MEMORY_MAPPED_VIEW_ADDRESS::default(),
            bytes: sizes.total,
        };
        if exists {
            bail!("共享記憶體名稱已存在，拒絕覆寫既有工作");
        }
        // SAFETY: handle 由本物件持有，映射長度等於建立時的已驗證大小。
        mapping.view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, sizes.total) };
        if mapping.view.Value.is_null() {
            return Err(windows::core::Error::from_thread()).context("映射共享記憶體失敗");
        }
        // 新的分頁檔 mapping 初始全為 0；序號及保留欄位維持此值。
        mapping.store_bytes(0, SHM_MAGIC);
        for (offset, value) in [
            (8, SHM_VERSION),
            (12, SHM_SLOTS),
            (16, sizes.slot as u32),
            (20, layout.banner.0),
            (24, layout.banner.1),
            (28, layout.spec.0),
            (32, layout.spec.1),
            (36, layout.thumb.0),
            (40, layout.thumb.1),
        ] {
            mapping.store_bytes(offset, &value.to_le_bytes());
        }
        fence(Ordering::Release);
        Ok(Self {
            mapping,
            sizes,
            seq: 0,
        })
    }

    /// 寫入一槽並回傳其 seq（從 1 開始遞增）。資料長度必須符合 layout，否則回傳錯誤。
    pub fn write(
        &mut self,
        pts: i64,
        banner: &[u8],
        spec: &[u8],
        thumb: Option<&[u8]>,
    ) -> Result<u64> {
        if banner.len() != self.sizes.banner
            || spec.len() != self.sizes.spec
            || thumb.is_some_and(|data| data.len() != self.sizes.thumb)
        {
            bail!("小圖資料長度與共享記憶體版面不符");
        }
        let seq = self.seq.checked_add(1).context("共享記憶體序號已耗盡")?;
        let slot = SHM_HEADER_BYTES + ((seq - 1) % u64::from(SHM_SLOTS)) as usize * self.sizes.slot;
        let end = slot + self.sizes.slot - 8;
        self.mapping.word_at(end).store(0, Ordering::Release);
        fence(Ordering::Release);
        self.mapping
            .word_at(slot)
            .store(seq.to_le(), Ordering::Release);
        fence(Ordering::Release);
        self.mapping.store_bytes(slot + 8, &pts.to_le_bytes());
        self.mapping
            .store_bytes(slot + 16, &u32::from(thumb.is_some()).to_le_bytes());
        self.mapping.store_bytes(slot + 24, banner);
        self.mapping
            .store_bytes(slot + 24 + self.sizes.banner, spec);
        if let Some(thumb) = thumb {
            self.mapping
                .store_bytes(slot + 24 + self.sizes.banner + self.sizes.spec, thumb);
        }
        fence(Ordering::Release);
        self.mapping
            .word_at(end)
            .store(seq.to_le(), Ordering::Release);
        fence(Ordering::Release);
        self.mapping
            .word_at(48)
            .store(seq.to_le(), Ordering::Release);
        self.seq = seq;
        Ok(seq)
    }
}

struct Sizes {
    banner: usize,
    spec: usize,
    thumb: usize,
    slot: usize,
    total: usize,
}

impl Sizes {
    fn new(layout: ShmLayout) -> Result<Self> {
        let image_bytes = |(w, h): (u32, u32), channels: usize| -> Result<usize> {
            if w == 0 || h == 0 {
                bail!("共享記憶體的小圖尺寸必須大於 0");
            }
            (w as usize)
                .checked_mul(h as usize)
                .and_then(|n| n.checked_mul(channels))
                .context("共享記憶體的小圖尺寸溢位")
        };
        let banner = image_bytes(layout.banner, 3)?;
        let spec = image_bytes(layout.spec, 3)?;
        let thumb = image_bytes(layout.thumb, 1)?;
        let slot = banner
            .checked_add(spec)
            .and_then(|n| n.checked_add(thumb))
            .and_then(|n| n.checked_add(32 + 7))
            .map(|n| n & !7)
            .filter(|n| *n <= u32::MAX as usize)
            .context("共享記憶體槽大小溢位")?;
        let total = slot
            .checked_mul(SHM_SLOTS as usize)
            .and_then(|n| n.checked_add(SHM_HEADER_BYTES))
            .filter(|n| *n <= isize::MAX as usize)
            .context("共享記憶體總大小溢位")?;
        Ok(Self {
            banner,
            spec,
            thumb,
            slot,
            total,
        })
    }
}

struct Mapping {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    bytes: usize,
}

// SAFETY: mapping 由單一物件持有；移到另一執行緒不改變位址，所有可變資料以原子操作存取。
unsafe impl Send for Mapping {}

impl Mapping {
    fn byte_at(&self, offset: usize) -> &AtomicU8 {
        assert!(offset < self.bytes);
        // SAFETY: view 在 self 的生命週期內可讀寫；offset 已檢查，AtomicU8 無額外對齊要求。
        unsafe { AtomicU8::from_ptr(self.view.Value.cast::<u8>().add(offset)) }
    }

    fn word_at(&self, offset: usize) -> &AtomicU64 {
        assert!(offset.is_multiple_of(8) && offset <= self.bytes - 8);
        // SAFETY: view 可讀寫且基址按頁對齊；序號欄位 8 對齊，不與 byte 存取範圍重疊。
        unsafe { AtomicU64::from_ptr(self.view.Value.cast::<u8>().add(offset).cast()) }
    }

    fn store_bytes(&self, offset: usize, data: &[u8]) {
        for (i, byte) in data.iter().enumerate() {
            self.byte_at(offset + i).store(*byte, Ordering::Relaxed);
        }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: view 及 handle 只由本物件釋放一次；未成功映射時只關閉 handle。
        unsafe {
            if !self.view.Value.is_null() {
                let _ = UnmapViewOfFile(self.view);
            }
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use windows::Win32::System::Memory::OpenFileMappingW;

    static NAMES: AtomicUsize = AtomicUsize::new(0);

    fn name() -> String {
        shm_name(&format!(
            "test-{}-{}",
            std::process::id(),
            NAMES.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn layout() -> ShmLayout {
        ShmLayout {
            banner: (7, 3),
            spec: (5, 2),
            thumb: (4, 2),
        }
    }

    struct Reader {
        mapping: Mapping,
        slot: usize,
    }

    impl Reader {
        fn open(name: &str, sizes: &Sizes) -> Self {
            let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            // SAFETY: 名稱以 NUL 結尾；測試寫端仍持有相同名稱的有效 mapping。
            let handle =
                unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(name.as_ptr())) }
                    .unwrap();
            let mut mapping = Mapping {
                handle,
                view: MEMORY_MAPPED_VIEW_ADDRESS::default(),
                bytes: sizes.total,
            };
            // SAFETY: 大小來自相同版面；Atomic::from_ptr 要求可讀寫 view，讀端僅執行 load。
            mapping.view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, sizes.total) };
            assert!(!mapping.view.Value.is_null());
            Self {
                mapping,
                slot: sizes.slot,
            }
        }

        fn bytes(&self, offset: usize, count: usize) -> Vec<u8> {
            (offset..offset + count)
                .map(|i| self.mapping.byte_at(i).load(Ordering::Relaxed))
                .collect()
        }

        fn u32(&self, offset: usize) -> u32 {
            u32::from_le_bytes(self.bytes(offset, 4).try_into().unwrap())
        }

        fn latest(&self) -> u64 {
            u64::from_le(self.mapping.word_at(48).load(Ordering::Acquire))
        }

        fn read(&self, expected: u64) -> Option<Vec<u8>> {
            if expected == 0 {
                return None;
            }
            let offset =
                SHM_HEADER_BYTES + ((expected - 1) % u64::from(SHM_SLOTS)) as usize * self.slot;
            let end = u64::from_le(
                self.mapping
                    .word_at(offset + self.slot - 8)
                    .load(Ordering::Acquire),
            );
            if end != expected {
                return None;
            }
            let data = self.bytes(offset + 8, self.slot - 16);
            fence(Ordering::Acquire);
            let begin = u64::from_le(self.mapping.word_at(offset).load(Ordering::Acquire));
            (begin == end).then_some(data)
        }
    }

    #[test]
    fn mapping_header_slot_alignment_and_forty_writes_round_trip() {
        let layout = layout();
        let name = name();
        let mut writer = ShmWriter::create(&name, layout).unwrap();
        let reader = Reader::open(&name, &writer.sizes);
        assert_eq!(reader.bytes(0, 8), SHM_MAGIC);
        for (offset, value) in [
            (8, 1),
            (12, 16),
            (16, 136),
            (20, 7),
            (24, 3),
            (28, 5),
            (32, 2),
            (36, 4),
            (40, 2),
            (44, 0),
        ] {
            assert_eq!(reader.u32(offset), value, "欄位 offset={offset}");
        }
        assert_eq!(reader.latest(), 0);
        assert_eq!(reader.bytes(56, 8), [0; 8]);
        assert!(reader.read(0).is_none());
        for seq in 1..=40 {
            let banner = vec![seq as u8; writer.sizes.banner];
            let spec = vec![seq as u8 + 1; writer.sizes.spec];
            let thumb = vec![seq as u8 + 2; writer.sizes.thumb];
            let has_thumb = seq % 4 == 0;
            assert_eq!(
                writer
                    .write(
                        seq * 10,
                        &banner,
                        &spec,
                        has_thumb.then_some(thumb.as_slice())
                    )
                    .unwrap(),
                seq as u64
            );
            assert_eq!(reader.latest(), seq as u64);
            let data = reader.read(seq as u64).unwrap();
            assert_eq!(i64::from_le_bytes(data[..8].try_into().unwrap()), seq * 10);
            assert_eq!(
                u32::from_le_bytes(data[8..12].try_into().unwrap()),
                u32::from(has_thumb)
            );
            assert_eq!(&data[12..16], &[0; 4]);
            assert_eq!(&data[16..16 + banner.len()], banner);
            assert_eq!(
                &data[16 + banner.len()..16 + banner.len() + spec.len()],
                spec
            );
            if has_thumb {
                assert_eq!(
                    &data[16 + banner.len() + spec.len()
                        ..16 + banner.len() + spec.len() + thumb.len()],
                    thumb
                );
            }
            let offset = SHM_HEADER_BYTES + ((seq as usize - 1) % SHM_SLOTS as usize) * reader.slot;
            assert_eq!(
                u64::from_le(reader.mapping.word_at(offset).load(Ordering::Acquire)),
                seq as u64
            );
        }
        assert!(reader.read(24).is_none());
        assert!(reader.read(25).is_some());
        drop(writer);
        assert!(reader.read(40).is_some()); // 讀端 view 保持 mapping 存活。
    }

    #[test]
    fn invalid_lengths_do_not_publish_or_advance_sequence() {
        let mut writer = ShmWriter::create(&name(), layout()).unwrap();
        let banner = vec![1; writer.sizes.banner];
        let spec = vec![2; writer.sizes.spec];
        let thumb = vec![3; writer.sizes.thumb];
        assert!(writer.write(1, &banner[..1], &spec, None).is_err());
        assert!(writer.write(1, &banner, &spec[..1], None).is_err());
        assert!(writer.write(1, &banner, &spec, Some(&thumb[..1])).is_err());
        assert_eq!(writer.seq, 0);
        assert_eq!(writer.mapping.word_at(48).load(Ordering::Acquire), 0);
        assert_eq!(writer.write(1, &banner, &spec, None).unwrap(), 1);
        assert!(writer.write(2, &[], &spec, None).is_err());
        assert_eq!(writer.seq, 1);
    }

    #[test]
    fn invalid_names_sizes_and_duplicate_mapping_are_rejected() {
        assert!(ShmWriter::create("", layout()).is_err());
        assert!(ShmWriter::create("含\0字元", layout()).is_err());
        assert!(Sizes::new(ShmLayout {
            banner: (0, 1),
            ..layout()
        })
        .is_err());
        assert!(Sizes::new(ShmLayout {
            banner: (u32::MAX, u32::MAX),
            ..layout()
        })
        .is_err());
        let name = name();
        let writer = ShmWriter::create(&name, layout()).unwrap();
        assert!(ShmWriter::create(
            &name,
            ShmLayout {
                banner: (1, 1),
                ..layout()
            }
        )
        .is_err());
        drop(writer);
        assert!(ShmWriter::create(&name, layout()).is_ok());
    }

    #[test]
    fn sequence_exhaustion_is_rejected_without_publishing_zero() {
        let mut writer = ShmWriter::create(&name(), layout()).unwrap();
        writer.seq = u64::MAX;
        assert!(writer
            .write(
                0,
                &vec![0; writer.sizes.banner],
                &vec![0; writer.sizes.spec],
                None
            )
            .is_err());
        assert_eq!(writer.mapping.word_at(48).load(Ordering::Acquire), 0);
    }

    #[test]
    fn named_mapping_is_readable_from_another_process() {
        const NAME_ENV: &str = "ADITORREC_B4_TEST_MAPPING";
        let sizes = Sizes::new(layout()).unwrap();
        if let Ok(name) = std::env::var(NAME_ENV) {
            let reader = Reader::open(&name, &sizes);
            assert_eq!(reader.latest(), 1);
            let data = reader.read(1).unwrap();
            assert_eq!(i64::from_le_bytes(data[..8].try_into().unwrap()), -123);
            assert_eq!(&data[16..16 + sizes.banner], vec![42; sizes.banner]);
            assert_eq!(
                &data[16 + sizes.banner..16 + sizes.banner + sizes.spec],
                vec![43; sizes.spec]
            );
            return;
        }
        let name = name();
        let mut writer = ShmWriter::create(&name, layout()).unwrap();
        writer
            .write(-123, &vec![42; sizes.banner], &vec![43; sizes.spec], None)
            .unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "shm::tests::named_mapping_is_readable_from_another_process",
                "--nocapture",
            ])
            .env(NAME_ENV, &name)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn concurrent_readers_never_accept_torn_frames() {
        const WRITES: u64 = 20_000;
        let name = name();
        let mut writer = ShmWriter::create(
            &name,
            ShmLayout {
                banner: (32, 16),
                spec: (16, 8),
                thumb: (16, 8),
            },
        )
        .unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(4));
        let readers: Vec<_> = (0..3)
            .map(|_| {
                let reader = Reader::open(&name, &writer.sizes);
                let done = done.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    let mut accepted = 0;
                    barrier.wait();
                    loop {
                        let finished = done.load(Ordering::Acquire);
                        let seq = reader.latest();
                        if let Some(data) = reader.read(seq) {
                            assert_eq!(
                                i64::from_le_bytes(data[..8].try_into().unwrap()),
                                seq as i64
                            );
                            assert_eq!(&data[8..12], &1u32.to_le_bytes());
                            assert!(data[16..].iter().all(|byte| *byte == seq as u8));
                            accepted += 1;
                        }
                        if finished {
                            assert_eq!(seq, WRITES);
                            break;
                        }
                    }
                    accepted
                })
            })
            .collect();
        barrier.wait();
        let mut banner = vec![0; writer.sizes.banner];
        let mut spec = vec![0; writer.sizes.spec];
        let mut thumb = vec![0; writer.sizes.thumb];
        for seq in 1..=WRITES {
            banner.fill(seq as u8);
            spec.fill(seq as u8);
            thumb.fill(seq as u8);
            writer
                .write(seq as i64, &banner, &spec, Some(&thumb))
                .unwrap();
        }
        done.store(true, Ordering::Release);
        for reader in readers {
            assert!(reader.join().unwrap() > 0);
        }
    }
}
