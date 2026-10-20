//! stdin command loop and stdout events (task B4). Recording logic is abstracted behind `Backend`
//! so the loop can be tested with a fake backend; the real backend is `session::Recorder` (integration task C).
//!
//! Rules: one JSON value per line; stdout contains only protocol messages (serialized by one writer, with events from any thread);
//! stdin EOF means the main process exited: stop recording and exit. Only one recording can run at a time (another start returns `busy`).

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::protocol::{
    parse_request, Command, ErrorCode, Event, HelloInfo, Reply, ReplyBody, StartArgs,
    MAX_LINE_BYTES,
};

/// Handle for sending events across threads (cheap to clone).
#[derive(Clone)]
pub struct EventSink {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
    stopped: Arc<AtomicU64>,
}

impl EventSink {
    pub fn new(out: Box<dyn Write + Send>) -> Self {
        Self {
            out: Arc::new(Mutex::new(out)),
            stopped: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn emit(&self, ev: &Event) {
        if matches!(ev, Event::Stopped { .. }) {
            // Update state first so a start immediately after stopped does not see a stale busy state.
            self.stopped.fetch_add(1, Ordering::Release);
        }
        self.write_line(ev, None);
    }

    pub fn reply(&self, r: &Reply) {
        self.write_line(r, Some(r.id));
    }

    fn write_line<T: serde::Serialize>(&self, v: &T, id: Option<u64>) {
        let mut line = match serde_json::to_string(v) {
            Ok(line) if line.len() <= MAX_LINE_BYTES => line,
            Ok(_) => {
                self.output_error(id, format!("IPC output exceeds {MAX_LINE_BYTES} bytes"));
                return;
            }
            Err(error) => {
                eprintln!("IPC serialization failed: {error}");
                self.output_error(id, "IPC serialization failed".into());
                return;
            }
        };
        line.push('\n');
        if let Ok(mut out) = self.out.lock() {
            if let Err(error) = out.write_all(line.as_bytes()).and_then(|()| out.flush()) {
                eprintln!("IPC output failed: {error}");
            }
        } else {
            eprintln!("Failed to lock IPC output");
        }
    }

    fn output_error(&self, id: Option<u64>, message: String) {
        match id {
            Some(id) => reply_error(self, id, ErrorCode::Internal, message),
            None => self.emit(&Event::Error {
                code: ErrorCode::Internal,
                message,
            }),
        }
    }
}

pub type BackendError = (ErrorCode, String);

pub trait Backend {
    fn hello(&mut self) -> HelloInfo;
    fn start(&mut self, args: StartArgs, events: EventSink) -> Result<(), BackendError>;
    /// Return Ok even when no recording is running (idempotent).
    fn stop(&mut self) -> Result<(), BackendError>;
    fn is_running(&self) -> bool;
}

/// Run the command loop until stdin EOF.
pub fn run(mut input: impl BufRead, events: EventSink, backend: &mut dyn Backend) {
    let mut recording = false;
    let mut stopped_generation = events.stopped.load(Ordering::Acquire);
    loop {
        let bytes = match read_bounded_line(&mut input) {
            Ok(InputLine::Eof) => break,
            Ok(InputLine::TooLong) => {
                reply_error(
                    &events,
                    0,
                    ErrorCode::BadRequest,
                    format!("Command exceeds {MAX_LINE_BYTES} bytes"),
                );
                continue;
            }
            Ok(InputLine::Data(bytes)) => bytes,
            Err(error) => {
                events.emit(&Event::Error {
                    code: ErrorCode::Internal,
                    message: format!("Failed to read IPC command: {error}"),
                });
                break;
            }
        };
        let line = match std::str::from_utf8(&bytes) {
            Ok(line) => line,
            Err(_) => {
                reply_error(
                    &events,
                    0,
                    ErrorCode::BadRequest,
                    "Command is not valid UTF-8".into(),
                );
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request = match parse_request(line) {
            Ok(request) => request,
            Err((id, message)) => {
                reply_error(
                    &events,
                    id.unwrap_or(0),
                    ErrorCode::BadRequest,
                    format!("Invalid command: {message}"),
                );
                continue;
            }
        };
        let generation = events.stopped.load(Ordering::Acquire);
        if generation != stopped_generation {
            recording = false;
            stopped_generation = generation;
        }
        let result = match request.cmd {
            Command::Hello => Ok(ReplyBody::Hello(backend.hello())),
            Command::Ping => Ok(ReplyBody::Empty {}),
            Command::Start(_) if recording => Err((ErrorCode::Busy, "A recording is already running".into())),
            Command::Start(args) => backend.start(args, events.clone()).map(|()| {
                recording = true;
                ReplyBody::Empty {}
            }),
            Command::Stop => {
                let result = backend.stop();
                if result.is_ok() || !backend.is_running() {
                    recording = false;
                }
                result.map(|()| ReplyBody::Empty {})
            }
        };
        match result {
            Ok(body) => events.reply(&Reply {
                id: request.id,
                ok: true,
                body,
            }),
            Err((code, message)) => reply_error(&events, request.id, code, message),
        }
    }
    if recording {
        if let Err((code, message)) = backend.stop() {
            events.emit(&Event::Error { code, message });
        }
    }
}

fn reply_error(events: &EventSink, id: u64, code: ErrorCode, message: String) {
    events.reply(&Reply {
        id,
        ok: false,
        body: ReplyBody::Error { code, message },
    });
}

enum InputLine {
    Eof,
    TooLong,
    Data(Vec<u8>),
}

// Read oversized lines through the newline before replying, retaining only the limit plus one CR so the next command is unaffected.
fn read_bounded_line(input: &mut impl BufRead) -> io::Result<InputLine> {
    let mut line = Vec::new();
    let mut overflow = false;
    let mut saw_data = false;
    loop {
        let available = match input.fill_buf() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if available.is_empty() {
            if !saw_data {
                return Ok(InputLine::Eof);
            }
            break;
        }
        saw_data = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.unwrap_or(available.len());
        let keep = count.min((MAX_LINE_BYTES + 1).saturating_sub(line.len()));
        line.extend_from_slice(&available[..keep]);
        overflow |= keep < count;
        input.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(if overflow || line.len() > MAX_LINE_BYTES {
        InputLine::TooLong
    } else {
        InputLine::Data(line)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AudioDevices;
    use serde_json::{json, Value};
    use std::io::{BufReader, Cursor, Read};
    use std::thread;

    #[derive(Clone, Default)]
    struct Output(Arc<Mutex<Vec<u8>>>);

    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Output {
        fn lines(&self) -> Vec<Value> {
            let bytes = self.0.lock().unwrap();
            assert!(bytes.is_empty() || bytes.ends_with(b"\n"));
            std::str::from_utf8(&bytes)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        hello_calls: usize,
        starts: Vec<StartArgs>,
        stops: usize,
        fail_starts: usize,
        fail_stops: usize,
        auto_stop: bool,
        running: bool,
        finish_on_stop_error: bool,
    }

    impl Backend for FakeBackend {
        fn hello(&mut self) -> HelloInfo {
            self.hello_calls += 1;
            HelloInfo {
                version: "測試版".into(),
                encoders: vec!["hevc_nvenc".into()],
                audio: AudioDevices::default(),
            }
        }

        fn start(&mut self, args: StartArgs, events: EventSink) -> Result<(), BackendError> {
            self.starts.push(args);
            if self.fail_starts > 0 {
                self.fail_starts -= 1;
                return Err((ErrorCode::CaptureFailed, "Test start failed".into()));
            }
            self.running = !self.auto_stop;
            events.emit(&Event::Started {
                encoder: None,
                width: 1920,
                height: 1080,
                fps: 60,
                shm: "測試".into(),
            });
            if self.auto_stop {
                events.emit(&Event::Stopped {
                    reason: "disk_full".into(),
                });
            }
            Ok(())
        }

        fn stop(&mut self) -> Result<(), BackendError> {
            self.stops += 1;
            if self.fail_stops > 0 {
                self.fail_stops -= 1;
                if self.finish_on_stop_error {
                    self.running = false;
                }
                Err((ErrorCode::EncodeFailed, "Test stop failed".into()))
            } else {
                self.running = false;
                Ok(())
            }
        }

        fn is_running(&self) -> bool {
            self.running
        }
    }

    fn start(id: u64) -> Value {
        json!({"id":id,"cmd":"start","pid":42,"session_dir":"錄影/.sessions/a","session_id":"a",
            "encode":null,"audio":null,"frames":{"banner":[1,2,3,4],"spec":[5,6,7,8],"base":[1920,1080]}})
    }

    fn run_commands(commands: &[Value], backend: &mut FakeBackend) -> Vec<Value> {
        let input = commands
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        let output = Output::default();
        run(
            Cursor::new(input),
            EventSink::new(Box::new(output.clone())),
            backend,
        );
        output.lines()
    }

    #[test]
    fn asynchronous_stop_clears_busy_without_an_explicit_stop_command() {
        let mut backend = FakeBackend {
            auto_stop: true,
            ..Default::default()
        };
        let lines = run_commands(&[start(1), start(2)], &mut backend);
        assert_eq!(backend.starts.len(), 2);
        assert!(!lines.iter().any(|line| line["code"] == "busy"));
    }

    #[test]
    fn commands_pass_arguments_and_allow_restart_after_stop() {
        let mut encoded = start(3);
        encoded["encode"] =
            json!({"codec":"hevc","encoder":"auto","fps":60,"height":0,"bitrate_kbps":40000});
        encoded["audio"] =
            json!({"render":"default","capture":"麥克風","mic_gain":0.5,"mic_enabled":true});
        let mut backend = FakeBackend::default();
        let lines = run_commands(
            &[
                json!({"id":1,"cmd":"hello"}),
                json!({"id":2,"cmd":"ping"}),
                encoded,
                start(4),
                json!({"id":5,"cmd":"stop"}),
                start(6),
                json!({"id":7,"cmd":"stop"}),
                json!({"id":8,"cmd":"stop"}),
            ],
            &mut backend,
        );
        assert_eq!(backend.hello_calls, 1);
        assert_eq!(backend.starts.len(), 2);
        assert_eq!(backend.stops, 3);
        assert_eq!(backend.starts[0].pid, 42);
        assert_eq!(
            backend.starts[0].encode.as_ref().unwrap().bitrate_kbps,
            40000
        );
        assert_eq!(backend.starts[0].audio.as_ref().unwrap().capture, "麥克風");
        assert_eq!(backend.starts[0].frames.banner, [1, 2, 3, 4]);
        assert!(backend.starts[1].encode.is_none());
        assert_eq!(lines[0]["encoders"], json!(["hevc_nvenc"]));
        assert_eq!(lines[1], json!({"id":2,"ok":true}));
        assert_eq!(lines[2]["ev"], "started");
        assert_eq!(lines[3], json!({"id":3,"ok":true}));
        assert_eq!(lines[4]["code"], "busy");
        assert_eq!(lines.last().unwrap(), &json!({"id":8,"ok":true}));
    }

    #[test]
    fn backend_failures_preserve_recording_until_successful_stop() {
        let mut backend = FakeBackend {
            fail_starts: 1,
            fail_stops: 1,
            ..Default::default()
        };
        let lines = run_commands(
            &[start(1), start(2), json!({"id":3,"cmd":"stop"}), start(4)],
            &mut backend,
        );
        assert_eq!(lines[0]["code"], "capture_failed");
        assert_eq!(lines[3]["code"], "encode_failed");
        assert_eq!(lines[4]["code"], "busy");
        assert_eq!(backend.starts.len(), 2);
        assert_eq!(backend.stops, 2); // EOF still finalizes after stop fails.
    }

    #[test]
    fn failed_stop_allows_restart_when_backend_has_no_running_work() {
        let mut backend = FakeBackend {
            fail_stops: 1,
            finish_on_stop_error: true,
            ..Default::default()
        };
        let lines = run_commands(
            &[start(1), json!({"id":2,"cmd":"stop"}), start(3)],
            &mut backend,
        );
        assert_eq!(backend.starts.len(), 2);
        assert_eq!(lines[2]["code"], "encode_failed");
        assert!(!lines.iter().any(|line| line["code"] == "busy"));
        assert_eq!(lines.last().unwrap(), &json!({"id":3,"ok":true}));
    }

    #[test]
    fn eof_stops_only_an_active_recording_and_reports_cleanup_errors() {
        let mut idle = FakeBackend::default();
        assert!(run_commands(&[], &mut idle).is_empty());
        assert_eq!(idle.stops, 0);
        let mut active = FakeBackend {
            fail_stops: 1,
            ..Default::default()
        };
        let lines = run_commands(&[start(1)], &mut active);
        assert_eq!(active.stops, 1);
        assert_eq!(lines.last().unwrap()["ev"], "error");
        assert_eq!(lines.last().unwrap()["code"], "encode_failed");
        let mut failed = FakeBackend {
            fail_starts: 1,
            ..Default::default()
        };
        run_commands(&[start(1)], &mut failed);
        assert_eq!(failed.stops, 0);
    }

    #[test]
    fn malformed_lines_keep_readable_ids_and_continue() {
        let output = Output::default();
        let mut backend = FakeBackend::default();
        run(Cursor::new(b"\n \t\r\n{\"id\":7,\"cmd\":\"unknown\"}\ninvalid\n\xff\n{\"cmd\":\"ping\"}\n{\"id\":9,\"cmd\":\"ping\"}"),
            EventSink::new(Box::new(output.clone())), &mut backend);
        let lines = output.lines();
        assert_eq!(lines.len(), 5);
        for (line, id) in lines[..4].iter().zip([7, 0, 0, 0]) {
            assert_eq!(line["id"], id);
            assert_eq!(line["ok"], false);
            assert_eq!(line["code"], "bad_request");
        }
        assert_eq!(lines[4], json!({"id":9,"ok":true}));
    }

    #[test]
    fn line_limit_handles_crlf_exact_boundary_and_discards_oversized_input() {
        let ping = r#"{"id":1,"cmd":"ping"}"#;
        let mut input = ping.as_bytes().to_vec();
        input.resize(MAX_LINE_BYTES, b' ');
        input.extend_from_slice(b"\r\n");
        input.extend(std::iter::repeat_n(b'x', MAX_LINE_BYTES * 3));
        input.push(b'\n');
        input.extend_from_slice(b"{\"id\":2,\"cmd\":\"ping\"}\n");
        let output = Output::default();
        run(
            BufReader::with_capacity(17, Cursor::new(input)),
            EventSink::new(Box::new(output.clone())),
            &mut FakeBackend::default(),
        );
        let lines = output.lines();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], json!({"id":1,"ok":true}));
        assert_eq!(lines[1]["code"], "bad_request");
        assert_eq!(lines[2], json!({"id":2,"ok":true}));
    }

    struct ReadFailure;

    impl Read for ReadFailure {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("Test read failed"))
        }
    }

    #[test]
    fn input_failure_reports_error_and_stops_recording() {
        let output = Output::default();
        let input = Cursor::new(format!("{}\n", start(1))).chain(ReadFailure);
        let mut backend = FakeBackend::default();
        run(
            BufReader::new(input),
            EventSink::new(Box::new(output.clone())),
            &mut backend,
        );
        assert_eq!(backend.stops, 1);
        assert_eq!(output.lines().last().unwrap()["code"], "internal");
    }

    #[test]
    fn events_and_replies_from_multiple_threads_are_complete_json_lines() {
        let output = Output::default();
        let sink = EventSink::new(Box::new(output.clone()));
        let workers: Vec<_> = (0..8)
            .map(|worker| {
                let sink = sink.clone();
                thread::spawn(move || {
                    for index in 0..100 {
                        sink.emit(&Event::WindowLost);
                        sink.reply(&Reply {
                            id: worker * 100 + index,
                            ok: true,
                            body: ReplyBody::Empty {},
                        });
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let lines = output.lines();
        assert_eq!(lines.len(), 1600);
        assert_eq!(
            lines
                .iter()
                .filter(|line| line["ev"] == "window_lost")
                .count(),
            800
        );
        let ids: std::collections::HashSet<_> = lines
            .iter()
            .filter_map(|line| line["id"].as_u64())
            .collect();
        assert_eq!(ids.len(), 800);
    }

    #[test]
    fn oversized_output_returns_bounded_errors_without_losing_request_id() {
        let output = Output::default();
        let sink = EventSink::new(Box::new(output.clone()));
        sink.reply(&Reply {
            id: 17,
            ok: false,
            body: ReplyBody::Error {
                code: ErrorCode::Internal,
                message: "字".repeat(MAX_LINE_BYTES),
            },
        });
        sink.emit(&Event::Stopped {
            reason: "x".repeat(MAX_LINE_BYTES),
        });
        let lines = output.lines();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["id"], 17);
        assert_eq!(lines[0]["ok"], false);
        assert_eq!(lines[0]["code"], "internal");
        assert_eq!(lines[1]["ev"], "error");
        assert!(output.0.lock().unwrap().len() < MAX_LINE_BYTES);
    }
}
