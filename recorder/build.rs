use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=APEXREC_FFMPEG_DIR");
    let root = std::env::var_os("APEXREC_FFMPEG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build/ffmpeg"));
    println!(
        "cargo:rustc-link-search=native={}",
        root.join("lib").display()
    );
    for library in ["avcodec", "avformat", "avutil"] {
        println!("cargo:rustc-link-lib=dylib={library}");
    }
}
