//! A machine's files, read and written for the engine a part at a time.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use crate::protocol::{ErrorCode, FILE_BYTES, ReadParams, Refused, WriteParams};

/// A path as the engine gives it: absolute, from `~`, or from `base`, which is one too. From
/// the home directory without a base.
pub fn resolve(home: &Path, path: &str, base: Option<&str>) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return tidy(&home.join(rest));
    }
    if Path::new(path).is_absolute() {
        return tidy(Path::new(path));
    }
    let from = base.map_or_else(|| home.to_path_buf(), |base| resolve(home, base, None));
    tidy(&from.join(path))
}

/// A path without its `.` and `..`, read as text: nothing is looked up.
fn tidy(path: &Path) -> PathBuf {
    let mut tidied = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                tidied.pop();
            }
            other => tidied.push(other),
        }
    }
    tidied
}

/// What went wrong with a file, as the engine is told it.
fn refusal(error: &io::Error, file: &Path, doing: &str) -> Refused {
    let name = file.display();
    match error.kind() {
        io::ErrorKind::NotFound => {
            Refused::new(ErrorCode::NotFound, format!("There is no file {name}"))
        }
        io::ErrorKind::NotADirectory => Refused::new(
            ErrorCode::NotAFile,
            format!("A folder on the way to {name} is a file"),
        ),
        io::ErrorKind::IsADirectory => {
            Refused::new(ErrorCode::NotAFile, format!("{name} is a folder"))
        }
        io::ErrorKind::PermissionDenied => Refused::new(
            ErrorCode::PermissionDenied,
            format!("{name} may not be {doing}"),
        ),
        _ => Refused::new(
            ErrorCode::Failed,
            format!("{name} could not be {doing}: {error}"),
        ),
    }
}

/// Reads a part of a file.
pub fn read(home: &Path, params: &ReadParams) -> Result<Value, Refused> {
    if params.path.is_empty() {
        return Err(Refused::new(ErrorCode::Invalid, "path is a path"));
    }
    let from = params.from.unwrap_or(0);
    let max = params.max.unwrap_or(1 << 20);
    if !(1..=FILE_BYTES).contains(&max) {
        return Err(Refused::new(
            ErrorCode::Invalid,
            "max is a number of bytes, 1 to 8 MiB",
        ));
    }
    let file = resolve(home, &params.path, params.cwd.as_deref());
    let facts = fs::metadata(&file).map_err(|error| match error.kind() {
        // A folder on the way that is a file is, to one who reads, a file that is not there.
        io::ErrorKind::NotADirectory => Refused::new(
            ErrorCode::NotFound,
            format!("There is no file {}", file.display()),
        ),
        _ => refusal(&error, &file, "read"),
    })?;
    if !facts.is_file() {
        return Err(Refused::new(
            ErrorCode::NotAFile,
            format!("{} is not a file", file.display()),
        ));
    }
    let length = max.min(facts.len().saturating_sub(from));
    let mut data = vec![0u8; length as usize];
    if length > 0 {
        let mut handle = fs::File::open(&file).map_err(|error| refusal(&error, &file, "read"))?;
        handle
            .seek(SeekFrom::Start(from))
            .and_then(|_| handle.read_exact(&mut data))
            .map_err(|error| refusal(&error, &file, "read"))?;
    }
    Ok(json!({ "size": facts.len(), "from": from, "data": STANDARD.encode(&data) }))
}

/// Writes bytes to a file: all it has, or more after its end. Its folders are made.
pub fn write(home: &Path, params: &WriteParams) -> Result<Value, Refused> {
    if params.path.is_empty() {
        return Err(Refused::new(ErrorCode::Invalid, "path is a path"));
    }
    let bytes = STANDARD
        .decode(&params.data)
        .map_err(|_| Refused::new(ErrorCode::Invalid, "data is bytes in base64"))?;
    if bytes.len() as u64 > FILE_BYTES {
        return Err(Refused::new(ErrorCode::Invalid, "data is at most 8 MiB"));
    }
    let from = params.from.unwrap_or(0);
    let file = resolve(home, &params.path, params.cwd.as_deref());
    let failed = |error: io::Error| refusal(&error, &file, "written");
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder).map_err(|error| match error.kind() {
            io::ErrorKind::AlreadyExists | io::ErrorKind::NotADirectory => Refused::new(
                ErrorCode::NotAFile,
                format!("A folder on the way to {} is a file", file.display()),
            ),
            _ => failed(error),
        })?;
    }
    if from == 0 {
        fs::write(&file, &bytes).map_err(failed)?;
    } else {
        let facts = fs::metadata(&file).map_err(failed)?;
        if !facts.is_file() {
            return Err(Refused::new(
                ErrorCode::NotAFile,
                format!("{} is not a file", file.display()),
            ));
        }
        if facts.len() != from {
            return Err(Refused::new(
                ErrorCode::NotAtEnd,
                format!(
                    "{} has {} bytes: more after its end starts at {}",
                    file.display(),
                    facts.len(),
                    facts.len()
                ),
            ));
        }
        let mut handle = OpenOptions::new()
            .append(true)
            .open(&file)
            .map_err(failed)?;
        handle.write_all(&bytes).map_err(failed)?;
    }
    let size = fs::metadata(&file).map_err(failed)?.len();
    Ok(json!({ "path": file.to_string_lossy(), "size": size }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "acentric-machine-files-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn reading(path: &str, cwd: Option<&str>, from: Option<u64>, max: Option<u64>) -> ReadParams {
        ReadParams {
            path: path.into(),
            cwd: cwd.map(Into::into),
            from,
            max,
        }
    }

    fn writing(path: &str, from: Option<u64>, bytes: &[u8]) -> WriteParams {
        WriteParams {
            path: path.into(),
            cwd: None,
            from,
            data: STANDARD.encode(bytes),
        }
    }

    #[test]
    fn a_path_is_absolute_or_from_home_or_from_a_base() {
        let home = Path::new("/home/dev");
        assert_eq!(resolve(home, "~", None), Path::new("/home/dev"));
        assert_eq!(
            resolve(home, "~/work/a.txt", None),
            Path::new("/home/dev/work/a.txt")
        );
        assert_eq!(
            resolve(home, "/etc/hosts", Some("~/work")),
            Path::new("/etc/hosts")
        );
        assert_eq!(resolve(home, "a.txt", None), Path::new("/home/dev/a.txt"));
        assert_eq!(
            resolve(home, "src/../a.txt", Some("~/work")),
            Path::new("/home/dev/work/a.txt")
        );
        assert_eq!(
            resolve(home, "a.txt", Some("/srv/app")),
            Path::new("/srv/app/a.txt")
        );
    }

    #[test]
    fn a_file_is_written_whole_then_added_to_and_read_back_in_parts() {
        let home = folder("parts");
        let written = write(&home, &writing("~/deep/er/notes.txt", None, b"hello ")).unwrap();
        assert_eq!(written["size"], 6);
        assert_eq!(
            written["path"],
            home.join("deep/er/notes.txt").to_string_lossy().as_ref()
        );
        // More goes after its end, and nowhere else.
        let more = write(&home, &writing("deep/er/notes.txt", Some(6), b"world")).unwrap();
        assert_eq!(more["size"], 11);
        let misplaced = write(&home, &writing("deep/er/notes.txt", Some(3), b"x")).unwrap_err();
        assert_eq!(misplaced.code, ErrorCode::NotAtEnd);

        let all = read(&home, &reading("deep/er/notes.txt", None, None, None)).unwrap();
        assert_eq!(all["size"], 11);
        assert_eq!(
            STANDARD.decode(all["data"].as_str().unwrap()).unwrap(),
            b"hello world"
        );
        let part = read(
            &home,
            &reading("notes.txt", Some("~/deep/er"), Some(6), Some(3)),
        )
        .unwrap();
        assert_eq!(
            STANDARD.decode(part["data"].as_str().unwrap()).unwrap(),
            b"wor"
        );
        let past = read(&home, &reading("deep/er/notes.txt", None, Some(99), None)).unwrap();
        assert_eq!(
            (past["data"].as_str(), past["size"].as_u64()),
            (Some(""), Some(11))
        );
        // Written from the start again, it is in place of what the file had.
        assert_eq!(
            write(&home, &writing("deep/er/notes.txt", None, b"new")).unwrap()["size"],
            3
        );
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn what_cannot_be_read_or_written_is_said_by_what_it_is() {
        let home = folder("refusals");
        fs::write(home.join("a.txt"), "a").unwrap();
        let code = |result: Result<Value, Refused>| result.unwrap_err().code;
        assert_eq!(
            code(read(&home, &reading("gone.txt", None, None, None))),
            ErrorCode::NotFound
        );
        assert_eq!(
            code(read(&home, &reading("a.txt/b", None, None, None))),
            ErrorCode::NotFound
        );
        assert_eq!(
            code(read(&home, &reading("~", None, None, None))),
            ErrorCode::NotAFile
        );
        assert_eq!(
            code(read(&home, &reading("", None, None, None))),
            ErrorCode::Invalid
        );
        assert_eq!(
            code(read(&home, &reading("a.txt", None, None, Some(0)))),
            ErrorCode::Invalid
        );
        assert_eq!(
            code(read(
                &home,
                &reading("a.txt", None, None, Some(FILE_BYTES + 1))
            )),
            ErrorCode::Invalid
        );

        assert_eq!(
            code(write(&home, &writing("a.txt/b", None, b"x"))),
            ErrorCode::NotAFile
        );
        assert_eq!(
            code(write(&home, &writing("~", None, b"x"))),
            ErrorCode::NotAFile
        );
        assert_eq!(
            code(write(&home, &writing("gone.txt", Some(4), b"x"))),
            ErrorCode::NotFound
        );
        let not_base64 = WriteParams {
            path: "b.txt".into(),
            cwd: None,
            from: None,
            data: "***".into(),
        };
        assert_eq!(code(write(&home, &not_base64)), ErrorCode::Invalid);
        fs::remove_dir_all(&home).unwrap();
    }
}
