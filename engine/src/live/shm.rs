use crate::cv::Image;
use anyhow::{bail, ensure, Result};
use std::sync::atomic::{fence, AtomicU64, AtomicU8, Ordering};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShmLayout {
    pub banner: (usize, usize),
    pub spec: (usize, usize),
    pub thumb: (usize, usize),
    pub killfeed: (usize, usize),
}
impl ShmLayout {
    pub fn banner_bytes(&self) -> usize {
        self.banner.0 * self.banner.1 * 3
    }
    pub fn spec_bytes(&self) -> usize {
        self.spec.0 * self.spec.1 * 3
    }
    pub fn thumb_bytes(&self) -> usize {
        self.thumb.0 * self.thumb.1
    }
    pub fn killfeed_bytes(&self) -> usize {
        self.killfeed.0 * self.killfeed.1 * 3
    }
    pub fn slot_size(&self) -> usize {
        (self.banner_bytes() + self.spec_bytes() + self.thumb_bytes() + self.killfeed_bytes() + 39)
            & !7
    }
    pub fn total_size(&self) -> usize {
        64 + 16 * self.slot_size()
    }
}
#[derive(Debug)]
pub struct LayoutError(pub String);
impl std::fmt::Display for LayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for LayoutError {}
pub fn parse_header(buf: &[u8], size: usize) -> Result<ShmLayout> {
    (|| {
        if size < 64 || buf.len() < 64 {
            bail!("Shared memory is smaller than the header");
        }
        if &buf[..8] != b"APXSHM01" {
            bail!("Shared memory magic does not match");
        }
        let u = |off| u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
        let version = u(8);
        if version != 1 && version != 2 {
            bail!("Unsupported shared memory version: {version}");
        }
        if u(12) != 16 {
            bail!("Slot count does not match: {}", u(12));
        }
        let banner = (u(20), u(24));
        let spec = (u(28), u(32));
        let thumb = (u(36), u(40));
        if [banner.0, banner.1, spec.0, spec.1, thumb.0, thumb.1].contains(&0) {
            bail!("Thumbnail dimensions must be greater than 0");
        }
        if [banner, spec, thumb]
            .iter()
            .any(|&(w, h)| w > 1920 || h > 1080)
        {
            bail!("Thumbnail dimensions exceed 1920×1080");
        }
        let feed = if version >= 2 { (u(44), u(56)) } else { (0, 0) };
        if (feed.0 == 0) != (feed.1 == 0) || feed.0 > 1920 || feed.1 > 1080 {
            bail!("Invalid kill-feed dimensions");
        }
        let l = ShmLayout {
            banner,
            spec,
            thumb,
            killfeed: feed,
        };
        let mut total = 0usize;
        for (w, h, c) in [
            (banner.0, banner.1, 3),
            (spec.0, spec.1, 3),
            (thumb.0, thumb.1, 1),
            (feed.0, feed.1, 3),
        ] {
            total =
                total
                    .checked_add(w.checked_mul(h).and_then(|v| v.checked_mul(c)).ok_or_else(
                        || anyhow::anyhow!("Shared memory is smaller than the required layout"),
                    )?)
                    .ok_or_else(|| {
                        anyhow::anyhow!("Shared memory is smaller than the required layout")
                    })?;
        }
        let slot = total
            .checked_add(39)
            .map(|v| v & !7)
            .ok_or_else(|| anyhow::anyhow!("Shared memory is smaller than the required layout"))?;
        if u(16) != slot {
            bail!("Slot size does not match: {} != {slot}", u(16));
        }
        if slot
            .checked_mul(16)
            .and_then(|v| v.checked_add(64))
            .is_none_or(|n| n > size)
        {
            bail!("Shared memory is smaller than the required layout");
        }
        Ok(l)
    })()
    .map_err(|e: anyhow::Error| LayoutError(e.to_string()).into())
}
#[derive(Clone, Debug)]
pub struct Slot {
    pub seq: u64,
    pub pts: i64,
    pub banner: Image<u8>,
    pub spec: Image<u8>,
    pub thumb: Option<Image<u8>>,
    pub killfeed: Option<Image<u8>>,
}
#[cfg(windows)]
mod win {
    use super::*;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::Memory::{
                MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ,
                MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS,
            },
        },
    };
    pub struct Mapping {
        handle: HANDLE,
        view: MEMORY_MAPPED_VIEW_ADDRESS,
        pub size: usize,
    }
    impl Mapping {
        pub fn open(name: &str) -> Result<Self> {
            ensure!(
                !name.is_empty() && !name.contains('\0'),
                "Invalid shared-memory name"
            );
            let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            // SAFETY: The name is NUL-terminated; this object owns the returned handle and view.
            unsafe {
                let handle = OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name.as_ptr()))?;
                let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
                let mut m = Self {
                    handle,
                    view,
                    size: 0,
                };
                if m.view.Value.is_null() {
                    return Err(windows::core::Error::from_thread().into());
                }
                let mut mbi = MEMORY_BASIC_INFORMATION::default();
                if VirtualQuery(Some(m.view.Value), &mut mbi, std::mem::size_of_val(&mbi)) == 0 {
                    return Err(windows::core::Error::from_thread().into());
                }
                m.size = mbi.RegionSize;
                Ok(m)
            }
        }
        pub fn ptr(&self) -> *const u8 {
            self.view.Value.cast()
        }
    }
    impl Drop for Mapping {
        fn drop(&mut self) {
            // SAFETY: No slot references escape; each resource is owned and released once.
            unsafe {
                if !self.view.Value.is_null() {
                    let _ = UnmapViewOfFile(self.view);
                }
                let _ = CloseHandle(self.handle);
            }
        }
    }
}
#[cfg(windows)]
pub struct ShmReader {
    mapping: win::Mapping,
    layout: ShmLayout,
}
#[cfg(windows)]
impl ShmReader {
    /// The validated layout cannot be changed while its mapping is in use.
    /// ```compile_fail
    /// fn overwrite(reader: &mut aditor::live::ShmReader, layout: aditor::live::ShmLayout) {
    ///     reader.layout = layout;
    /// }
    /// ```
    pub fn layout(&self) -> ShmLayout {
        self.layout
    }
    pub fn open(name: &str) -> Result<Self> {
        let mapping = win::Mapping::open(name)?;
        let mut header = [0; 64];
        if mapping.size < 64 {
            return Err(LayoutError("Shared memory is smaller than the header".into()).into());
        }
        // SAFETY: Header bytes are inside the view and read atomically, including reserved mutable fields.
        unsafe {
            for (i, b) in header.iter_mut().enumerate() {
                if (48..56).contains(&i) {
                    continue;
                }
                *b = (&*mapping.ptr().add(i).cast::<AtomicU8>()).load(Ordering::Relaxed);
            }
        }
        let layout = parse_header(&header, mapping.size)?;
        Ok(Self { mapping, layout })
    }
    fn u64(&self, offset: usize) -> u64 {
        assert!(offset.is_multiple_of(8) && offset + 8 <= self.mapping.size);
        // SAFETY: Mapping base and offsets are 8-byte aligned and bounds checked.
        u64::from_le(unsafe {
            (&*self.mapping.ptr().add(offset).cast::<AtomicU64>()).load(Ordering::Acquire)
        })
    }
    fn bytes(&self, offset: usize, size: usize) -> Vec<u8> {
        assert!(offset + size <= self.mapping.size);
        // SAFETY: Atomic byte loads mirror recorder writes and avoid unsynchronized shared slices.
        (offset..offset + size)
            .map(|i| unsafe {
                (&*self.mapping.ptr().add(i).cast::<AtomicU8>()).load(Ordering::Relaxed)
            })
            .collect()
    }
    fn offset(&self, seq: u64) -> usize {
        64 + ((seq - 1) % 16) as usize * self.layout.slot_size()
    }
    pub fn latest(&self) -> u64 {
        self.u64(48)
    }
    pub fn peek_pts(&self, seq: u64) -> Option<i64> {
        if seq == 0 {
            return None;
        }
        let off = self.offset(seq);
        if self.u64(off + self.layout.slot_size() - 8) != seq {
            return None;
        }
        let pts = i64::from_le_bytes(self.bytes(off + 8, 8).try_into().unwrap());
        fence(Ordering::Acquire);
        (self.u64(off) == seq).then_some(pts)
    }
    pub fn read(&self, seq: u64) -> Option<Slot> {
        if seq == 0 {
            return None;
        }
        let l = self.layout;
        let off = self.offset(seq);
        if self.u64(off + l.slot_size() - 8) != seq {
            return None;
        }
        let pts = i64::from_le_bytes(self.bytes(off + 8, 8).try_into().unwrap());
        let has = u32::from_le_bytes(self.bytes(off + 16, 4).try_into().unwrap()) != 0;
        let mut pos = off + 24;
        let mut image = |dims: (usize, usize), channels: usize| {
            let n = dims.0 * dims.1 * channels;
            let data = self.bytes(pos, n);
            pos += n;
            Image {
                width: dims.0,
                height: dims.1,
                channels,
                data,
            }
        };
        let banner = image(l.banner, 3);
        let spec = image(l.spec, 3);
        let thumb = if has {
            Some(image(l.thumb, 1))
        } else {
            pos += l.thumb_bytes();
            None
        };
        let killfeed = if l.killfeed_bytes() > 0 {
            Some(Image {
                width: l.killfeed.0,
                height: l.killfeed.1,
                channels: 3,
                data: self.bytes(pos, l.killfeed_bytes()),
            })
        } else {
            None
        };
        fence(Ordering::Acquire);
        if self.u64(off) != seq {
            return None;
        }
        Some(Slot {
            seq,
            pts,
            banner,
            spec,
            thumb,
            killfeed,
        })
    }
}
