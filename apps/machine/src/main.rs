//! The daemon's command line.
//!
//! ```text
//! acentric-machine enrol --server <url> --id <id> --token <token>
//!                       joins this machine to an engine, once
//! acentric-machine provision <file>
//!                       the same, from a file an engine put in a sandbox it made:
//!                       { server, id, token }. The file is removed
//! acentric-machine connect
//!                       connects, and stays connected until it is stopped
//! ```
//!
//! Its folder is `~/.acentric`, or MACHINE_DIR. MACHINE_SHELL names the shell whose
//! environment commands run in, in place of the user's own, and `none` leaves them the
//! daemon's environment. Every other setting is for tests: MACHINE_PING_MS,
//! MACHINE_SILENCE_MS, MACHINE_RECONNECT_MS, MACHINE_STOP_GRACE_MS, MACHINE_OUTPUT_LIMIT.

mod commands;
mod daemon;
mod environment;
mod files;
mod identity;
mod protocol;
mod sys;
mod tls;
mod update;

use std::path::PathBuf;
use std::process::ExitCode;

use serde::Deserialize;

use crate::daemon::{Daemon, Options, Times};

/// What the command prints: its name and its version.
fn version_line() -> String {
    format!("acentric-machine {}", env!("CARGO_PKG_VERSION"))
}

/// The home directory of the daemon's user.
fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

/// The daemon's folder.
fn folder() -> PathBuf {
    std::env::var_os("MACHINE_DIR").map_or_else(|| home().join(".acentric"), PathBuf::from)
}

/// A setting that is a number, when it is given.
fn number_of(name: &str) -> Result<Option<u64>, String> {
    match std::env::var(name) {
        Err(_) => Ok(None),
        Ok(value) => value
            .parse()
            .map(Some)
            .map_err(|_| format!("{name} is not a number")),
    }
}

/// The value that follows `--name` among the arguments.
fn flag(args: &[String], name: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == name)?;
    args.get(at + 1).cloned()
}

fn enrol(args: &[String]) -> Result<(), String> {
    let (Some(server), Some(id), Some(token)) = (
        flag(args, "--server"),
        flag(args, "--id"),
        flag(args, "--token"),
    ) else {
        return Err("enrol takes --server, --id and --token".into());
    };
    identity::enrol(&folder(), &server, &id, &token)?;
    println!("enrolled as {id}");
    Ok(())
}

/// What a sandbox's start-up runs: the engine that made the sandbox put this file in it.
fn provision(args: &[String]) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Given {
        server: String,
        id: String,
        token: String,
    }
    let [file] = args else {
        return Err("provision takes the file to enrol from".into());
    };
    let given: Given = std::fs::read(file)
        .ok()
        .and_then(|text| serde_json::from_slice(&text).ok())
        .ok_or_else(|| format!("{file} is not a file to enrol from"))?;
    identity::enrol(&folder(), &given.server, &given.id, &given.token)?;
    // Its token works once, and is of no use to anyone who finds the file.
    let _ = std::fs::remove_file(file);
    println!("enrolled as {}", given.id);
    Ok(())
}

fn connect() -> Result<bool, String> {
    let defaults = Times::default();
    let reconnect = number_of("MACHINE_RECONNECT_MS")?;
    let times = Times {
        ping_ms: number_of("MACHINE_PING_MS")?.unwrap_or(defaults.ping_ms),
        silence_ms: number_of("MACHINE_SILENCE_MS")?.unwrap_or(defaults.silence_ms),
        stop_grace_ms: number_of("MACHINE_STOP_GRACE_MS")?.unwrap_or(defaults.stop_grace_ms),
        reconnect_ms: reconnect.map_or(defaults.reconnect_ms, |first| (first, first * 8)),
        ..defaults
    };
    let shell = match std::env::var("MACHINE_SHELL") {
        Ok(shell) if shell == "none" => None,
        Ok(shell) if !shell.is_empty() => Some(shell),
        _ => Some(environment::user_shell()),
    };
    let options = Options {
        dir: folder(),
        home: home(),
        shell,
        times,
        output_limit: number_of("MACHINE_OUTPUT_LIMIT")?.unwrap_or(256 << 20),
        tail_bytes: 64 << 10,
    };
    sys::listen_for_stop();
    let mut daemon = Daemon::start(options)?;
    Ok(daemon.run())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Where its program is, read before anything replaces it: a system may say of a program
    // that was replaced only that it is gone.
    let program = std::env::current_exe().and_then(|path| path.canonicalize());
    let (command, rest) = args
        .split_first()
        .map_or(("", &[][..]), |(command, rest)| (command.as_str(), rest));
    let done = match command {
        "enrol" => enrol(rest),
        "provision" => provision(rest),
        "connect" => match connect() {
            Ok(false) => Ok(()),
            // Its program was replaced: it becomes the new one, as the same process.
            Ok(true) => match &program {
                Ok(program) => Err(format!(
                    "The new program could not be started: {}",
                    sys::become_program(program, &args)
                )),
                Err(error) => Err(error.to_string()),
            },
            Err(why) => Err(why),
        },
        // What the user's shell runs, so that the daemon can read its environment.
        "print-environment" => {
            print!("{}", environment::print());
            Ok(())
        }
        "--version" | "version" => {
            println!("{}", version_line());
            Ok(())
        }
        _ => Err("acentric-machine takes enrol, provision or connect".into()),
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("acentric-machine: {why}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_its_name_and_version() {
        let line = version_line();
        let version = line.strip_prefix("acentric-machine ");
        assert!(version.is_some_and(|version| !version.is_empty()));
    }

    #[test]
    fn a_flag_is_read_with_what_follows_it() {
        let args: Vec<String> = ["--server", "http://e", "--id", "mch_1"]
            .map(String::from)
            .to_vec();
        assert_eq!(flag(&args, "--id").as_deref(), Some("mch_1"));
        assert_eq!(flag(&args, "--token"), None);
    }
}
