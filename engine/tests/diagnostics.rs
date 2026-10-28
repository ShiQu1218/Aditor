use aditor::diagnostics::*;
#[test]
fn excludes_absolute_paths_and_bounds_frames() {
    let frame = Frame {
        filename: "C:/Users/Alice/project/engine/aditor/example.rs".into(),
        function: "fail".into(),
        lineno: 3,
    };
    let details = exception_details("RuntimeError", [frame]);
    assert_eq!(details.frames[0].filename, "aditor/example.rs");
    assert!(!serde_json::to_string(&details).unwrap().contains("Alice"));
    let frames = (0..40).map(|i| Frame {
        filename: r"C:\private\aditor\test.rs".into(),
        function: "x".repeat(200),
        lineno: i,
    });
    let details = exception_details(&"E".repeat(200), frames);
    assert_eq!(details.kind.len(), 100);
    assert_eq!(details.frames.len(), 30);
    assert_eq!(details.frames[0].lineno, 10);
    assert_eq!(details.frames[0].function.len(), 160);
}
#[test]
fn excludes_external_and_parent_paths() {
    let frames = [
        "C:/private/other.rs",
        "aditor/../secret.rs",
        "aditor/safe.rs",
    ]
    .map(|f| Frame {
        filename: f.into(),
        function: "f".into(),
        lineno: 1,
    });
    let details = exception_details("Error", frames);
    assert_eq!(details.frames.len(), 1);
    assert_eq!(details.frames[0].filename, "aditor/safe.rs");
}
