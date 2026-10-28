mod common;
use aditor::ffbin;
use common::TempDir;
#[test]
fn explicit_missing_override_and_lookup_order() {
    // Run environment-sensitive checks in a child so parallel ffmpeg tests keep their environment.
    if std::env::var_os("ADITOR_FFBIN_TEST_CHILD").is_some() {
        let d = TempDir::new();
        let exe = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        std::env::set_var("ADITOR_FFMPEG", d.0.join("missing"));
        assert!(ffbin::ffmpeg()
            .unwrap_err()
            .to_string()
            .contains("ADITOR_FFMPEG="));
        let custom = d.0.join(exe);
        std::fs::write(&custom, []).unwrap();
        std::env::set_var("ADITOR_FFMPEG", &custom);
        assert_eq!(ffbin::ffmpeg().unwrap(), custom);
        std::env::remove_var("ADITOR_FFPROBE");
        let sibling = d.0.join(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
        std::fs::write(&sibling, []).unwrap();
        assert_eq!(ffbin::ffprobe().unwrap(), sibling);
        std::env::remove_var("ADITOR_FFMPEG");
        std::env::set_var("PATH", &d.0);
        let bundled = d.0.join("bundled");
        std::fs::create_dir_all(bundled.join("bin")).unwrap();
        let bundled_probe = bundled.join(sibling.file_name().unwrap());
        std::fs::write(&bundled_probe, []).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled).unwrap(),
            bundled_probe
        );
        std::fs::remove_file(&bundled_probe).unwrap();
        let bin_probe = bundled.join("bin").join(sibling.file_name().unwrap());
        std::fs::write(&bin_probe, []).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled).unwrap(),
            bin_probe
        );
        std::fs::remove_file(&bin_probe).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled).unwrap(),
            sibling
        );
        std::fs::remove_file(sibling).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled)
                .unwrap_err()
                .to_string(),
            "ffprobe not found (set ADITOR_FFPROBE, place in ffmpeg/ or add to PATH)"
        );
        return;
    }
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "explicit_missing_override_and_lookup_order",
            "--nocapture",
        ])
        .env("ADITOR_FFBIN_TEST_CHILD", "1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
