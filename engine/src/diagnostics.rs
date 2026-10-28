use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Frame {
    pub filename: String,
    pub function: String,
    pub lineno: u32,
}
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ExceptionDetails {
    #[serde(rename = "type")]
    pub kind: String,
    pub frames: Vec<Frame>,
}
pub fn exception_details(kind: &str, frames: impl IntoIterator<Item = Frame>) -> ExceptionDetails {
    let mut frames: Vec<_> = frames
        .into_iter()
        .filter_map(|f| {
            let file = f.filename.replace('\\', "/");
            let relative = if let Some(i) = file.rfind("/aditor/") {
                &file[i + 1..]
            } else if file.starts_with("aditor/") {
                &file
            } else {
                return None;
            };
            if relative.split('/').any(|s| s == "..") {
                return None;
            }
            Some(Frame {
                filename: relative.into(),
                function: f.function.chars().take(160).collect(),
                lineno: f.lineno,
            })
        })
        .collect();
    if frames.len() > 30 {
        frames.drain(..frames.len() - 30);
    }
    ExceptionDetails {
        kind: kind.chars().take(100).collect(),
        frames,
    }
}
