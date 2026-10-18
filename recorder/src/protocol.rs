//! 主程序 ⇄ apexrec 的 JSON-lines 協定（規格 §4.4）。stdin 指令、stdout 事件、stderr 日誌。

use serde::{Deserialize, Serialize};

use crate::types::{AudioConfig, CaptureMethod, EncodeConfig, FramesSpec};

/// 單行上限（超過視為 bad_request）。
pub const MAX_LINE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub cmd: Command,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Hello,
    Ping,
    Start(StartArgs),
    Stop,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StartArgs {
    pub pid: u32,
    pub session_dir: String,
    pub session_id: String,
    /// `None` = 只擷取＋小圖（OBS 模式），不編碼也不錄音。
    pub encode: Option<EncodeConfig>,
    pub audio: Option<AudioConfig>,
    pub frames: FramesSpec,
    /// 擷取方式；省略時為 `wgc`，未知值視為 bad_request。
    #[serde(default)]
    pub capture: CaptureMethod,
}

/// 回覆（帶 `id`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Reply {
    pub id: u64,
    pub ok: bool,
    #[serde(flatten)]
    pub body: ReplyBody,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ReplyBody {
    Empty {},
    Hello(HelloInfo),
    Error { code: ErrorCode, message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HelloInfo {
    pub version: String,
    pub encoders: Vec<String>,
    pub audio: AudioDevices,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct AudioDevices {
    pub render: Vec<AudioDevice>,
    pub capture: Vec<AudioDevice>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// 非同步事件（無 `id`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    Started {
        encoder: Option<String>,
        width: u32,
        height: u32,
        fps: u32,
        shm: String,
    },
    Segment {
        seq: u64,
        pts: f64,
        dur: f64,
        bytes: u64,
    },
    Stats {
        fps_in: f64,
        fps_enc: f64,
        dropped: u64,
        small_dropped: u64,
        queue: u32,
    },
    WindowLost,
    /// 僅 DDA：目標遊戲離開前景或最小化，錄影與小圖改送黑幀；pts 為錄影起點後的秒數。
    GameHidden {
        pts: f64,
    },
    /// 僅 DDA：目標遊戲重新成為未最小化的前景視窗；pts 為錄影起點後的秒數。
    GameVisible {
        pts: f64,
    },
    WindowFound {
        width: u32,
        height: u32,
        monitor: bool,
    },
    Stopped {
        reason: String,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
    Warning {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NoHwEncoder,
    WindowNotFound,
    CaptureFailed,
    EncodeFailed,
    AudioFailed,
    DiskFull,
    BadRequest,
    Busy,
    Internal,
}

/// 解析一行指令；失敗時回傳可以直接放進錯誤回覆的訊息（以及能讀到的 id）。
pub fn parse_request(line: &str) -> Result<Request, (Option<u64>, String)> {
    if line.len() > MAX_LINE_BYTES {
        return Err((None, format!("指令超過 {MAX_LINE_BYTES} bytes")));
    }
    serde_json::from_str::<Request>(line).map_err(|e| {
        let id = serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_u64()));
        (id, e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Codec;

    #[test]
    fn parses_start_with_encode_and_obs_mode() {
        let line = r#"{"id":2,"cmd":"start","pid":1234,"session_dir":"D:\\rec\\.sessions\\a","session_id":"a",
            "encode":{"codec":"hevc","encoder":"auto","fps":60,"height":0,"bitrate_kbps":40000},
            "audio":{"render":"default","capture":"default","mic_gain":1.0,"mic_enabled":true},
            "frames":{"banner":[1,2,3,4],"spec":[5,6,7,8],"base":[1920,1080]}}"#;
        let req = parse_request(&line.replace('\n', "")).unwrap();
        let Command::Start(args) = req.cmd else {
            panic!("not start")
        };
        assert_eq!(args.encode.unwrap().codec, Codec::Hevc);

        let obs = r#"{"id":3,"cmd":"start","pid":1,"session_dir":"x","session_id":"x","encode":null,"audio":null,"frames":{"banner":[1,2,3,4],"spec":[5,6,7,8],"base":[1920,1080]}}"#;
        let Command::Start(args) = parse_request(obs).unwrap().cmd else {
            panic!()
        };
        assert!(args.encode.is_none());
        assert_eq!(args.capture, CaptureMethod::Wgc);
    }

    #[test]
    fn parses_capture_method_and_rejects_unknown() {
        let base = r#"{"id":4,"cmd":"start","pid":1,"session_dir":"x","session_id":"x","encode":null,"audio":null,"frames":{"banner":[1,2,3,4],"spec":[5,6,7,8],"base":[1920,1080]}"#;
        for (value, expected) in [("wgc", CaptureMethod::Wgc), ("dda", CaptureMethod::Dda)] {
            let line = format!(r#"{base},"capture":"{value}"}}"#);
            let Command::Start(args) = parse_request(&line).unwrap().cmd else {
                panic!("not start")
            };
            assert_eq!(args.capture, expected);
        }
        for bad in [r#""nvfbc""#, r#""DDA""#, "1", "null"] {
            let line = format!(r#"{base},"capture":{bad}}}"#);
            assert_eq!(parse_request(&line).unwrap_err().0, Some(4), "{bad}");
        }
    }

    #[test]
    fn bad_request_keeps_id_when_readable() {
        assert_eq!(
            parse_request(r#"{"id":7,"cmd":"nope"}"#).unwrap_err().0,
            Some(7)
        );
        assert_eq!(parse_request("garbage").unwrap_err().0, None);
    }

    #[test]
    fn recording_options_default_and_reject_bad_values() {
        let mut value = serde_json::json!({"id":9,"cmd":"start","pid":1,"session_dir":"x","session_id":"x",
            "encode":{"codec":"hevc","encoder":"auto","fps":10,"height":0,"bitrate_kbps":40000},
            "audio":{"render":"default","capture":"default","mic_gain":1.0,"mic_enabled":true},
            "frames":{"banner":[1,2,3,4],"spec":[5,6,7,8],"base":[1920,1080]}});
        let Command::Start(args) = parse_request(&value.to_string()).unwrap().cmd else {
            panic!()
        };
        let encode = args.encode.unwrap();
        assert_eq!(encode.preset, crate::types::EncodePreset::Speed);
        assert_eq!(encode.aspect, crate::types::EncodeAspect::Native);
        let audio = args.audio.unwrap();
        assert!(audio.render_enabled);
        assert_eq!(audio.render_gain, 1.0);
        assert!(!audio.mic_mono);
        assert_eq!(audio.render_source, crate::types::RenderSource::Device);
        for (section, field, bad) in [
            ("encode", "preset", serde_json::json!("unknown")),
            ("encode", "aspect", serde_json::json!("crop")),
            ("audio", "render_source", serde_json::json!("application")),
            ("audio", "render_gain", serde_json::json!(-0.1)),
            ("audio", "render_gain", serde_json::json!(2.1)),
            ("audio", "mic_mono", serde_json::json!(1)),
        ] {
            value[section][field] = bad;
            assert_eq!(parse_request(&value.to_string()).unwrap_err().0, Some(9));
            value[section].as_object_mut().unwrap().remove(field);
        }
        value["encode"]["preset"] = serde_json::json!("quality");
        value["encode"]["aspect"] = serde_json::json!("fit");
        value["audio"]["render_source"] = serde_json::json!("game");
        assert!(parse_request(&value.to_string()).is_ok());
    }

    #[test]
    fn serializes_events_and_replies() {
        for (event, name) in [
            (Event::GameHidden { pts: 1.25 }, "game_hidden"),
            (Event::GameVisible { pts: 2.5 }, "game_visible"),
        ] {
            let value = serde_json::to_value(&event).unwrap();
            assert_eq!(value["ev"], name);
            assert_eq!(value.as_object().unwrap().len(), 2);
            assert_eq!(
                value["pts"],
                match event {
                    Event::GameHidden { pts } | Event::GameVisible { pts } => pts,
                    _ => unreachable!(),
                }
            );
        }
        let warning = Event::Warning {
            code: "game_audio_unavailable".into(),
            message: "改錄系統聲音".into(),
        };
        assert_eq!(
            serde_json::to_value(warning).unwrap(),
            serde_json::json!({"ev":"warning","code":"game_audio_unavailable","message":"改錄系統聲音"})
        );
        let ev = Event::Segment {
            seq: 3,
            pts: 4.0,
            dur: 2.0,
            bytes: 10,
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"ev":"segment","seq":3,"pts":4.0,"dur":2.0,"bytes":10}"#
        );
        let r = Reply {
            id: 1,
            ok: false,
            body: ReplyBody::Error {
                code: ErrorCode::NoHwEncoder,
                message: "x".into(),
            },
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"id":1,"ok":false,"code":"no_hw_encoder","message":"x"}"#
        );
        let ok = Reply {
            id: 2,
            ok: true,
            body: ReplyBody::Empty {},
        };
        assert_eq!(serde_json::to_string(&ok).unwrap(), r#"{"id":2,"ok":true}"#);
    }
}
