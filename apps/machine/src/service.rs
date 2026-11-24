//! Keeping the daemon connected in the background, as the system keeps a program of its user's:
//! a launchd agent on macOS, a systemd user service on Linux. `connect` makes it and starts it,
//! and it starts again at login and whenever it stops; `disconnect` stops it and removes it.
//!
//! What the service runs is `connect --foreground`: the daemon itself. A system with neither has
//! the daemon run where `connect` was typed.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What the service is called. For tests, another, so as not to touch the real one.
fn label() -> String {
    std::env::var("MACHINE_SERVICE")
        .ok()
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "dev.acentric.machine".into())
}

/// What became of `connect`.
pub enum Connected {
    /// It runs in the background now, as a service: this is what to say of it.
    Service(String),
    /// This system keeps no service of its user's: the daemon is to run here.
    NoServiceManager,
}

/// Whether a command runs, and ends well.
fn runs(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// A command run for what it does, or why it did not.
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("{program} could not be run: {error}"))?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    Err(format!(
        "{program} {} failed: {}",
        args.join(" "),
        said.trim()
    ))
}

fn write(file: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{} could not be made: {error}", parent.display()))?;
    }
    std::fs::write(file, text)
        .map_err(|error| format!("{} could not be written: {error}", file.display()))
}

/// Text for a file of the service, with `&`, `<` and `>` as XML has them.
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn launchd_plist(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{}.plist", label()))
}

fn systemd_unit(home: &Path) -> PathBuf {
    home.join(".config/systemd/user")
        .join(format!("{}.service", label()))
}

fn domain() -> String {
    // SAFETY: getuid has no preconditions and cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}

/// Whether the user's systemd answers: not in a container, or a session without one.
fn systemd() -> bool {
    runs("systemctl", &["--user", "show-environment"])
}

/// Makes the service that keeps `program` connected, and starts it, in place of any before.
pub fn connect(program: &Path, dir: &Path, home: &Path) -> Result<Connected, String> {
    let label = label();
    let program = program.display().to_string();
    let folder = dir.display().to_string();
    let log = dir.join("machine.log").display().to_string();
    if cfg!(target_os = "macos") {
        let plist = launchd_plist(home);
        write(
            &plist,
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array><string>{program}</string><string>connect</string><string>--foreground</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>MACHINE_DIR</key><string>{folder}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
                label = xml(&label),
                program = xml(&program),
                folder = xml(&folder),
                log = xml(&log),
            ),
        )?;
        let domain = domain();
        let service = format!("{domain}/{label}");
        // The one before, if there is one, gives way: launchd ends it after it answers, and
        // takes no other of the same name until it has.
        runs("launchctl", &["bootout", &service]);
        for _ in 0..50 {
            if !runs("launchctl", &["print", &service]) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        run(
            "launchctl",
            &["bootstrap", &domain, &plist.display().to_string()],
        )?;
        return Ok(Connected::Service(format!(
            "Connected. It runs in the background, starts again at login and whenever it stops, and logs to {log}."
        )));
    }
    if !systemd() {
        return Ok(Connected::NoServiceManager);
    }
    write(
        &systemd_unit(home),
        &format!(
            "[Unit]\nDescription=Acentric machine\nAfter=network-online.target\n\n\
             [Service]\nEnvironment=MACHINE_DIR={folder}\nExecStart={program} connect --foreground\n\
             Restart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n"
        ),
    )?;
    run("systemctl", &["--user", "daemon-reload"])?;
    run(
        "systemctl",
        &["--user", "enable", &format!("{label}.service")],
    )?;
    run(
        "systemctl",
        &["--user", "restart", &format!("{label}.service")],
    )?;
    // Without lingering, a user's services stop when they log out, and start only at login.
    let user = std::env::var("USER").unwrap_or_default();
    let lingers = !user.is_empty() && runs("loginctl", &["enable-linger", &user]);
    let mut said = format!(
        "Connected. It runs in the background, starts again whenever it stops, and logs to journalctl --user -u {label}."
    );
    if !lingers && !user.is_empty() {
        said.push_str(&format!(
            "\nTo keep it connected while you are logged out: sudo loginctl enable-linger {user}"
        ));
    }
    Ok(Connected::Service(said))
}

/// Stops the service and removes it: what to say of it. The enrolment stays, to connect again.
pub fn disconnect(home: &Path) -> Result<String, String> {
    let label = label();
    if cfg!(target_os = "macos") {
        let plist = launchd_plist(home);
        let was = runs("launchctl", &["bootout", &format!("{}/{label}", domain())]);
        let had = plist.exists();
        let _ = std::fs::remove_file(&plist);
        return Ok(if was || had {
            "Disconnected."
        } else {
            "It was not connected."
        }
        .into());
    }
    let unit = systemd_unit(home);
    let had = unit.exists();
    let was = systemd()
        && runs(
            "systemctl",
            &["--user", "disable", "--now", &format!("{label}.service")],
        );
    let _ = std::fs::remove_file(&unit);
    if had && systemd() {
        runs("systemctl", &["--user", "daemon-reload"]);
    }
    Ok(if was || had {
        "Disconnected."
    } else {
        "It was not connected."
    }
    .into())
}
