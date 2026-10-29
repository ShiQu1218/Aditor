use crate::{
    cv::{self, Image, Interpolation},
    detect::{crop, ink_mask},
    mixtape::{text_match, MixtapeDetector},
    models::Event,
    profile::Profile,
    scene::SceneMatcher,
};
use anyhow::Result;

fn gray_strokes(image: &Image<u8>) -> Result<Image<u8>> {
    let gray = cv::gray(image)?;
    let kernel = cv::rect_kernel(7, 7)?;
    let light = cv::morphology(&gray, &kernel, cv::Morphology::TopHat);
    let dark = cv::morphology(&gray, &kernel, cv::Morphology::BlackHat);
    Ok(Image {
        data: light
            .data
            .iter()
            .zip(&dark.data)
            .map(|(&a, &b)| a.max(b))
            .collect(),
        ..gray
    })
}
fn glyph(mask: &Image<u8>) -> Option<Image<f32>> {
    let points: Vec<_> = mask
        .data
        .iter()
        .enumerate()
        .filter(|(_, v)| **v != 0)
        .map(|(i, _)| (i % mask.width, i / mask.width))
        .collect();
    if points.len() < 15 {
        return None;
    }
    let x0 = points.iter().map(|p| p.0).min()?;
    let x1 = points.iter().map(|p| p.0).max()? + 1;
    let y0 = points.iter().map(|p| p.1).min()?;
    let y1 = points.iter().map(|p| p.1).max()? + 1;
    Some(crop(mask, x0 as i32, y0 as i32, x1 as i32, y1 as i32).float())
}
fn similarity(a: &Image<f32>, b: &Image<f32>) -> Result<f64> {
    let score = cv::match_template(a, b, None)?.data[0] as f64;
    if score >= 0.60 {
        return Ok(score);
    }
    // Fading feed text shifts by a few pixels while retaining the same victim.
    Ok(cv::match_template(&a.border(2, 2, 2, 2, 0.), b, None)?
        .data
        .into_iter()
        .map(f64::from)
        .fold(score, f64::max))
}
fn weapon_shape(gray: &Image<u8>) -> Result<bool> {
    let mask = Image {
        data: gray.data.iter().map(|&v| u8::from(v >= 170)).collect(),
        ..gray.clone()
    };
    let components = cv::connected_components(&mask)?;
    let stats: Vec<_> = components
        .stats
        .iter()
        .skip(1)
        .filter(|s| s[4] >= 3)
        .collect();
    let total: i32 = stats.iter().map(|s| s[4]).sum();
    if total < 20 || total as usize * 10 > gray.width * gray.height * 9 {
        return Ok(false);
    }
    if stats.iter().any(|s| s[2] >= 12 && s[4] * 3 >= total * 2) {
        return Ok(true);
    }
    if stats.len() < 3 {
        return Ok(false);
    }
    let first = stats.iter().min_by_key(|s| s[0]).unwrap();
    let last = stats.iter().max_by_key(|s| s[0] + s[2]).unwrap();
    let height = stats.iter().map(|s| s[1] + s[3]).max().unwrap()
        - stats.iter().map(|s| s[1]).min().unwrap();
    let edge = |s: &[i32; 5], x: usize| {
        (s[1] as usize..(s[1] + s[3]) as usize)
            .filter(|&y| mask.data[y * mask.width + x] != 0)
            .count()
    };
    Ok((2..=5).contains(&first[2])
        && (2..=5).contains(&last[2])
        && first[3] * 4 >= height * 3
        && last[3] * 4 >= height * 3
        && edge(first, first[0] as usize) * 4 >= height as usize * 3
        && edge(last, (last[0] + last[2] - 1) as usize) * 4 >= height as usize * 3)
}
fn parts(xs: &[usize], gap: usize) -> Vec<&[usize]> {
    let mut start = 0;
    let mut out = vec![];
    for i in 1..xs.len() {
        if xs[i] - xs[i - 1] > gap {
            out.push(&xs[start..i]);
            start = i;
        }
    }
    if !xs.is_empty() {
        out.push(&xs[start..]);
    }
    out
}
struct Entry {
    sigs: Vec<Image<f32>>,
    first: f64,
    last: f64,
    hits: usize,
    emitted: bool,
}
pub struct ControlFeed {
    profile: Profile,
    names: MixtapeDetector,
    scene: SceneMatcher,
    br_counters: Vec<Image<u8>>,
    gunrun_damage: Image<u8>,
    pub active: bool,
    player: Option<Image<f32>>,
    entries: Vec<Entry>,
    pub events: Vec<Event>,
}
impl ControlFeed {
    pub fn new(p: &Profile) -> Result<Self> {
        let mut names = MixtapeDetector::new(p)?;
        let mut files = std::fs::read_dir(&p.dir)?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<Vec<_>>>()?;
        files.sort();
        for path in files {
            if path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("control_speaker"))
                && path.extension().is_some_and(|s| s == "png")
            {
                let mut speaker = cv::read_png(&path, true)?.float();
                for v in &mut speaker.data {
                    *v /= 255.;
                }
                names.speakers.push(speaker);
            }
        }
        let dir = p
            .dir
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .join("scene");
        Ok(Self {
            profile: p.clone(),
            names,
            scene: SceneMatcher::new(dir.is_dir().then_some(dir.as_path()))?,
            // The top-right counters are 10% larger than the banner icons.
            br_counters: ["skull", "hand"]
                .iter()
                .map(|name| {
                    cv::resize_factor(
                        &cv::read_png(&p.dir.join(format!("{name}.png")), true)?,
                        1.1,
                        1.1,
                        Interpolation::Linear,
                    )
                })
                .collect::<Result<_>>()?,
            gunrun_damage: cv::read_png(&p.dir.join("gunrun_damage.png"), true)?,
            active: false,
            player: None,
            entries: vec![],
            events: vec![],
        })
    }
    fn player_name(&self, spec: &Image<u8>) -> Result<Option<Image<f32>>> {
        let [sx, sy, _, _] = self.profile.spec_roi;
        if sy > 962 || sy + (spec.height as i32) < 990 {
            return Ok(None);
        }
        let hud = crop(spec, 0.max(172 - sx), 962 - sy, 0.max(420 - sx), 990 - sy);
        if hud.data.is_empty() {
            return Ok(None);
        }
        let gray = cv::gray(&hud)?;
        let binary = |level: f64| Image {
            data: gray
                .data
                .iter()
                .map(|&v| u8::from(v as f64 >= level))
                .collect(),
            ..gray.clone()
        };
        let mask = binary(self.profile.white["v_min"].as_f64().unwrap());
        let mut limit = hud.width;
        for level in [200, 170, 140] {
            let hm = binary(level as f64).float();
            for speaker in &self.names.speakers {
                let (score, x, _) = text_match(&hm, speaker)?;
                if score >= 0.75 {
                    limit = limit.min(x as usize);
                }
            }
        }
        Ok(glyph(&crop(&mask, 0, 0, limit as i32, mask.height as i32)))
    }
    pub fn rows(&mut self, feed: &Image<u8>, spec: &Image<u8>) -> Result<Vec<Image<f32>>> {
        let player = match &self.player {
            Some(player) => Some(player.clone()),
            None => self.player_name(spec)?,
        };
        let Some(player) = player else {
            return Ok(vec![]);
        };
        if player.data.iter().all(|&v| v == player.data[0]) {
            return Ok(vec![]);
        }
        let ink = ink_mask(feed)?;
        let mut candidates = vec![];
        // shortcut: normalized names are 14–22 px tall; expand for custom HUD text sizes.
        for height in [14, 16, 18, 20, 22] {
            let width = (player.width as f64 * height as f64 / player.height as f64)
                .round()
                .max(1.) as usize;
            if width > feed.width || height > feed.height {
                continue;
            }
            let template = cv::resize(&player, width, height, Interpolation::Linear)?;
            if template.data.iter().all(|&v| v == template.data[0]) {
                continue;
            }
            let scores = cv::match_template(&ink, &template, None)?;
            for (i, &score) in scores.data.iter().enumerate() {
                let (x, y) = (i % scores.width, i / scores.width);
                if score.is_finite()
                    && score >= 0.5
                    && y + (self.profile.killfeed_roi.unwrap()[1] as usize) >= 180
                {
                    candidates.push((score, x, y, width, height));
                }
            }
        }
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut names: Vec<(usize, usize, usize, usize)> = vec![];
        for (_, x, y, width, height) in candidates {
            if !names.iter().any(|&(nx, ny, nw, nh)| {
                x < nx + nw && nx < x + width && y < ny + nh && ny < y + height
            }) {
                names.push((x, y, width, height));
            }
        }
        names.sort_by_key(|name| name.1);
        let mut rows = vec![];
        for (x, y, width, height) in names {
            let end = x + width - 1;
            let y0 = y;
            let y1 = y + height;
            // shortcut: exclude the recorded feed's right padding; calibrate for custom HUD safe areas.
            let row = crop(
                feed,
                end as i32 + 1,
                y0 as i32,
                1814 - self.profile.killfeed_roi.unwrap()[0],
                y1 as i32,
            );
            if row.data.is_empty() {
                continue;
            }
            let mut contrast = gray_strokes(&row)?;
            let mut mask = Image {
                data: contrast.data.iter().map(|&v| u8::from(v >= 35)).collect(),
                ..contrast.clone()
            };
            // Long horizontal scene edges cannot be a weapon or a name glyph.
            let lines = cv::morphology(&mask, &cv::rect_kernel(81, 1)?, cv::Morphology::Open);
            for (i, &line) in lines.data.iter().enumerate() {
                if line != 0 {
                    mask.data[i] = 0;
                    contrast.data[i] = 0;
                }
            }
            let xs: Vec<_> = (0..mask.width)
                .filter(|&x| (0..mask.height).any(|y| mask.data[y * mask.width + x] != 0))
                .collect();
            let blocks = parts(&xs, 6);
            let Some(weapon) = blocks.first() else {
                continue;
            };
            let weapon_width = weapon.last().unwrap() - weapon[0] + 1;
            if !(6..=60).contains(&weapon[0]) || !(12..=80).contains(&weapon_width) {
                continue;
            }
            let shape = cv::gray(&crop(
                &row,
                weapon[0] as i32,
                0,
                *weapon.last().unwrap() as i32 + 1,
                row.height as i32,
            ))?;
            if !weapon_shape(&shape)? {
                continue;
            }
            let start = *weapon.last().unwrap() + 8;
            let contrast = crop(
                &contrast,
                start as i32,
                0,
                contrast.width as i32,
                contrast.height as i32,
            );
            let peak = contrast.data.iter().copied().max().unwrap_or(0);
            let mask = Image {
                data: contrast
                    .data
                    .iter()
                    .map(|&v| u8::from(v >= peak.max(12) / 3))
                    .collect(),
                ..contrast.clone()
            };
            let Some(victim) = glyph(&mask) else {
                continue;
            };
            if victim.height < 8
                || victim.width < 8
                || victim.data.iter().filter(|&&v| v != 0.).count() < 35
            {
                continue;
            }
            let width =
                ((victim.width as f64 * 24. / victim.height as f64).round() as usize).clamp(1, 400);
            let resized = cv::resize(&victim, width, 24, Interpolation::Linear)?;
            let sig = resized.border(0, 0, 400 - width, 0, 0.);
            if sig.data.iter().filter(|&&v| v != 0.).count() >= 15 {
                rows.push(sig);
                self.player = Some(player.clone());
            }
        }
        Ok(rows)
    }
    fn battle_royale_hud(&self, gray: &Image<u8>) -> Result<bool> {
        let [x, y, _, _] = self.profile.killfeed_roi.unwrap();
        // The kill-leader ornament changes the skull; the assist icon must still match strongly.
        for (template, (left, threshold)) in
            self.br_counters.iter().zip([(1540, 0.75), (1600, 0.85)])
        {
            let counter = crop(gray, left - x, 85 - y, left + 60 - x, 130 - y);
            if counter.width < template.width || counter.height < template.height {
                return Ok(false);
            }
            if !cv::match_template(&counter, template, None)?
                .data
                .iter()
                .any(|&score| score >= threshold)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub fn feed(
        &mut self,
        t: f64,
        feed: Option<&Image<u8>>,
        spec: &Image<u8>,
        thumb: Option<&Image<u8>>,
    ) -> Result<()> {
        let Some(feed) = feed else {
            return Ok(());
        };
        let scene = thumb
            .map(|thumb| self.scene.classify(thumb, self.profile.layout))
            .transpose()?;
        if matches!(scene, Some("pre_match" | "lobby")) {
            self.active = false;
            self.player = None;
            self.entries.clear();
        }
        let [x, y, w, h] = self.profile.killfeed_roi.unwrap();
        let (rw, rh) = (((x + w) / 3 - x / 3) as usize, (h / 3) as usize);
        let gray = cv::gray(feed)?;
        let image = cv::resize(&gray, rw, rh, Interpolation::Linear)?;
        let mut reference = Image::new(640, 360, 1, vec![0; 640 * 360])?;
        for yy in 0..rh {
            let start = (yy + y as usize / 3) * 640 + x as usize / 3;
            reference.data[start..start + rw].copy_from_slice(&image.data[yy * rw..(yy + 1) * rw]);
        }
        let objectives = self.scene.match_score(&reference, "control_objectives")? >= 0.8;
        if !self.active && (!objectives || scene.is_some_and(|kind| kind != "in_match_hud")) {
            return Ok(());
        }
        // BR and Gun Run counters override accidental objective matches.
        let damage = crop(&gray, 1765 - x, 60 - y, 1820 - x, 85 - y);
        let gunrun = damage.width >= self.gunrun_damage.width
            && damage.height >= self.gunrun_damage.height
            && cv::match_template(&damage, &self.gunrun_damage, None)?
                .data
                .iter()
                .any(|&score| score >= 0.85);
        if gunrun || self.battle_royale_hud(&gray)? {
            self.active = false;
            self.player = None;
            self.entries.clear();
            return Ok(());
        }
        self.active = true;
        let rows = self.rows(feed, spec)?;
        self.feed_rows(t, rows)
    }
    pub fn feed_rows(&mut self, t: f64, rows: Vec<Image<f32>>) -> Result<()> {
        // Low-contrast actor names can disappear for 2.5 seconds while the feed row remains visible.
        self.entries.retain(|e| t - e.last < 3.);
        let mut used = vec![];
        for sig in rows {
            let mut best = (0., None);
            for (i, e) in self
                .entries
                .iter()
                .enumerate()
                .filter(|(i, _)| !used.contains(i))
            {
                let mut score = f64::NEG_INFINITY;
                for old in &e.sigs {
                    score = score.max(similarity(old, &sig)?);
                }
                if score >= best.0 {
                    best = (score, Some(i));
                }
            }
            if best.0 < 0.60 || best.1.is_none() {
                used.push(self.entries.len());
                self.entries.push(Entry {
                    sigs: vec![sig],
                    first: t,
                    last: t,
                    hits: 1,
                    emitted: false,
                });
                continue;
            }
            let i = best.1.unwrap();
            used.push(i);
            let entry = &mut self.entries[i];
            entry.sigs.push(sig);
            if entry.sigs.len() > 4 {
                entry.sigs.remove(1);
            }
            entry.hits = if t - entry.last <= 0.5 {
                entry.hits + 1
            } else {
                1
            };
            entry.last = t;
            if entry.hits >= 2 && !entry.emitted {
                let first = entry.first;
                let ordinal = self.events.iter().filter(|e| e.t == first).count();
                self.events.push(Event {
                    id: format!("f{}-{ordinal}", (first * 1000.).round_ties_even() as i64),
                    t: first,
                    kind: "kill".into(),
                    score: best.0,
                    damage_line: false,
                    name_sig: None,
                    counted: false,
                    counted_reason: String::new(),
                    counted_override: None,
                    source: "auto".into(),
                    deleted: false,
                });
                entry.emitted = true;
            }
        }
        Ok(())
    }
}
