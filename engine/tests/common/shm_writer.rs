#![allow(dead_code)]
//! Test-only recorder protocol producer, copied from recorder/src/shm.rs.
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
    pub killfeed: (u32, u32),
}

pub const SHM_MAGIC: &[u8; 8] = b"APXSHM01";
pub const SHM_VERSION: u32 = 2;
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
            bail!("Shared-memory name must not be empty or contain NUL");
        }
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let total = sizes.total as u64;
        // SAFETY: The name is NUL-terminated and size checked; INVALID_HANDLE_VALUE selects a pagefile-backed mapping.
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                (total >> 32) as u32,
                total as u32,
                PCWSTR(name.as_ptr()),
            )
            .context("Failed to create shared memory")?
        };
        // SAFETY: Read this thread's error code immediately after creation without intervening Windows calls.
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let mut mapping = Mapping {
            handle,
            view: MEMORY_MAPPED_VIEW_ADDRESS::default(),
            bytes: sizes.total,
        };
        if exists {
            bail!("Shared-memory name already exists; refusing to overwrite an existing session");
        }
        // SAFETY: This object owns handle; the mapping length equals the validated creation size.
        mapping.view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, sizes.total) };
        if mapping.view.Value.is_null() {
            return Err(windows::core::Error::from_thread()).context("Failed to map shared memory");
        }
        // New pagefile mappings start zeroed; sequence numbers and reserved fields retain that value.
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
            (44, layout.killfeed.0),
            (56, layout.killfeed.1),
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

    pub fn set_sequence(&mut self, seq: u64) {
        self.seq = seq;
    }

    /// Write one slot and return its seq (increasing from 1). Return an error if data lengths do not match the layout.
    pub fn write(
        &mut self,
        pts: i64,
        banner: &[u8],
        spec: &[u8],
        thumb: Option<&[u8]>,
        killfeed: Option<&[u8]>,
    ) -> Result<u64> {
        if banner.len() != self.sizes.banner
            || spec.len() != self.sizes.spec
            || thumb.is_some_and(|data| data.len() != self.sizes.thumb)
            || killfeed.map_or(0, |data| data.len()) != self.sizes.killfeed
        {
            bail!("Thumbnail data length does not match the shared-memory layout");
        }
        let seq = self
            .seq
            .checked_add(1)
            .context("Shared-memory sequence number exhausted")?;
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
        if let Some(feed) = killfeed {
            self.mapping.store_bytes(
                slot + 24 + self.sizes.banner + self.sizes.spec + self.sizes.thumb,
                feed,
            );
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
    killfeed: usize,
    slot: usize,
    total: usize,
}

impl Sizes {
    fn new(layout: ShmLayout) -> Result<Self> {
        let image_bytes = |(w, h): (u32, u32), channels: usize| -> Result<usize> {
            if w == 0 || h == 0 {
                bail!("Shared-memory thumbnail dimensions must be greater than zero");
            }
            (w as usize)
                .checked_mul(h as usize)
                .and_then(|n| n.checked_mul(channels))
                .context("Shared-memory thumbnail dimensions overflow")
        };
        let banner = image_bytes(layout.banner, 3)?;
        let spec = image_bytes(layout.spec, 3)?;
        let thumb = image_bytes(layout.thumb, 1)?;
        let killfeed = if layout.killfeed == (0, 0) {
            0
        } else {
            image_bytes(layout.killfeed, 3)?
        };
        let slot = banner
            .checked_add(spec)
            .and_then(|n| n.checked_add(thumb))
            .and_then(|n| n.checked_add(killfeed))
            .and_then(|n| n.checked_add(32 + 7))
            .map(|n| n & !7)
            .filter(|n| *n <= u32::MAX as usize)
            .context("Shared-memory slot size overflow")?;
        let total = slot
            .checked_mul(SHM_SLOTS as usize)
            .and_then(|n| n.checked_add(SHM_HEADER_BYTES))
            .filter(|n| *n <= isize::MAX as usize)
            .context("Shared-memory total size overflow")?;
        Ok(Self {
            banner,
            spec,
            thumb,
            killfeed,
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

// SAFETY: A single object owns the mapping; moving threads preserves its address, and all mutable data is accessed atomically.
unsafe impl Send for Mapping {}

impl Mapping {
    fn byte_at(&self, offset: usize) -> &AtomicU8 {
        assert!(offset < self.bytes);
        // SAFETY: view is readable/writable during self's lifetime; offset is checked, and AtomicU8 needs no extra alignment.
        unsafe { AtomicU8::from_ptr(self.view.Value.cast::<u8>().add(offset)) }
    }

    fn word_at(&self, offset: usize) -> &AtomicU64 {
        assert!(offset.is_multiple_of(8) && offset <= self.bytes - 8);
        // SAFETY: view is readable/writable with a page-aligned base; sequence fields are 8-byte aligned and do not overlap byte access ranges.
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
        // SAFETY: This object releases view and handle exactly once; only close handle if mapping failed.
        unsafe {
            if !self.view.Value.is_null() {
                let _ = UnmapViewOfFile(self.view);
            }
            let _ = CloseHandle(self.handle);
        }
    }
}
impl ShmWriter {
    pub fn tear_end(&self, seq: u64) {
        let offset = SHM_HEADER_BYTES
            + ((seq - 1) % u64::from(SHM_SLOTS)) as usize * self.sizes.slot
            + self.sizes.slot
            - 8;
        self.mapping.word_at(offset).store(0, Ordering::Release);
    }
}
