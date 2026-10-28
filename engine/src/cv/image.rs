use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Image<T> {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub data: Vec<T>,
}
impl<T: Clone> Image<T> {
    pub fn new(width: usize, height: usize, channels: usize, data: Vec<T>) -> Result<Self> {
        ensure!(
            width > 0
                && height > 0
                && channels > 0
                && width
                    .checked_mul(height)
                    .and_then(|n| n.checked_mul(channels))
                    == Some(data.len()),
            "Invalid image dimensions"
        );
        Ok(Self {
            width,
            height,
            channels,
            data,
        })
    }
    pub fn crop(&self, x: usize, y: usize, width: usize, height: usize) -> Result<Self> {
        ensure!(
            x.checked_add(width).is_some_and(|n| n <= self.width)
                && y.checked_add(height).is_some_and(|n| n <= self.height),
            "Crop outside image"
        );
        let mut data = Vec::with_capacity(width * height * self.channels);
        for row in y..y + height {
            data.extend_from_slice(
                &self.data[(row * self.width + x) * self.channels
                    ..(row * self.width + x + width) * self.channels],
            );
        }
        Self::new(width, height, self.channels, data)
    }
    pub fn split(&self) -> Vec<Self> {
        (0..self.channels)
            .map(|c| Self {
                width: self.width,
                height: self.height,
                channels: 1,
                data: self
                    .data
                    .iter()
                    .skip(c)
                    .step_by(self.channels)
                    .cloned()
                    .collect(),
            })
            .collect()
    }
    pub fn border(&self, top: usize, bottom: usize, left: usize, right: usize, value: T) -> Self {
        let width = self.width + left + right;
        let height = self.height + top + bottom;
        let mut data = vec![value; width * height * self.channels];
        for y in 0..self.height {
            let start = ((y + top) * width + left) * self.channels;
            data[start..start + self.width * self.channels].clone_from_slice(
                &self.data[y * self.width * self.channels..(y + 1) * self.width * self.channels],
            );
        }
        Self {
            width,
            height,
            channels: self.channels,
            data,
        }
    }
}
impl Image<u8> {
    pub fn float(&self) -> Image<f32> {
        Image {
            width: self.width,
            height: self.height,
            channels: self.channels,
            data: self.data.iter().map(|&v| v as f32).collect(),
        }
    }
}
pub fn read_png(path: &Path, gray: bool) -> Result<Image<u8>> {
    let img = image::open(path)?;
    if gray {
        // OpenCV's PNG grayscale decoder truncates BT.601 coefficients, unlike cvtColor.
        let rgb = img.to_rgb8();
        Image::new(
            rgb.width() as usize,
            rgb.height() as usize,
            1,
            rgb.pixels()
                .map(|p| {
                    ((p[0] as u32 * 9798 + p[1] as u32 * 19235 + p[2] as u32 * 3735) >> 15) as u8
                })
                .collect(),
        )
    } else {
        let mut rgb = img.to_rgb8();
        for p in rgb.pixels_mut() {
            p.0.swap(0, 2);
        }
        Image::new(
            rgb.width() as usize,
            rgb.height() as usize,
            3,
            rgb.into_raw(),
        )
    }
}
pub fn write_png(path: &Path, img: &Image<u8>) -> Result<()> {
    ensure!(
        img.channels == 1 || img.channels == 3,
        "PNG requires gray or BGR"
    );
    let mut data = img.data.clone();
    if img.channels == 3 {
        for p in data.as_chunks_mut::<3>().0.iter_mut() {
            p.swap(0, 2);
        }
    }
    image::save_buffer_with_format(
        path,
        &data,
        img.width as u32,
        img.height as u32,
        if img.channels == 1 {
            image::ColorType::L8
        } else {
            image::ColorType::Rgb8
        },
        image::ImageFormat::Png,
    )?;
    Ok(())
}
