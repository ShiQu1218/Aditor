//! 真正的錄影 backend（整合任務 C）：把 capture → SegmentWriter／SmallFrameExtractor → ShmWriter、
//! audio → SegmentWriter 接起來，段落完成時寫 `index.jsonl` 並送 `segment` 事件，每 5 秒送 `stats`。

use crate::ipc::{Backend, BackendError, EventSink};
use crate::protocol::{AudioDevices, ErrorCode, HelloInfo, StartArgs};

#[derive(Default)]
pub struct Recorder;

impl Backend for Recorder {
    fn hello(&mut self) -> HelloInfo {
        HelloInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            encoders: Vec::new(),
            audio: AudioDevices::default(),
        }
    }

    fn start(&mut self, _args: StartArgs, _events: EventSink) -> Result<(), BackendError> {
        Err((ErrorCode::Internal, "錄影尚未實作".to_string()))
    }

    fn stop(&mut self) -> Result<(), BackendError> {
        Ok(())
    }
}
