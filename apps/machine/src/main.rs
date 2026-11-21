//! The machine daemon's command. It only says what version it is, until the daemon is written.

/// What the command prints: its name and its version.
fn version_line() -> String {
    format!("acentric-machine {}", env!("CARGO_PKG_VERSION"))
}

fn main() {
    println!("{}", version_line());
}

#[cfg(test)]
mod tests {
    use super::version_line;

    #[test]
    fn says_its_name_and_version() {
        let line = version_line();
        let version = line.strip_prefix("acentric-machine ");
        assert!(version.is_some_and(|version| !version.is_empty()));
    }
}
