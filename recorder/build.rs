use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=APEXREC_FFMPEG_DIR");
    let root = std::env::var_os("APEXREC_FFMPEG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build/ffmpeg"));
    println!(
        "cargo:rustc-link-search=native={}",
        root.join("lib").display()
    );
    for library in ["avcodec", "avformat", "avutil"] {
        let path = root.join("lib").join(format!("{library}.lib"));
        assert!(
            path.is_file(),
            "找不到 FFmpeg 匯入程式庫 {}；請將 APEXREC_FFMPEG_DIR 設為含有 lib 與 bin 的 FFmpeg 根目錄",
            path.display()
        );
        println!("cargo:rustc-link-lib=dylib={library}");
    }
}
