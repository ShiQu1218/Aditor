//! stdin 指令迴圈與 stdout 事件輸出（任務 B4）。錄影邏輯藏在 `Backend` 後面，
//! 讓迴圈可以用假的 backend 測試；真正的 backend 是 `session::Recorder`（整合任務 C）。
//!
//! 規則：每行一個 JSON；stdout 只寫協定訊息（由單一 writer 串行化，事件可來自任何執行緒）；
//! stdin EOF = 主程序已離開 → 等同 `stop` 後結束。同一時間只能有一個錄影工作（第二次 start 回 `busy`）。

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use crate::protocol::{ErrorCode, Event, HelloInfo, Reply, ReplyBody, StartArgs};

/// 可跨執行緒送出事件的 handle（clone 便宜）。
#[derive(Clone)]
pub struct EventSink {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl EventSink {
    pub fn new(out: Box<dyn Write + Send>) -> Self {
        Self {
            out: Arc::new(Mutex::new(out)),
        }
    }

    pub fn emit(&self, ev: &Event) {
        self.write_line(ev);
    }

    pub fn reply(&self, r: &Reply) {
        self.write_line(r);
    }

    fn write_line<T: serde::Serialize>(&self, v: &T) {
        let Ok(mut line) = serde_json::to_string(v) else {
            return;
        };
        line.push('\n');
        if let Ok(mut out) = self.out.lock() {
            let _ = out.write_all(line.as_bytes());
            let _ = out.flush();
        }
    }
}

pub type BackendError = (ErrorCode, String);

pub trait Backend {
    fn hello(&mut self) -> HelloInfo;
    fn start(&mut self, args: StartArgs, events: EventSink) -> Result<(), BackendError>;
    /// 沒有錄影工作時也要回 Ok（冪等）。
    fn stop(&mut self) -> Result<(), BackendError>;
}

/// 跑指令迴圈直到 stdin EOF。
pub fn run(_input: impl BufRead, _events: EventSink, _backend: &mut dyn Backend) {
    // 任務 B4 實作
    let _ = ReplyBody::Empty {};
}
