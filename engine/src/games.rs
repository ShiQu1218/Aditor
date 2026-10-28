pub use crate::errors::UnsupportedGame;
use crate::models::VideoInfo;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
pub const DEFAULT_GAME: &str = "apex";
pub const GAMES: &[&str] = &["apex", "valorant"];
pub fn parse_game(value: Option<&str>) -> Result<Option<String>> {
    (|| {
        let Some(value) = value.filter(|v| !v.is_empty()) else {
            return Ok(None);
        };
        let game = value.trim().to_lowercase();
        if !GAMES.contains(&game.as_str()) {
            bail!(
                "Unknown game: {} (supported: apex, valorant)",
                crate::profile::py_repr(&serde_json::Value::String(value.into()))
            );
        }
        Ok(Some(game))
    })()
    .map_err(|error: anyhow::Error| anyhow::Error::new(UnsupportedGame(error.to_string())))
}
pub fn resolve_game(explicit: Option<&str>, info: Option<&VideoInfo>) -> Result<String> {
    if let Some(game) = parse_game(explicit)? {
        return Ok(game);
    }
    let tag = info
        .and_then(|i| i.game.as_deref())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    Ok(if GAMES.contains(&tag.as_str()) {
        tag
    } else {
        DEFAULT_GAME.into()
    })
}
pub fn require_analyzable(game: &str) -> Result<()> {
    (|| {
        if !GAMES.contains(&game) {
            bail!("{game} analysis is not available yet");
        }
        Ok(())
    })()
    .map_err(|error: anyhow::Error| anyhow::Error::new(UnsupportedGame(error.to_string())))
}
pub fn profile_dir_for(base: &Path, game: &str) -> PathBuf {
    if game == DEFAULT_GAME {
        base.to_owned()
    } else {
        base.parent()
            .unwrap_or(Path::new(""))
            .join(game)
            .join("icons")
    }
}
