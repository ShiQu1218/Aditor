use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=ADITORREC_FFMPEG_DIR");
    let root = std::env::var_os("ADITORREC_FFMPEG_DIR")
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
            "FFmpeg import library not found: {}; set ADITORREC_FFMPEG_DIR to the FFmpeg root containing lib and bin",
            path.display()
        );
        println!("cargo:rustc-link-lib=dylib={library}");
    }
}
