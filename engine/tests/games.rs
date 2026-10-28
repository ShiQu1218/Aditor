use aditor::{games::*, models::VideoInfo};
use std::path::Path;
#[test]
fn resolution_order_and_parsing() {
    let mut info = VideoInfo::default();
    assert_eq!(resolve_game(None, Some(&info)).unwrap(), "apex");
    for tag in ["valorant", "Valorant "] {
        info.game = Some(tag.into());
        assert_eq!(resolve_game(None, Some(&info)).unwrap(), "valorant");
        assert_eq!(resolve_game(Some("apex"), Some(&info)).unwrap(), "apex");
    }
    info.game = Some("csgo".into());
    assert_eq!(resolve_game(None, Some(&info)).unwrap(), "apex");
    assert!(parse_game(Some("")).unwrap().is_none());
    assert_eq!(
        parse_game(Some("csgo")).unwrap_err().to_string(),
        "Unknown game: 'csgo' (supported: apex, valorant)"
    );
    assert!(parse_game(Some(" ")).is_err());
}
#[test]
fn implemented_games_and_profile_paths() {
    for game in GAMES {
        require_analyzable(game).unwrap();
    }
    assert!(require_analyzable("csgo").is_err());
    let base = Path::new("res/templates/icons");
    assert_eq!(profile_dir_for(base, "apex"), base);
    assert_eq!(
        profile_dir_for(base, "valorant"),
        Path::new("res/templates/valorant/icons")
    );
}
