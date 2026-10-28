use crate::{
    analyze::{self, AnalyzeOptions},
    autoclip, cache,
    decode::DecodeError,
    derive,
    errors::{
        BadRequest, Busy, Cancelled, ProbeError, ProfileError, UnknownGame, UnsupportedGame,
        ValorantProfileError,
    },
    layout,
    models::{AutoClipParams, Event, SpecInterval},
    probe, profile,
};
use anyhow::Result;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
};

fn bad(message: impl Into<String>) -> anyhow::Error {
    BadRequest(message.into()).into()
}
pub fn jobs(value: &Value) -> Result<Option<usize>> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_u64()
        .filter(|&n| n >= 1 && n <= usize::MAX as u64)
        .map(|n| Some(n as usize))
        .ok_or_else(|| bad("jobs must be a positive integer"))
}
pub fn explicit_layout(value: &Value) -> Result<Option<layout::Layout>> {
    if value.is_null() {
        return Ok(None);
    }
    let s = value
        .as_str()
        .ok_or_else(|| bad("aspect must be a string"))?;
    layout::parse_aspect(s)
        .map(Some)
        .map_err(|e| bad(e.to_string()))
}
fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a Value> {
    args.get(key)
        .ok_or_else(|| bad(format!("Missing parameter: {key}")))
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    arg(args, key)?
        .as_str()
        .ok_or_else(|| bad(format!("{key} must be a string")))
}
fn truth(v: Option<&Value>, default: bool) -> bool {
    v.map_or(default, |v| match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    })
}
fn list<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T> {
    serde_json::from_value(arg(args, key)?.clone())
        .map_err(|e| bad(format!("Invalid arguments: {e}")))
}
fn error_kind(e: &anyhow::Error) -> (&'static str, &'static str) {
    if e.is::<ProbeError>() {
        ("probe_failed", "ProbeError")
    } else if e.is::<DecodeError>() {
        ("decode_failed", "DecodeError")
    } else if e.is::<ProfileError>() {
        ("profile_error", "ProfileError")
    } else if e.is::<BadRequest>() {
        ("bad_request", "BadRequest")
    } else if e.is::<Cancelled>() {
        ("cancelled", "Cancelled")
    } else if e.is::<UnknownGame>() {
        ("unknown_game", "UnknownGame")
    } else if e.is::<UnsupportedGame>() {
        ("unsupported_game", "UnsupportedGame")
    } else if e.is::<Busy>() {
        ("busy", "_Busy")
    } else if e.is::<ValorantProfileError>() {
        ("internal", "ValorantProfileError")
    } else {
        ("internal", "RuntimeError")
    }
}
fn error(rid: Value, e: anyhow::Error) -> Value {
    let (code, kind) = error_kind(&e);
    json!({"id":rid,"type":"error","code":code,"message":e.to_string(),"exception":{"type":kind,"frames":[]}})
}
type Current = Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>;
struct Output<W>(Mutex<W>);
impl<W: Write> Output<W> {
    fn send(&self, value: &Value) -> Result<()> {
        let mut out = self.0.lock().unwrap();
        out.write_all(&cache::json_bytes(value)?)?;
        out.write_all(b"\n")?;
        out.flush()?;
        Ok(())
    }
}
fn handle<W: Write + Send>(
    rid: &str,
    cmd: &str,
    args: &Value,
    cancel: Option<&AtomicBool>,
    out: &Output<W>,
) -> Result<Value> {
    match cmd {
        "probe" => Ok(json!(probe::probe(string(args, "path")?)?)),
        "analyze" => {
            let path = string(args, "path")?;
            let p = profile::load_profile(Path::new(string(args, "profile_dir")?))?;
            let layout = explicit_layout(&args["aspect"])?;
            let cache_dir = Path::new(string(args, "cache_dir")?);
            let progress = |t, duration| {
                let _ = out.send(&json!({"id":rid,"type":"progress","t":t,"duration":duration}));
            };
            analyze::analyze(
                path,
                &p,
                AnalyzeOptions {
                    cache_dir,
                    beside: truth(args.get("beside"), false),
                    force: truth(args.get("force"), false),
                    on_progress: &progress,
                    cancel,
                    hwaccel: truth(args.get("hwaccel"), true),
                    jobs: jobs(&args["jobs"])?,
                    layout,
                    game: args["game"].as_str(),
                },
            )
        }
        "derive" => {
            let events: Vec<Event> = list(args, "events")?;
            let spec: Vec<SpecInterval> = list(args, "spectating")?;
            let p = profile::load_profile(Path::new(string(args, "profile_dir")?))?;
            Ok(json!({"events":derive::derive(&events,&spec,&p)}))
        }
        "autoclip" => {
            let events: Vec<Event> = list(args, "events")?;
            let params: AutoClipParams = list(args, "params")?;
            let v = arg(args, "duration")?;
            let duration = v
                .as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                .ok_or_else(|| bad("Invalid arguments: duration must be a number"))?;
            Ok(json!({"clips":autoclip::auto_clips(&events,&params,duration)}))
        }
        _ => unreachable!(),
    }
}
pub fn serve<R: BufRead, W: Write + Send + Sync + 'static>(input: R, output: W) -> Result<()> {
    let out = Arc::new(Output(Mutex::new(output)));
    let current: Current = Arc::new(Mutex::new(None));
    let mut threads: Vec<JoinHandle<()>> = vec![];
    out.send(&json!({"type":"ready","engine_version":cache::ENGINE_VERSION}))?;
    for raw in input.split(b'\n') {
        let raw = raw?;
        let raw = raw.trim_ascii();
        if raw.is_empty() {
            continue;
        }
        let mut rid = Value::Null;
        let result = (|| -> Result<()> {
            let req: Value =
                serde_json::from_slice(raw).map_err(|e| bad(format!("Invalid JSON: {e}")))?;
            if !req.is_object() {
                return Err(bad("Request must be a JSON object"));
            }
            rid = req["id"].clone();
            let args = req.get("args").cloned().unwrap_or(json!({}));
            let id = rid
                .as_str()
                .filter(|_| args.is_object())
                .ok_or_else(|| bad("id must be a string and args must be an object"))?
                .to_owned();
            let cmd = req["cmd"].as_str().unwrap_or("");
            if cmd == "cancel" {
                let target = arg(&args, "target")?;
                let state = current.lock().unwrap();
                let hit = state.as_ref().is_some_and(|(id, _)| target == id);
                if hit {
                    state.as_ref().unwrap().1.store(true, Ordering::Relaxed);
                }
                out.send(&json!({"id":id,"type":"result","data":{"cancelled":hit}}))?;
                return Ok(());
            }
            if !["probe", "analyze", "derive", "autoclip"].contains(&cmd) {
                return Err(bad(format!(
                    "Unknown command: {}",
                    profile::py_repr(&req["cmd"])
                )));
            }
            let cancel = if cmd == "analyze" {
                let mut state = current.lock().unwrap();
                if state.is_some() {
                    return Err(Busy("An analysis is already running".into()).into());
                }
                let c = Arc::new(AtomicBool::new(false));
                *state = Some((id.clone(), c.clone()));
                Some(c)
            } else {
                None
            };
            let cmd = cmd.to_owned();
            let out = out.clone();
            let current = current.clone();
            let mut active = vec![];
            for th in threads.drain(..) {
                if th.is_finished() {
                    let _ = th.join();
                } else {
                    active.push(th);
                }
            }
            threads = active;
            threads.push(thread::spawn(move || {
                let result = handle(&id, &cmd, &args, cancel.as_deref(), &out);
                if cancel.is_some() {
                    *current.lock().unwrap() = None;
                }
                let response = match result {
                    Ok(data) => json!({"id":id,"type":"result","data":data}),
                    Err(e) => error(id.into(), e),
                };
                let _ = out.send(&response);
            }));
            Ok(())
        })();
        if let Err(e) = result {
            out.send(&error(rid, e))?;
        }
    }
    if let Some((_, cancel)) = current.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
    for th in threads {
        let _ = th.join();
    }
    Ok(())
}
pub fn run() -> Result<()> {
    serve(std::io::stdin().lock(), std::io::stdout())
}
