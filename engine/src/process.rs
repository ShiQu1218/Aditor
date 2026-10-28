use anyhow::Result;
use std::{
    io::Read,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
pub struct Child {
    child: std::process::Child,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}
impl std::ops::Deref for Child {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}
impl std::ops::DerefMut for Child {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}
impl Child {
    pub fn kill(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{Foundation::HANDLE, System::JobObjects::TerminateJobObject};
            // SAFETY: This object owns the job; terminating it also closes descendant pipe writers.
            unsafe { TerminateJobObject(HANDLE(self.job.as_raw_handle()), 1) }
                .map_err(std::io::Error::other)?;
        }
        self.child.kill()
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.child.wait();
    }
}
pub fn spawn(cmd: &mut Command) -> Result<Child> {
    #[cfg(windows)]
    let job = child_job()?;
    let mut child = cmd.spawn()?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, System::JobObjects::AssignProcessToJobObject};
        // SAFETY: Both handles remain valid throughout assignment; the job handle is not inherited.
        if let Err(e) = unsafe {
            AssignProcessToJobObject(HANDLE(job.as_raw_handle()), HANDLE(child.as_raw_handle()))
        } {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.into());
        }
    }
    Ok(Child {
        child,
        #[cfg(windows)]
        job,
    })
}
#[cfg(windows)]
fn child_job() -> Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::{
        core::PCWSTR,
        Win32::{Foundation::HANDLE, System::JobObjects::*},
    };
    // SAFETY: The unnamed job is owned by this process and limits points to initialized data.
    unsafe {
        let handle = CreateJobObjectW(None, PCWSTR::null())?;
        let job = OwnedHandle::from_raw_handle(handle.0);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            HANDLE(job.as_raw_handle()),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )?;
        Ok(job)
    }
}

pub fn read_exact(
    pipe: &mut std::process::ChildStdout,
    mut bytes: &mut [u8],
    stopped: &(dyn Fn() -> bool + Sync),
) -> std::io::Result<()> {
    #[cfg(windows)]
    let pipe_handle = {
        use std::os::windows::io::AsRawHandle;
        pipe.as_raw_handle() as usize
    };
    let mut read = || {
        while !bytes.is_empty() {
            if stopped() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "Decoding cancelled",
                ));
            }
            let result = pipe.read(bytes);
            if stopped() {
                return Err(std::io::ErrorKind::Interrupted.into());
            }
            match result {
                Ok(0) => return Err(std::io::ErrorKind::UnexpectedEof.into()),
                Ok(n) => bytes = &mut std::mem::take(&mut bytes)[n..],
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    };
    #[cfg(windows)]
    {
        use windows::Win32::{Foundation::HANDLE, System::IO::CancelIoEx};
        let finished = AtomicBool::new(false);
        thread::scope(|scope| {
            let watcher = scope.spawn(|| {
                while !finished.load(Ordering::Acquire) {
                    if stopped() {
                        // SAFETY: The pipe outlives this scoped watcher and has exactly one reader.
                        let _ = unsafe { CancelIoEx(HANDLE(pipe_handle as *mut _), None) };
                    }
                    thread::park_timeout(Duration::from_millis(10));
                }
            });
            let result = read();
            finished.store(true, Ordering::Release);
            watcher.thread().unpark();
            result
        })
    }
    #[cfg(not(windows))]
    read()
}

pub fn output(cmd: &mut Command, timeout: Duration, cancel: Option<&AtomicBool>) -> Result<Output> {
    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err(crate::errors::Cancelled.into());
    }
    let mut child = spawn(cmd.stdout(Stdio::piped()).stderr(Stdio::piped()))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut data = Vec::new();
        stdout.read_to_end(&mut data).map(|_| data)
    });
    let err = thread::spawn(move || {
        let mut data = Vec::new();
        stderr.read_to_end(&mut data).map(|_| data)
    });
    let start = Instant::now();
    let result = loop {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            break Err(crate::errors::Cancelled.into());
        }
        if start.elapsed() >= timeout {
            break Err(anyhow::anyhow!("timed out"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(e) => break Err(e.into()),
        }
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(child);
    let stdout = out
        .join()
        .map_err(|_| anyhow::anyhow!("stdout reader panicked"))??;
    let stderr = err
        .join()
        .map_err(|_| anyhow::anyhow!("stderr reader panicked"))??;
    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err(crate::errors::Cancelled.into());
    }
    Ok(Output {
        status: result?,
        stdout,
        stderr,
    })
}
pub fn tail(bytes: &[u8], count: usize) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .rev()
        .take(count)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn shell(code: &str) -> Command {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", code]);
        cmd
    }
    #[test]
    fn captures_more_than_pipe_capacity_without_deadlock() {
        let mut cmd=shell("$out=[Console]::OpenStandardOutput(); $out.Write([byte[]]::new(230400),0,230400); [Console]::Error.Write(('x'*131072))");
        let result = output(&mut cmd, Duration::from_secs(10), None).unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout.len(), 230400);
        assert_eq!(result.stderr.len(), 131072);
    }
    #[test]
    fn timeout_kills_and_reaps_child() {
        let start = Instant::now();
        let error = output(
            &mut shell("Start-Sleep -Seconds 30"),
            Duration::from_millis(200),
            None,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "timed out");
        assert!(start.elapsed() < Duration::from_secs(3));
    }
    #[test]
    fn cancellation_kills_and_reaps_child() {
        let flag = Arc::new(AtomicBool::new(false));
        let set = Arc::clone(&flag);
        let timer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            set.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        let error = output(
            &mut shell("Start-Sleep -Seconds 30"),
            Duration::from_secs(10),
            Some(&flag),
        )
        .unwrap_err();
        timer.join().unwrap();
        assert!(error.is::<crate::errors::Cancelled>());
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}

#[cfg(all(test, windows))]
mod lifecycle_tests {
    use super::*;
    use std::{io::Read, os::windows::io::FromRawHandle, sync::Arc};
    use windows::Win32::{
        Foundation::HANDLE,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };

    #[test]
    fn cancellation_interrupts_partial_pipe_and_kills_descendants() {
        let stub = std::env::current_dir()
            .unwrap()
            .join(format!("target/cancel-{}.cmd", std::process::id()));
        std::fs::write(&stub, "@echo off\r\npowershell -NoProfile -NonInteractive -Command \"[Console]::Write('x'); Start-Sleep -Seconds 30\"\r\n").unwrap();
        let mut cmd = Command::new(&stub);
        let mut child = spawn(cmd.stdout(Stdio::piped()).stderr(Stdio::piped())).unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut first = [0];
        stdout.read_exact(&mut first).unwrap();
        assert_eq!(first, *b"x");
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let timer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        assert_eq!(
            read_exact(&mut stdout, &mut [0; 10], &|| cancel
                .load(Ordering::Relaxed))
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::Interrupted
        );
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(stdout.read(&mut [0]).unwrap(), 0);
        timer.join().unwrap();
        std::fs::remove_file(stub).unwrap();
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn parent_exit_kills_child() {
        if std::env::var_os("ADITOR_JOB_TEST_CHILD").is_some() {
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", "[IO.File]::WriteAllText($env:ADITOR_JOB_TEST_CHILD, [string]$PID); Start-Sleep -Seconds 30"]);
            let _child = spawn(&mut cmd).unwrap();
            thread::sleep(Duration::from_secs(30));
            return;
        }
        let path = std::env::current_dir()
            .unwrap()
            .join(format!("target/job-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process::lifecycle_tests::parent_exit_kills_child",
            ])
            .env("ADITOR_JOB_TEST_CHILD", &path)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| s.parse::<u32>().ok())
            {
                break Some(pid);
            }
            if start.elapsed() > Duration::from_secs(10) {
                break None;
            }
            thread::sleep(Duration::from_millis(10));
        };
        // SAFETY: Open only synchronization access; ownership is transferred to OwnedHandle.
        let child = pid.map(|pid| unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).unwrap() });
        parent.kill().unwrap();
        parent.wait().unwrap();
        let handle = child.expect("child did not start");
        let _owned = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.0) };
        assert_eq!(unsafe { WaitForSingleObject(HANDLE(handle.0), 3000) }.0, 0);
        std::fs::remove_file(path).unwrap();
    }
}
