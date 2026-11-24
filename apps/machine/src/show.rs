//! `show`: what a command runs to have the model shown an image with the command's result.
//!
//! The daemon puts a link to its own program, named `show`, first on every command's `PATH`,
//! and tells the command its folder in `ACENTRIC_TASK_DIR`. `show <file>...` copies each image
//! into the folder, so that what the model is shown is the image as it was when `show` ran,
//! whatever the command does with the file after:
//!
//! ```text
//! images/1        the image, whole: written beside, and moved into place
//! images/1.name   the file as the command named it
//! ```
//!
//! The engine checks each image again, and against its model, when the command has ended:
//! anything can write into a command's folder. What is checked here is what every model
//! has in common, so that a command learns at once, in its own output, what will not be shown.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::protocol::Shown;

/// The variable that names a command's folder.
pub const FOLDER: &str = "ACENTRIC_TASK_DIR";

/// The most images one command shows.
pub const MOST_IMAGES: usize = 5;

/// The largest image the model is shown, in bytes.
pub const MOST_BYTES: u64 = 5 * 1024 * 1024;

fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// The kind of image a file is, by how it starts. Its name says nothing.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The number an image of a command's folder is kept under, for a file that is one.
fn number_of(name: &str) -> Option<usize> {
    if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    name.parse().ok()
}

/// Keeps one image in a command's folder. `given` is the file as the command named it, found
/// from `cwd`.
pub fn show(folder: &Path, cwd: &Path, given: &str) -> Result<(), String> {
    let path = cwd.join(given);
    let facts = fs::metadata(&path).map_err(|_| format!("there is no file {given}"))?;
    if !facts.is_file() {
        return Err(format!("{given} is not a file"));
    }
    if facts.len() > MOST_BYTES {
        return Err(format!(
            "{given} is {}, and the largest image that can be shown is {}",
            megabytes(facts.len()),
            megabytes(MOST_BYTES)
        ));
    }
    let bytes = fs::read(&path).map_err(|error| format!("{given} could not be read: {error}"))?;
    if image_type(&bytes).is_none() {
        return Err(format!("{given} is not a png, jpeg, gif or webp image"));
    }
    let images = folder.join("images");
    let failed = |error: std::io::Error| format!("{given} could not be kept: {error}");
    fs::create_dir_all(&images).map_err(failed)?;
    let kept = fs::read_dir(&images)
        .map_err(failed)?
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".name"))
        .count();
    if kept >= MOST_IMAGES {
        return Err(format!(
            "a command shows at most {MOST_IMAGES} images, and {given} would be one more"
        ));
    }
    // The first number no other `show` has: one that runs beside this one takes another.
    let mut number = kept + 1;
    let mut name = loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(images.join(format!("{number}.name")))
        {
            Ok(file) => break file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => number += 1,
            Err(error) => return Err(failed(error)),
        }
    };
    name.write_all(given.as_bytes()).map_err(failed)?;
    let beside = images.join(format!("{number}.part"));
    fs::write(&beside, &bytes)
        .and_then(|()| fs::rename(&beside, images.join(number.to_string())))
        .map_err(failed)?;
    Ok(())
}

/// The images a command showed, in the order it showed them.
pub fn shown(folder: &Path) -> Vec<Shown> {
    let images = folder.join("images");
    let Ok(entries) = fs::read_dir(&images) else {
        return Vec::new();
    };
    let mut numbers: Vec<usize> = entries
        .flatten()
        .filter_map(|entry| number_of(&entry.file_name().to_string_lossy()))
        .collect();
    numbers.sort_unstable();
    numbers
        .into_iter()
        .take(MOST_IMAGES)
        .map(|number| Shown {
            path: images
                .join(number.to_string())
                .to_string_lossy()
                .into_owned(),
            name: fs::read_to_string(images.join(format!("{number}.name")))
                .unwrap_or_else(|_| format!("image {number}")),
        })
        .collect()
}

/// `show <file>...`, as a command runs it.
pub fn main(files: &[String]) -> ExitCode {
    let Some(folder) = std::env::var_os(FOLDER).map(PathBuf::from) else {
        eprintln!(
            "show: this is not a command your machine runs for an agent, so there is no one to show an image to"
        );
        return ExitCode::FAILURE;
    };
    if files.is_empty() {
        eprintln!("show: give the image files to show, such as: show chart.png");
        return ExitCode::FAILURE;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let mut done = true;
    for file in files {
        if let Err(why) = show(&folder, &cwd, file) {
            eprintln!("show: {why}");
            done = false;
        }
    }
    if done {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

    fn folder(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("acentric-show-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("work")).unwrap();
        root
    }

    #[test]
    fn an_image_is_known_by_how_it_starts() {
        assert_eq!(image_type(PNG), Some("image/png"));
        assert_eq!(image_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a.."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8X"), Some("image/webp"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(image_type(b"<svg/>"), None);
        assert_eq!(image_type(b""), None);
    }

    #[test]
    fn an_image_is_kept_as_it_was_shown_in_the_order_it_was_shown() {
        let root = folder("kept");
        let work = root.join("work");
        fs::write(work.join("a.png"), PNG).unwrap();
        fs::write(work.join("b.gif"), b"GIF89a....").unwrap();
        show(&root, &work, "a.png").unwrap();
        show(&root, &work, &work.join("b.gif").to_string_lossy()).unwrap();
        // What the command does with the file after does not change what is shown.
        fs::write(work.join("a.png"), b"overwritten").unwrap();
        let shown = shown(&root);
        assert_eq!(shown.len(), 2);
        assert_eq!(shown[0].name, "a.png");
        assert_eq!(fs::read(&shown[0].path).unwrap(), PNG);
        assert_eq!(shown[1].name, work.join("b.gif").to_string_lossy());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn what_is_not_an_image_that_can_be_shown_is_refused_with_why() {
        let root = folder("refused");
        let work = root.join("work");
        fs::write(work.join("notes.txt"), "not an image").unwrap();
        let mut large = PNG.to_vec();
        large.resize(6 * 1024 * 1024, 0);
        fs::write(work.join("large.png"), large).unwrap();
        assert_eq!(
            show(&root, &work, "gone.png").unwrap_err(),
            "there is no file gone.png"
        );
        assert_eq!(show(&root, &work, ".").unwrap_err(), ". is not a file");
        assert_eq!(
            show(&root, &work, "notes.txt").unwrap_err(),
            "notes.txt is not a png, jpeg, gif or webp image"
        );
        assert_eq!(
            show(&root, &work, "large.png").unwrap_err(),
            "large.png is 6.0 MB, and the largest image that can be shown is 5.0 MB"
        );
        assert!(shown(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_command_shows_at_most_five() {
        let root = folder("five");
        let work = root.join("work");
        fs::write(work.join("a.png"), PNG).unwrap();
        for _ in 0..MOST_IMAGES {
            show(&root, &work, "a.png").unwrap();
        }
        assert_eq!(
            show(&root, &work, "a.png").unwrap_err(),
            "a command shows at most 5 images, and a.png would be one more"
        );
        assert_eq!(shown(&root).len(), MOST_IMAGES);
        let _ = fs::remove_dir_all(&root);
    }
}
