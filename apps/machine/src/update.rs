//! Taking the engine's own build of the daemon, in place of this one.
//!
//! An engine hands out the daemon of its own build, for each system it has one for. When the
//! engine asks, the daemon fetches the one for this machine, checks that it is what the engine
//! said it hands out, puts it in place of its own program, and becomes it. The commands that
//! run are not touched: they do not run under the daemon.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};

use crate::protocol::{ErrorCode, Refused};
use crate::sys;

/// The most a program that is fetched may be.
const MOST_BYTES: u64 = 256 << 20;

/// The SHA-256 of bytes, in hex: what names a build of the daemon.
pub fn digest_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Which build this daemon is: the digest of its own program. None when it cannot be read.
pub fn own_build() -> Option<String> {
    let program = std::env::current_exe().ok()?;
    Some(digest_of(&fs::read(program).ok()?))
}

/// Where an engine hands out the daemon for this machine.
pub fn download_path() -> String {
    format!("/machine/{}-{}", sys::os(), sys::arch())
}

/// Checks a program that was fetched, and puts it in place of `program`. False when `program`
/// is that build already, and nothing was changed.
pub fn replace(program: &Path, fetched: &[u8], expected: &str) -> Result<bool, Refused> {
    let failed = |why: String| Refused::new(ErrorCode::Failed, why);
    let digest = digest_of(fetched);
    if digest != expected {
        return Err(failed(
            "What the engine handed out is not what it said it hands out".into(),
        ));
    }
    let own = fs::read(program).map_err(|error| failed(error.to_string()))?;
    if digest_of(&own) == digest {
        return Ok(false);
    }
    // Beside where it goes, and moved into place: the program is whole at every moment.
    let beside = program.with_extension("new");
    fs::write(&beside, fetched)
        .and_then(|()| fs::set_permissions(&beside, fs::Permissions::from_mode(0o755)))
        .map_err(|error| failed(format!("The program could not be written: {error}")))?;
    // It is run once before it is trusted with the machine.
    let runs = Command::new(&beside)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !runs {
        let _ = fs::remove_file(&beside);
        return Err(failed(
            "What the engine handed out does not run on this machine".into(),
        ));
    }
    fs::rename(&beside, program)
        .map_err(|error| failed(format!("The program could not be replaced: {error}")))?;
    Ok(true)
}

/// Fetches the engine's build for this machine, and puts it in place of this daemon's program.
/// False when this is that build already.
pub fn update(server: &str, expected: &str) -> Result<bool, Refused> {
    let failed = |why: String| Refused::new(ErrorCode::Failed, why);
    let program = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|error| failed(error.to_string()))?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut answer = agent
        .get(format!("{server}{}", download_path()))
        .call()
        .map_err(|error| failed(format!("The engine could not be reached: {error}")))?;
    if !answer.status().is_success() {
        return Err(failed(format!(
            "The engine hands out no program for {}-{} (it answered {})",
            sys::os(),
            sys::arch(),
            answer.status().as_u16()
        )));
    }
    let fetched = answer
        .body_mut()
        .with_config()
        .limit(MOST_BYTES)
        .read_to_vec()
        .map_err(|error| failed(format!("The program could not be fetched: {error}")))?;
    replace(&program, &fetched, expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "acentric-machine-update-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const OLD: &[u8] = b"#!/bin/sh\necho old\n";
    const NEW: &[u8] = b"#!/bin/sh\necho new\n";

    #[test]
    fn a_build_is_named_by_the_digest_of_its_program() {
        assert_eq!(
            digest_of(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            download_path(),
            format!("/machine/{}-{}", sys::os(), sys::arch())
        );
    }

    #[test]
    fn the_program_is_replaced_by_one_that_is_what_was_said_and_runs() {
        let dir = folder("replace");
        let program = dir.join("acentric-machine");
        fs::write(&program, OLD).unwrap();
        assert_eq!(replace(&program, NEW, &digest_of(NEW)), Ok(true));
        assert_eq!(fs::read(&program).unwrap(), NEW);
        assert_eq!(
            fs::metadata(&program).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // It is that build now: nothing is changed, and nothing is left beside it.
        assert_eq!(replace(&program, NEW, &digest_of(NEW)), Ok(false));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn what_is_not_what_was_said_or_does_not_run_changes_nothing() {
        let dir = folder("refuse");
        let program = dir.join("acentric-machine");
        fs::write(&program, OLD).unwrap();
        let other = replace(&program, NEW, &digest_of(b"something else")).unwrap_err();
        assert!(
            other.message.contains("not what it said"),
            "{}",
            other.message
        );
        let broken = b"#!/bin/sh\nexit 1\n";
        let unfit = replace(&program, broken, &digest_of(broken)).unwrap_err();
        assert!(unfit.message.contains("does not run"), "{}", unfit.message);
        assert_eq!(fs::read(&program).unwrap(), OLD);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
