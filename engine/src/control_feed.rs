use crate::{
    cv::{self, Image, Interpolation},
    detect::{crop, despeckle, white_mask},
    mixtape::{text_match, MixtapeDetector},
    models::Event,
    profile::Profile,
    scene::SceneMatcher,
};
use anyhow::Result;
use serde_json::json;

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
    Ok(cv::match_template(a, b, None)?.data[0] as f64)
}
fn player_similarity(actor: Option<Image<f32>>, player: &Image<f32>) -> Result<f64> {
    let Some(actor) = actor else {
        return Ok(0.);
    };
    let ratio =
        (actor.width as f64 / actor.height as f64) / (player.width as f64 / player.height as f64);
    if !(0.8..=1.25).contains(&ratio) {
        return Ok(0.);
    }
    let actor = cv::resize(&actor, 128, 24, Interpolation::Linear)?.border(1, 1, 1, 1, 0.);
    let player = cv::resize(player, 128, 24, Interpolation::Linear)?;
    let mut best = f64::NEG_INFINITY;
    for k in [1, 3] {
        // Binary glyph dilation keeps the interpolated float values, as OpenCV does.
        let mut dilated = player.clone();
        for y in 0..24 {
            for x in 0..128 {
                dilated.data[y * 128 + x] = (y.saturating_sub(k / 2)..=(y + k / 2).min(23))
                    .flat_map(|yy| {
                        (x.saturating_sub(k / 2)..=(x + k / 2).min(127)).map(move |xx| (yy, xx))
                    })
                    .map(|(yy, xx)| player.data[yy * 128 + xx])
                    .fold(0., f32::max);
            }
        }
        best = best.max(
            cv::match_template(&actor, &dilated, None)?
                .data
                .into_iter()
                .map(f64::from)
                .fold(f64::NEG_INFINITY, f64::max),
        );
    }
    Ok(best)
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
        let binary = |mut im: Image<u8>| {
            for v in &mut im.data {
                *v = u8::from(*v != 0);
            }
            im
        };
        let mask = binary(white_mask(&hud, &self.profile.white)?);
        let mut limit = hud.width;
        for level in [200, 170, 140] {
            let mut white = self.profile.white.clone();
            white["v_min"] = level.into();
            let hm = binary(white_mask(&hud, &white)?).float();
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
        let rows = self.rows_color(feed, spec, false)?;
        if rows.is_empty() {
            self.rows_color(feed, spec, true)
        } else {
            Ok(rows)
        }
    }
    fn rows_color(
        &mut self,
        feed: &Image<u8>,
        spec: &Image<u8>,
        blue: bool,
    ) -> Result<Vec<Image<f32>>> {
        let player = match &self.player {
            Some(player) => Some(player.clone()),
            None => self.player_name(spec)?,
        };
        let Some(player) = player else {
            return Ok(vec![]);
        };
        let mask = |data| Image {
            width: feed.width,
            height: feed.height,
            channels: 1,
            data,
        };
        let cyan = despeckle(
            &mask(
                feed.data
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .map(|p| {
                        u8::from(if blue {
                            p[0] > 110
                                && p[1] > 60
                                && (p[2] as f32) < p[1] as f32 * 0.8
                                && (p[0] as f32) > p[1] as f32 * 0.8
                        } else {
                            p[0] > 110
                                && p[1] > 140
                                && (p[2] as f32) < p[1] as f32 * 0.8
                                && (p[0] as f32) < p[1] as f32 * 1.12
                        })
                    })
                    .collect(),
            ),
            3,
        )?;
        let ys: Vec<_> = (0..cyan.height)
            .filter(|&y| {
                cyan.data[y * cyan.width..(y + 1) * cyan.width]
                    .iter()
                    .filter(|&&v| v != 0)
                    .count()
                    >= 4
            })
            .collect();
        let mut rows = vec![];
        for band in parts(&ys, 3) {
            if band.len() < 7 || band[0] as i32 + self.profile.killfeed_roi.unwrap()[1] < 180 {
                continue;
            }
            let (y0, y1) = (
                band[0].saturating_sub(2),
                (band[band.len() - 1] + 3).min(feed.height),
            );
            let name = crop(&cyan, 0, y0 as i32, cyan.width as i32, y1 as i32);
            let xs: Vec<_> = (0..name.width)
                .filter(|&x| (0..name.height).any(|y| name.data[y * name.width + x] != 0))
                .collect();
            let mut best = None;
            for cols in parts(&xs, 12) {
                let score = player_similarity(
                    glyph(&crop(
                        &name,
                        cols[0] as i32,
                        0,
                        (cols[cols.len() - 1] + 1) as i32,
                        name.height as i32,
                    )),
                    &player,
                )?;
                if best.is_none_or(|(s, _)| score > s) {
                    best = Some((score, cols[cols.len() - 1]));
                }
            }
            let Some((score, end)) = best else {
                continue;
            };
            if score < 0.50 {
                continue;
            }
            // shortcut: fixed recorded HUD edge; calibrate when custom HUD safe areas are supported.
            let row = crop(
                feed,
                end as i32 + 12,
                y0 as i32,
                1820 - self.profile.killfeed_roi.unwrap()[0],
                y1 as i32,
            );
            if row.data.is_empty() {
                continue;
            }
            let mask = despeckle(
                &Image {
                    width: row.width,
                    height: row.height,
                    channels: 1,
                    data: row
                        .data
                        .as_chunks::<3>()
                        .0
                        .iter()
                        .map(|p| {
                            u8::from(
                                p[2] > 140
                                    && p[2] as f32 > p[1] as f32 * 1.15
                                    && p[2] as f32 > p[0] as f32 * 1.5,
                            )
                        })
                        .collect(),
                },
                3,
            )?;
            let Some(victim) = glyph(&mask) else {
                continue;
            };
            if victim.height < 8 || victim.width < 8 {
                continue;
            }
            let left = (0..mask.width)
                .find(|&x| (0..mask.height).any(|y| mask.data[y * mask.width + x] != 0))
                .unwrap();
            if left == 0 {
                continue;
            }
            let weapon = white_mask(
                &crop(&row, 0, 0, left as i32, row.height as i32),
                &json!({"v_min":170,"s_max":80}),
            )?;
            if weapon.data.iter().filter(|&&v| v != 0).count() < 20
                || (0..weapon.width)
                    .filter(|&x| (0..weapon.height).any(|y| weapon.data[y * weapon.width + x] != 0))
                    .count()
                    < 12
            {
                continue;
            }
            let width = 400.min(mask.width);
            let resized = cv::resize(
                &crop(
                    &mask,
                    (mask.width - width) as i32,
                    0,
                    mask.width as i32,
                    mask.height as i32,
                )
                .float(),
                width,
                24,
                Interpolation::Linear,
            )?;
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
        self.entries.retain(|e| t - e.last < 2.);
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
