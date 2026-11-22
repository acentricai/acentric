//! What the daemon asks of the system it runs on: processes, signals, and what the machine is.

use std::ffi::CStr;
use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Now, in milliseconds since the epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// When a file was last written, in milliseconds since the epoch.
pub fn mtime_ms(path: &std::path::Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Whether a process of this ID is there.
pub fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 sends nothing: it only asks whether the process can be signalled.
    let sent = unsafe { libc::kill(pid, 0) };
    sent == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Sends a signal to a process group, by the ID of the process that leads it.
pub fn signal_group(pid: i32, signal: i32) {
    // SAFETY: a negative ID names the group. One that is gone is no error worth telling.
    unsafe {
        libc::kill(-pid, signal);
    }
}

/// Has a command start in a session and process group of its own, which the daemon's end
/// does not take with it.
pub fn in_own_session(command: &mut Command) -> &mut Command {
    // SAFETY: `setsid` is safe to call between fork and exec, and touches nothing of ours.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        })
    }
}

/// Takes leave of every child that has ended, so that none is left as a process that is no
/// more and still has an ID. Commands are not waited for one by one: they outlive the daemon.
pub fn reap() {
    // SAFETY: with WNOHANG this returns at once, and a null status is allowed.
    while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {}
}

/// When this machine started, in milliseconds since the epoch, to within the clock's drift.
pub fn boot_ms() -> u64 {
    now_ms().saturating_sub(uptime_ms())
}

#[cfg(target_os = "linux")]
fn uptime_ms() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `time` is a valid place to write the time to.
    unsafe {
        libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut time);
    }
    time.tv_sec as u64 * 1000 + time.tv_nsec as u64 / 1_000_000
}

#[cfg(target_os = "macos")]
fn uptime_ms() -> u64 {
    let mut boot = libc::timeval {
        tv_sec: 0,
        tv_usec: 0,
    };
    let mut size = std::mem::size_of::<libc::timeval>();
    let mut name = [libc::CTL_KERN, libc::KERN_BOOTTIME];
    // SAFETY: `boot` is as large as `size` says, and `name` has the two parts it is said to.
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            std::ptr::addr_of_mut!(boot).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return 0;
    }
    let booted = boot.tv_sec as u64 * 1000 + boot.tv_usec as u64 / 1000;
    now_ms().saturating_sub(booted)
}

/// The machine's name.
pub fn hostname() -> String {
    let mut name = [0u8; 256];
    // SAFETY: `name` is as long as it is said to be, and is ended with a zero below.
    let read = unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len() - 1) };
    if read != 0 {
        return String::new();
    }
    CStr::from_bytes_until_nul(&name).map_or_else(
        |_| String::new(),
        |text| text.to_string_lossy().into_owned(),
    )
}

/// The shell of the daemon's user, as the system's list of users has it.
pub fn login_shell() -> Option<String> {
    // SAFETY: the entry is read before anything else asks for one, and may be null.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_shell.is_null() {
            return None;
        }
        Some(
            CStr::from_ptr((*entry).pw_shell)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

/// What the system is called, as the engine knows systems: `darwin` or `linux`.
pub fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

/// What the processor is called, as the engine knows them: `arm64` or `x64`.
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

static STOPPED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_stop(_signal: libc::c_int) {
    STOPPED.store(true, Ordering::SeqCst);
}

/// Has the daemon told when it is asked to end, in place of being ended in the middle of
/// what it is doing.
pub fn listen_for_stop() {
    let handler = on_stop as extern "C" fn(libc::c_int) as libc::sighandler_t;
    // SAFETY: the handler only stores to an atomic, which is allowed in a signal handler.
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

/// Whether the daemon was asked to end.
pub fn stopped() -> bool {
    STOPPED.load(Ordering::SeqCst)
}

/// Becomes another program, with this process's ID. It returns only when it could not.
pub fn become_program(program: &std::path::Path, args: &[String]) -> io::Error {
    Command::new(program).args(args).exec()
}
