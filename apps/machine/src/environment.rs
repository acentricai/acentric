//! The environment commands run in. A daemon that was started from a terminal has its user's
//! whole setup, and one that was started as a service, at boot or in a sandbox has next to
//! nothing: no `node`, no Homebrew, whatever the user's shell files set up.
//!
//! So the daemon asks the user's own shell, once, when it starts: it runs the shell as a login
//! shell and an interactive one, which reads every file the user's terminal reads, and keeps
//! the variables it ends up with. Each command then runs with plain `bash -c` in that
//! environment. Nothing is read per command, so a command costs what it did, and nothing a
//! shell file prints reaches a command's output.
//!
//! Only variables are kept. Aliases and functions are the user's shorthand, not the model's,
//! and an alias such as `rm -i` would wait for an answer no command can give.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::sys;

/// The shells that take `-ilc`, by name.
const KNOWN: [&str; 6] = ["bash", "zsh", "sh", "dash", "ksh", "fish"];

/// Variables that are a shell's own, of the moment it ran.
const OF_THE_SHELL: [&str; 4] = ["_", "SHLVL", "PWD", "OLDPWD"];

const MARK: &str = "__environment_of_the_machine__";

pub type Environment = BTreeMap<String, String>;

/// The daemon's own environment: what commands run in when the user's shell says nothing.
pub fn own() -> Environment {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// The shell of the daemon's user: as the system has it, or as the environment says.
pub fn user_shell() -> String {
    let shell = sys::login_shell()
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_default();
    let name = Path::new(&shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !shell.is_empty() && KNOWN.contains(&name) {
        shell
    } else {
        "/bin/bash".into()
    }
}

/// What `print-environment` writes: this process's variables, as one JSON object.
pub fn print() -> String {
    serde_json::to_string(&own()).unwrap_or_else(|_| "{}".into())
}

/// A path inside single quotes, as a shell takes it.
fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The environment the user's shell has once it has read its files. It fails when the shell
/// cannot be run, does not end in time, or says nothing that can be read.
pub fn capture(shell: &str, home: &Path, timeout: Duration) -> Result<Environment, String> {
    // Printed by this same program, by its path, so that it does not depend on what the shell
    // can find.
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    let print = format!("{} print-environment", quoted(&program.to_string_lossy()));
    let name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let mut script = Vec::new();
    // A login bash reads its profile and not `.bashrc`, which is where most of a setup is.
    if name == "bash" {
        script.push("[ -r ~/.bashrc ] && . ~/.bashrc".to_string());
    }
    script.push(format!("printf '%s' '{MARK}'"));
    script.push(print);
    script.push(format!("printf '%s' '{MARK}'"));

    let mut command = Command::new(shell);
    command
        .arg("-ilc")
        .arg(script.join("; "))
        .current_dir(home)
        .env("HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // A group of its own, so that all of it can be ended when it takes too long.
    let mut child = sys::in_own_session(&mut command)
        .spawn()
        .map_err(|error| error.to_string())?;
    let pid = child.id() as i32;
    let mut stdout = child.stdout.take().ok_or("it has no output to read")?;
    let (said, heard) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        // No more than 8 MiB of it is kept.
        let _ = stdout.by_ref().take(8 << 20).read_to_end(&mut output);
        let _ = said.send(output);
    });
    let output = heard.recv_timeout(timeout);
    if output.is_err() {
        sys::signal_group(pid, libc::SIGKILL);
    }
    let _ = child.wait();
    let output = output.map_err(|_| format!("it did not end within {} ms", timeout.as_millis()))?;

    // What the shell's files printed themselves is before the first mark.
    let text = String::from_utf8_lossy(&output);
    let (Some(start), Some(end)) = (text.find(MARK), text.rfind(MARK)) else {
        return Err("it did not print its environment".into());
    };
    if end <= start {
        return Err("it did not print its environment".into());
    }
    let parsed: Environment = serde_json::from_str(&text[start + MARK.len()..end])
        .map_err(|_| "what it printed is not an environment".to_string())?;
    Ok(parsed
        .into_iter()
        .filter(|(name, _)| !OF_THE_SHELL.contains(&name.as_str()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_quoted_whatever_is_in_it() {
        assert_eq!(quoted("/usr/bin/machine"), "'/usr/bin/machine'");
        assert_eq!(quoted("/it's here/machine"), r"'/it'\''s here/machine'");
    }

    #[test]
    fn the_user_shell_is_one_that_takes_the_flags_it_is_run_with() {
        let shell = user_shell();
        let name = Path::new(&shell)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(KNOWN.contains(&name.as_str()), "{shell}");
    }

    #[test]
    fn its_own_environment_is_printed_as_json() {
        let printed: Environment = serde_json::from_str(&print()).unwrap();
        assert_eq!(printed.get("PATH"), std::env::var("PATH").ok().as_ref());
    }
}
