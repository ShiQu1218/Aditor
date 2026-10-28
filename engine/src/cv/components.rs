use super::Image;
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
#[derive(Debug, Serialize, Deserialize)]
pub struct Components {
    pub labels: Image<i32>,
    pub stats: Vec<[i32; 5]>,
    pub centroids: Vec<[f64; 2]>,
}
pub fn connected_components(src: &Image<u8>) -> Result<Components> {
    ensure!(src.channels == 1, "Components require grayscale");
    let mut labels = Image {
        width: src.width,
        height: src.height,
        channels: 1,
        data: vec![0i32; src.data.len()],
    };
    let mut next = 0;
    // OpenCV's default BBDT assigns labels in 2x2 block order, not pixel scan order.
    for by in (0..src.height).step_by(2) {
        for bx in (0..src.width).step_by(2) {
            for y in by..(by + 2).min(src.height) {
                for x in bx..(bx + 2).min(src.width) {
                    let seed = y * src.width + x;
                    if src.data[seed] == 0 || labels.data[seed] != 0 {
                        continue;
                    }
                    next += 1;
                    labels.data[seed] = next;
                    let mut todo = vec![(x, y)];
                    while let Some((x, y)) = todo.pop() {
                        for iy in y.saturating_sub(1)..=(y + 1).min(src.height - 1) {
                            for ix in x.saturating_sub(1)..=(x + 1).min(src.width - 1) {
                                let i = iy * src.width + ix;
                                if src.data[i] != 0 && labels.data[i] == 0 {
                                    labels.data[i] = next;
                                    todo.push((ix, iy));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let mut stats = vec![[i32::MAX, i32::MAX, 0, 0, 0]; next as usize + 1];
    let mut sums = vec![[0f64; 2]; stats.len()];
    for (i, &label) in labels.data.iter().enumerate() {
        let x = (i % src.width) as i32;
        let y = (i / src.width) as i32;
        let s = &mut stats[label as usize];
        s[0] = s[0].min(x);
        s[1] = s[1].min(y);
        s[2] = s[2].max(x);
        s[3] = s[3].max(y);
        s[4] += 1;
        sums[label as usize][0] += x as f64;
        sums[label as usize][1] += y as f64;
    }
    let mut centroids = Vec::new();
    for (s, sum) in stats.iter_mut().zip(sums) {
        if s[4] == 0 {
            *s = [-1, i32::MAX, 0, 0, 0];
            centroids.push([f64::NAN; 2]);
        } else {
            s[2] = s[2] - s[0] + 1;
            s[3] = s[3] - s[1] + 1;
            centroids.push([sum[0] / s[4] as f64, sum[1] / s[4] as f64]);
        }
    }
    Ok(Components {
        labels,
        stats,
        centroids,
    })
}
