fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let command_name = args.first().cloned().unwrap_or_default();
    let analyzing = args.first().is_some_and(|s| s == "analyze");
    match aditor::cli::parse(args) {
        Ok(Some(cmd)) => {
            if let Err(error) = run(cmd) {
                eprintln!("Error: {error}");
                std::process::exit(1);
            }
        }
        Ok(None) if analyzing => println!(
            "{}\n{}",
            aditor::cli::ANALYZE_USAGE,
            aditor::cli::ANALYZE_HELP
        ),
        Ok(None) if command_name == "matches" => print!("{}", aditor::cli::MATCHES_HELP),
        Ok(None) if command_name == "live" => print!("{}", aditor::cli::LIVE_HELP),
        Ok(None) => println!("usage: aditor {{analyze,matches,ipc,live}} [options]"),
        Err(error) => {
            if analyzing {
                eprintln!(
                    "{}\naditor analyze: error: {error}",
                    aditor::cli::ANALYZE_USAGE
                );
            } else if matches!(command_name.as_str(), "matches" | "live") {
                eprintln!(
                    "{}\naditor {command_name}: error: {error}",
                    aditor::cli::usage(&command_name)
                );
            } else {
                eprintln!("aditor: error: {error}");
            }
            std::process::exit(2);
        }
    }
}

fn run(cmd: aditor::cli::Command) -> anyhow::Result<()> {
    use aditor::{
        analyze::{analyze, AnalyzeOptions},
        games, layout, profile,
    };
    use std::{io::Write, path::Path};
    if cmd.name.starts_with("debug-") {
        return aditor::debug::run(&cmd);
    }
    if cmd.name == "ipc" {
        return aditor::ipc::run();
    }
    let value = |key: &str| cmd.options.get(key).and_then(|v| v.as_deref());
    if cmd.name == "live" {
        std::process::exit(aditor::live::run(
            value("--shm").unwrap(),
            Path::new(value("--profile-dir").unwrap()),
            value("--scene-dir")
                .filter(|s| !s.is_empty())
                .map(Path::new),
            value("--aspect"),
            value("--game"),
        )?);
    }
    if cmd.name == "matches" {
        let doc = aditor::matches::analyze_matches(
            cmd.video.as_deref().unwrap(),
            value("--fps").map_or(1.0, |v| v.parse().unwrap()),
            cmd.options.contains_key("--timeline"),
            !cmd.options.contains_key("--no-hwaccel"),
            value("--aspect")
                .filter(|s| !s.is_empty())
                .map(layout::parse_aspect)
                .transpose()?,
            value("--scene-dir")
                .filter(|s| !s.is_empty())
                .map(Path::new),
        )?;
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&aditor::cache::json_bytes(&doc)?)?;
        writeln!(stdout)?;
        return Ok(());
    }
    let game = value("--game");
    games::parse_game(game)?;
    let p = profile::load_profile(Path::new(value("--profile-dir").unwrap()))?;
    let progress = |t: f64, duration: f64| {
        let pct = if duration > 0. {
            100. * t / duration
        } else {
            0.
        };
        eprint!("\rAnalyzing {t:8.1} / {duration:.1} seconds ({pct:5.1}%)");
        let _ = std::io::stderr().flush();
    };
    let doc = analyze(
        cmd.video.as_deref().unwrap(),
        &p,
        AnalyzeOptions {
            cache_dir: Path::new(value("--cache-dir").unwrap()),
            force: cmd.options.contains_key("--force"),
            on_progress: &progress,
            hwaccel: !cmd.options.contains_key("--no-hwaccel"),
            jobs: value("--jobs").map(|s| s.parse::<i64>().unwrap().max(1) as usize),
            layout: value("--aspect")
                .filter(|s| !s.is_empty())
                .map(layout::parse_aspect)
                .transpose()?,
            game,
            ..AnalyzeOptions::new(Path::new(""))
        },
    )?;
    eprintln!();
    if let Some(out) = value("--out") {
        std::fs::write(out, serde_json::to_string_pretty(&doc)?)?;
    }
    let events = doc["events"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid cache events: expected an array"))?;
    let counted = events
        .iter()
        .filter(|e| {
            !e["deleted"].as_bool().unwrap_or(false)
                && e["counted_override"]
                    .as_bool()
                    .unwrap_or(e["counted"].as_bool().unwrap_or(false))
        })
        .count();
    println!(
        "{} events ({counted} counted), cache: {}",
        events.len(),
        doc["cache_path"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid cache_path: expected a string"))?
    );
    Ok(())
}
