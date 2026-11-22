//! The commands of a machine: started, watched and stopped here, and kept on disk so that
//! neither a restart of the daemon nor a lost connection loses one.
//!
//! Each command has a folder, `tasks/<actor>/<task>/`:
//!
//! ```text
//! meta.json    what was asked, written before anything is started
//! pid          the process that runs it, written by that process
//! output.log   everything it writes, stdout and stderr together
//! status       its exit status, written when it ends
//! stop         what asked for it to be stopped, written before it is signalled
//! ended.json   how it ended, kept until the engine has acknowledged it
//! acked        the engine has acknowledged the ending
//! ```
//!
//! A command does not run under the daemon. It runs under a small shell of its own, in its own
//! process group, which writes `status` when the command ends. So a command outlives the
//! daemon, and a daemon that starts finds what ran, and what ended, while it was away.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::environment::Environment;
use crate::files::resolve;
use crate::protocol::{
    EndStatus, Ended, ErrorCode, Ref, Refused, RunParams, RunningRef, StoppedBy, is_name,
};
use crate::sys;

/// The shell a command runs under. `$1` is the command and `$2` its folder. It says which
/// process it is, runs the command, and writes how it ended. A signal sent to the group ends
/// the command, not this shell: the trap is the shell's own, and a command it starts does not
/// inherit it. What this shell has to say itself, such as that the command was terminated,
/// goes nowhere: the log is the command's alone.
const WRAPPER: &str = r#"echo $$ > "$2/pid"
trap : TERM INT HUP
bash -c "$1" 2>&1
code=$?
echo "$code" > "$2/status.tmp" && mv "$2/status.tmp" "$2/status""#;

/// What every command has in its environment, whatever the user's has. A command has no input
/// and no terminal, so one that would open a pager or an editor, or ask for a password, would
/// wait for ever: with these it goes straight through, or fails at once.
const FIXED: [(&str, &str); 4] = [
    ("PAGER", "cat"),
    ("GIT_PAGER", "cat"),
    ("GIT_EDITOR", "true"),
    ("GIT_TERMINAL_PROMPT", "0"),
];

/// How long a daemon that finds a command with no process ID waits for its shell to say it.
const PID_WAIT_MS: u64 = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Meta {
    actor: String,
    task: String,
    command: String,
    /// Where it was started, with `~` resolved.
    cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout: Option<f64>,
    #[serde(rename = "startedAt")]
    started_at: u64,
    /// When the machine was started, as it was when the command was.
    boot: u64,
}

struct Running {
    meta: Meta,
    dir: PathBuf,
    /// The shell it runs under, which leads its process group. Unknown for a moment after a
    /// daemon that did not start it finds it.
    pid: Option<i32>,
    stop_by: Option<StoppedBy>,
    /// When the group is killed, if asking it to end was not enough.
    kill_at: Option<u64>,
    /// When its output was last measured against the limit.
    sized_at: u64,
}

pub struct Options {
    /// The folder the commands' folders are in.
    pub dir: PathBuf,
    /// What `~` is.
    pub home: PathBuf,
    /// How long a command that was asked to end has before it is killed.
    pub stop_grace_ms: u64,
    /// A command that writes more than this many bytes is stopped.
    pub output_limit: u64,
    /// How much of the end of its output an ending carries, in bytes.
    pub tail_bytes: u64,
    /// How long a command's folder is kept after its ending was acknowledged.
    pub keep_ms: u64,
}

fn key_of(actor: &str, task: &str) -> String {
    format!("{actor}/{task}")
}

fn number_in(path: &Path) -> Option<i32> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Writes a file whole: beside where it goes, and moved into place.
fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    let beside = path.with_extension("tmp");
    fs::write(&beside, text)?;
    fs::rename(&beside, path)
}

/// How much a file holds, how many lines, and its end.
fn measure(path: &Path, tail_bytes: u64) -> (u64, u64, String) {
    let Ok(mut file) = File::open(path) else {
        return (0, 0, String::new());
    };
    let mut size = 0u64;
    let mut newlines = 0u64;
    let mut last = b'\n';
    let mut chunk = vec![0u8; 1 << 20];
    loop {
        match file.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                newlines += chunk[..read].iter().filter(|&&byte| byte == b'\n').count() as u64;
                last = chunk[read - 1];
                size += read as u64;
            }
        }
    }
    let from = size.saturating_sub(tail_bytes);
    let mut end = Vec::new();
    if file.seek(SeekFrom::Start(from)).is_ok() {
        let _ = file.take(tail_bytes).read_to_end(&mut end);
    }
    // Cut in the middle of a character, the tail starts at the next whole one.
    let mut start = 0;
    if from > 0 {
        while start < end.len() && end[start] & 0xc0 == 0x80 {
            start += 1;
        }
    }
    // A last line with no newline after it is a line too.
    let lines = newlines + u64::from(size > 0 && last != b'\n');
    (
        size,
        lines,
        String::from_utf8_lossy(&end[start..]).into_owned(),
    )
}

pub struct Commands {
    options: Options,
    running: BTreeMap<String, Running>,
    /// Endings the engine has not acknowledged.
    unacked: BTreeMap<String, Ended>,
    swept: u64,
}

impl Commands {
    /// Finds what is on disk: what runs, what ended and was not acknowledged, what can go.
    pub fn open(options: Options) -> std::io::Result<Self> {
        fs::create_dir_all(&options.dir)?;
        let mut commands = Self {
            options,
            running: BTreeMap::new(),
            unacked: BTreeMap::new(),
            swept: 0,
        };
        commands.scan();
        Ok(commands)
    }

    pub fn running(&self) -> Vec<RunningRef> {
        self.running
            .values()
            .map(|running| RunningRef {
                actor: running.meta.actor.clone(),
                task: running.meta.task.clone(),
                log: running
                    .dir
                    .join("output.log")
                    .to_string_lossy()
                    .into_owned(),
            })
            .collect()
    }

    pub fn unacked(&self) -> Vec<Ended> {
        self.unacked.values().cloned().collect()
    }

    fn dir_of(&self, actor: &str, task: &str) -> Result<PathBuf, Refused> {
        if !is_name(actor) || !is_name(task) {
            return Err(Refused::new(
                ErrorCode::Invalid,
                "actor and task are each a name of letters, digits, _ and -",
            ));
        }
        Ok(self.options.dir.join(actor).join(task))
    }

    /// Starts a command, unless this machine has it already. It answers with the file all of
    /// its output goes to.
    pub fn run(
        &mut self,
        params: &RunParams,
        environment: &Environment,
    ) -> Result<String, Refused> {
        let dir = self.dir_of(&params.actor, &params.task)?;
        let log = dir.join("output.log");
        if params.command.is_empty() {
            return Err(Refused::new(
                ErrorCode::Invalid,
                "command is a string that is not empty",
            ));
        }
        if params.cwd.is_empty() {
            return Err(Refused::new(ErrorCode::Invalid, "cwd is a path"));
        }
        // A timeout that is no number at all is none either.
        if params
            .timeout
            .is_some_and(|timeout| timeout.is_nan() || timeout <= 0.0)
        {
            return Err(Refused::new(
                ErrorCode::Invalid,
                "timeout is a number of seconds, more than 0",
            ));
        }
        let key = key_of(&params.actor, &params.task);
        // It is here already: the engine is asking again because it did not hear the first answer.
        if self.running.contains_key(&key) || self.unacked.contains_key(&key) {
            return Ok(log.to_string_lossy().into_owned());
        }
        // An ending the engine acknowledged is one it never asks for again: this is another
        // command that was given the same name, by an engine that started over.
        let _ = fs::remove_dir_all(&dir);

        let start_in = resolve(&self.options.home, &params.cwd, None);
        if !start_in.is_dir() {
            return Err(Refused::new(
                ErrorCode::BadCwd,
                format!("There is no directory {}", start_in.display()),
            ));
        }
        let meta = Meta {
            actor: params.actor.clone(),
            task: params.task.clone(),
            command: params.command.clone(),
            cwd: start_in.to_string_lossy().into_owned(),
            timeout: params.timeout,
            started_at: sys::now_ms(),
            boot: sys::boot_ms(),
        };
        let failed = |why: String| Refused::new(ErrorCode::Failed, why);
        fs::create_dir_all(&dir).map_err(|error| failed(error.to_string()))?;
        let written = serde_json::to_string(&meta).map_err(|error| failed(error.to_string()))?;
        write_whole(&dir.join("meta.json"), &written).map_err(|error| failed(error.to_string()))?;
        let output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .map_err(|error| failed(error.to_string()))?;

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(WRAPPER)
            .arg("sh")
            .arg(&params.command)
            .arg(&dir)
            .current_dir(&start_in)
            // The machine's own, then the actor's over it, then what keeps a command from
            // waiting for a person. The actor's are given to the command, and written nowhere.
            .env_clear()
            .envs(environment)
            .envs(&params.env)
            .envs(FIXED)
            // `~` is the same directory for the command as it is for the engine.
            .env("HOME", &self.options.home)
            .stdin(Stdio::null())
            .stdout(output)
            .stderr(Stdio::null());
        // Its own session and process group, which the daemon's end does not take with it.
        let child = sys::in_own_session(&mut command).spawn().map_err(|_| {
            let _ = fs::remove_dir_all(&dir);
            failed(format!(
                "The command could not be started in {}",
                start_in.display()
            ))
        })?;
        let pid = child.id() as i32;
        // The shell writes this too, for a daemon that ends between the line above and this one.
        let _ = fs::write(dir.join("pid"), format!("{pid}\n"));
        // It is not waited for here: it is looked at with every other, and outlives the daemon.
        drop(child);
        self.running.insert(
            key,
            Running {
                meta,
                dir,
                pid: Some(pid),
                stop_by: None,
                kill_at: None,
                sized_at: sys::now_ms(),
            },
        );
        Ok(log.to_string_lossy().into_owned())
    }

    /// Asks a command to end, and kills it when it has not after the grace.
    pub fn stop(&mut self, target: &Ref, by: StoppedBy) -> Result<(), Refused> {
        let key = key_of(&target.actor, &target.task);
        let grace = self.options.stop_grace_ms;
        let Some(running) = self.running.get_mut(&key) else {
            // One that has ended has nothing left to stop.
            if self
                .dir_of(&target.actor, &target.task)?
                .join("meta.json")
                .exists()
            {
                return Ok(());
            }
            return Err(Refused::new(
                ErrorCode::NotFound,
                format!("This machine has no command {key}"),
            ));
        };
        if running.stop_by.is_some() {
            return Ok(());
        }
        let _ = write_whole(&running.dir.join("stop"), by.as_str());
        running.stop_by = Some(by);
        running.kill_at = Some(sys::now_ms() + grace);
        if let Some(pid) = running.pid {
            sys::signal_group(pid, libc::SIGTERM);
        }
        Ok(())
    }

    /// The engine has the ending: it is not sent again.
    pub fn acked(&mut self, target: &Ref) {
        if self
            .unacked
            .remove(&key_of(&target.actor, &target.task))
            .is_none()
        {
            return;
        }
        if let Ok(dir) = self.dir_of(&target.actor, &target.task) {
            // Its folder may be gone, and with it what there was to send.
            let _ = fs::write(dir.join("acked"), "");
        }
    }

    /// Looks at every command that runs: whether it ended, and whether it is to be stopped.
    /// It gives the endings that were stored since it last looked, each to be sent.
    pub fn tick(&mut self) -> Vec<Ended> {
        sys::reap();
        let now = sys::now_ms();
        let keys: Vec<String> = self.running.keys().cloned().collect();
        let mut ended = Vec::new();
        for key in keys {
            if let Some(one) = self.check(&key, now) {
                ended.push(one);
            }
        }
        if now.saturating_sub(self.swept) > 3_600_000 {
            self.sweep();
        }
        ended
    }

    fn check(&mut self, key: &str, now: u64) -> Option<Ended> {
        let running = self.running.get_mut(key)?;
        let status_file = running.dir.join("status");
        if status_file.exists() {
            return self.finish(key, EndStatus::Exited, number_in(&status_file));
        }
        if running.pid.is_none() {
            running.pid = number_in(&running.dir.join("pid"));
        }
        // A process of the same number after the machine restarted is not this command.
        let same_boot = sys::boot_ms().abs_diff(running.meta.boot) < 30_000;
        let there = same_boot && running.pid.is_some_and(sys::alive);
        if !there {
            // It may have written its status between the two looks.
            return if status_file.exists() {
                self.finish(key, EndStatus::Exited, number_in(&status_file))
            } else {
                self.finish(key, EndStatus::Lost, None)
            };
        }

        if running.stop_by.is_none() {
            let timed_out = running
                .meta
                .timeout
                .is_some_and(|timeout| now >= running.meta.started_at + (timeout * 1000.0) as u64);
            if timed_out {
                let target = Ref {
                    actor: running.meta.actor.clone(),
                    task: running.meta.task.clone(),
                };
                let _ = self.stop(&target, StoppedBy::Timeout);
            } else if now.saturating_sub(running.sized_at) >= 1000 {
                running.sized_at = now;
                let size =
                    fs::metadata(running.dir.join("output.log")).map_or(0, |facts| facts.len());
                if size > self.options.output_limit {
                    let target = Ref {
                        actor: running.meta.actor.clone(),
                        task: running.meta.task.clone(),
                    };
                    let _ = self.stop(&target, StoppedBy::Output);
                }
            }
        } else if running.kill_at.is_some_and(|at| now >= at)
            && let Some(pid) = running.pid
        {
            sys::signal_group(pid, libc::SIGKILL);
        }
        None
    }

    /// Stores how a command ended. None when it could not be stored: it is looked at again.
    fn finish(&mut self, key: &str, status: EndStatus, exit: Option<i32>) -> Option<Ended> {
        let running = self.running.get(key)?;
        // Whatever a stopped command left behind in its group goes with it.
        if running.stop_by.is_some()
            && let Some(pid) = running.pid
        {
            sys::signal_group(pid, libc::SIGKILL);
        }
        // When it ended, which may have been while no daemon was looking.
        let ended_at = sys::mtime_ms(&running.dir.join("status")).unwrap_or_else(sys::now_ms);
        let (bytes, lines, tail) =
            measure(&running.dir.join("output.log"), self.options.tail_bytes);
        let ended = Ended {
            actor: running.meta.actor.clone(),
            task: running.meta.task.clone(),
            status: if running.stop_by.is_some() {
                EndStatus::Stopped
            } else {
                status
            },
            exit,
            by: running.stop_by,
            ran_ms: ended_at.saturating_sub(running.meta.started_at),
            bytes,
            lines,
            tail,
        };
        let written = serde_json::to_string(&ended).ok()?;
        write_whole(&running.dir.join("ended.json"), &written).ok()?;
        self.running.remove(key);
        self.unacked.insert(key.to_string(), ended.clone());
        Some(ended)
    }

    /// Reads what the folders say.
    fn scan(&mut self) {
        let folders = |dir: &Path| -> Vec<String> {
            let Ok(entries) = fs::read_dir(dir) else {
                return Vec::new();
            };
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        };
        for actor in folders(&self.options.dir) {
            for task in folders(&self.options.dir.join(&actor)) {
                let dir = self.options.dir.join(&actor).join(&task);
                let meta: Option<Meta> = fs::read(dir.join("meta.json"))
                    .ok()
                    .and_then(|text| serde_json::from_slice(&text).ok());
                let has_ended = dir.join("ended.json").exists();
                let mut pid = number_in(&dir.join("pid"));
                // A daemon that ended just as it started a command left it to the command's
                // shell to say which process it is, which takes the shell a moment.
                if let Some(meta) = &meta
                    && pid.is_none()
                    && !has_ended
                {
                    let until = (meta.started_at + 2000).min(sys::now_ms() + PID_WAIT_MS);
                    while pid.is_none() && sys::now_ms() < until {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        pid = number_in(&dir.join("pid"));
                    }
                }
                // Its folder was made and nothing was started in it.
                let Some(meta) = meta.filter(|_| pid.is_some() || has_ended) else {
                    let _ = fs::remove_dir_all(&dir);
                    continue;
                };
                if dir.join("acked").exists() {
                    continue;
                }
                let key = key_of(&meta.actor, &meta.task);
                let ended: Option<Ended> = fs::read(dir.join("ended.json"))
                    .ok()
                    .and_then(|text| serde_json::from_slice(&text).ok());
                if let Some(ended) = ended {
                    self.unacked.insert(key, ended);
                    continue;
                }
                let stop_file = dir.join("stop");
                let stop_by = fs::read_to_string(&stop_file)
                    .ok()
                    .and_then(|text| StoppedBy::parse(&text));
                let kill_at = stop_by.map(|_| {
                    sys::mtime_ms(&stop_file).unwrap_or_else(sys::now_ms)
                        + self.options.stop_grace_ms
                });
                self.running.insert(
                    key,
                    Running {
                        meta,
                        dir,
                        pid,
                        stop_by,
                        kill_at,
                        sized_at: 0,
                    },
                );
            }
        }
        self.sweep();
    }

    /// Removes the folders of commands whose ending was acknowledged long enough ago.
    fn sweep(&mut self) {
        self.swept = sys::now_ms();
        let Ok(actors) = fs::read_dir(&self.options.dir) else {
            return;
        };
        for actor in actors.flatten() {
            let Ok(tasks) = fs::read_dir(actor.path()) else {
                continue;
            };
            for task in tasks.flatten() {
                let acked = sys::mtime_ms(&task.path().join("acked"));
                if acked.is_some_and(|at| self.swept.saturating_sub(at) > self.options.keep_ms) {
                    let _ = fs::remove_dir_all(task.path());
                }
            }
            // An actor with no command left has no folder left.
            let _ = fs::remove_dir(actor.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct Machine {
        root: PathBuf,
        commands: Commands,
        environment: Environment,
        /// The endings that were stored and that no test has asked for yet.
        seen: Vec<Ended>,
    }

    fn options(root: &Path) -> Options {
        Options {
            dir: root.join("tasks"),
            home: root.join("home"),
            stop_grace_ms: 300,
            output_limit: 256 << 20,
            tail_bytes: 64 << 10,
            keep_ms: 7 * 24 * 3_600_000,
        }
    }

    fn machine(name: &str) -> Machine {
        let root =
            std::env::temp_dir().join(format!("acentric-machine-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("home/work")).unwrap();
        let root = root.canonicalize().unwrap();
        let commands = Commands::open(options(&root)).unwrap();
        let mut environment = crate::environment::own();
        environment.insert("FROM_THE_MACHINE".into(), "its own".into());
        Machine {
            root,
            commands,
            environment,
            seen: Vec::new(),
        }
    }

    fn run_of(task: &str, command: &str) -> RunParams {
        RunParams {
            actor: "act_1".into(),
            task: task.into(),
            command: command.into(),
            cwd: "~/work".into(),
            timeout: None,
            env: BTreeMap::new(),
        }
    }

    impl Machine {
        fn run(&mut self, params: &RunParams) -> Result<String, Refused> {
            self.commands.run(params, &self.environment)
        }

        /// Looks until a command has ended, and gives how.
        fn ended(&mut self, task: &str) -> Ended {
            let until = Instant::now() + Duration::from_secs(20);
            while Instant::now() < until {
                self.seen.extend(self.commands.tick());
                if let Some(at) = self.seen.iter().position(|ended| ended.task == task) {
                    return self.seen.remove(at);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("{task} never ended");
        }
    }

    impl Drop for Machine {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_command_runs_with_bash_where_it_is_told_and_says_how_it_ended() {
        let mut machine = machine("runs");
        let log = machine
            .run(&run_of(
                "b1",
                "pwd; echo to stderr >&2; printf 'no newline'; exit 3",
            ))
            .unwrap();
        assert_eq!(
            log,
            machine
                .root
                .join("tasks/act_1/b1/output.log")
                .to_string_lossy()
        );
        assert_eq!(machine.commands.running().len(), 1);
        let ended = machine.ended("b1");
        assert_eq!(
            (ended.status, ended.exit, ended.by),
            (EndStatus::Exited, Some(3), None)
        );
        // Everything it wrote, stdout and stderr together, and nothing of the shell's own.
        let home = machine.root.join("home/work");
        assert_eq!(
            ended.tail,
            format!("{}\nto stderr\nno newline", home.display())
        );
        assert_eq!((ended.bytes, ended.lines), (ended.tail.len() as u64, 3));
        assert_eq!(fs::read_to_string(log).unwrap(), ended.tail);
        // Its ending is kept until the engine has it.
        assert_eq!(machine.commands.unacked(), vec![ended]);
        assert!(machine.commands.running().is_empty());
        machine.commands.acked(&Ref {
            actor: "act_1".into(),
            task: "b1".into(),
        });
        assert!(machine.commands.unacked().is_empty());
        assert!(machine.root.join("tasks/act_1/b1/acked").exists());
    }

    #[test]
    fn a_command_has_the_machines_environment_the_actors_over_it_and_no_input() {
        let mut machine = machine("environment");
        let mut params = run_of(
            "b1",
            r#"echo "$FROM_THE_MACHINE|$FROM_THE_ACTOR|$PAGER|$GIT_TERMINAL_PROMPT|$HOME"; cat; echo "read: $?""#,
        );
        params
            .env
            .insert("FROM_THE_ACTOR".into(), "the actor's".into());
        params
            .env
            .insert("FROM_THE_MACHINE".into(), "over the machine's".into());
        machine.run(&params).unwrap();
        let ended = machine.ended("b1");
        let home = machine.root.join("home");
        assert_eq!(
            ended.tail,
            format!(
                "over the machine's|the actor's|cat|0|{}\nread: 0\n",
                home.display()
            )
        );
        // What the actor gave is written nowhere on the machine.
        let meta = fs::read_to_string(machine.root.join("tasks/act_1/b1/meta.json")).unwrap();
        assert!(!meta.contains("the actor's"));
    }

    #[test]
    fn a_command_this_machine_has_is_not_started_twice() {
        let mut machine = machine("twice");
        let params = run_of("b1", "echo once >> ~/work/count; sleep 0.2");
        let first = machine.run(&params).unwrap();
        // The engine asks again: it did not hear the first answer.
        assert_eq!(machine.run(&params).unwrap(), first);
        machine.ended("b1");
        // And again, before it has acknowledged the ending.
        assert_eq!(machine.run(&params).unwrap(), first);
        assert_eq!(
            fs::read_to_string(machine.root.join("home/work/count")).unwrap(),
            "once\n"
        );
        // Acknowledged, the name is free: an engine that started over may give it again.
        machine.commands.acked(&Ref {
            actor: "act_1".into(),
            task: "b1".into(),
        });
        machine.run(&params).unwrap();
        machine.ended("b1");
        assert_eq!(
            fs::read_to_string(machine.root.join("home/work/count")).unwrap(),
            "once\nonce\n"
        );
    }

    #[test]
    fn a_command_that_cannot_be_started_is_refused_with_why() {
        let mut machine = machine("refused");
        let code = |result: Result<String, Refused>| result.unwrap_err().code;
        let mut nowhere = run_of("b1", "true");
        nowhere.cwd = "~/gone".into();
        let refused = machine.run(&nowhere).unwrap_err();
        assert_eq!(refused.code, ErrorCode::BadCwd);
        assert_eq!(
            refused.message,
            format!(
                "There is no directory {}",
                machine.root.join("home/gone").display()
            )
        );
        assert_eq!(code(machine.run(&run_of("b1", ""))), ErrorCode::Invalid);
        assert_eq!(
            code(machine.run(&run_of("../b1", "true"))),
            ErrorCode::Invalid
        );
        let mut timed = run_of("b1", "true");
        timed.timeout = Some(0.0);
        assert_eq!(code(machine.run(&timed)), ErrorCode::Invalid);
        // Nothing of any of them is left.
        assert!(machine.commands.running().is_empty());
        assert!(!machine.root.join("tasks/act_1").exists());
    }

    #[test]
    fn a_command_is_stopped_when_asked_and_killed_when_it_will_not_end() {
        let mut machine = machine("stopped");
        machine
            .run(&run_of("b1", "echo started; sleep 30"))
            .unwrap();
        // One that takes no notice of being asked.
        machine
            .run(&run_of(
                "b2",
                "trap '' TERM; echo deaf; while :; do sleep 0.1; done",
            ))
            .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let began = Instant::now();
        for task in ["b1", "b2"] {
            machine
                .commands
                .stop(
                    &Ref {
                        actor: "act_1".into(),
                        task: task.into(),
                    },
                    StoppedBy::Stop,
                )
                .unwrap();
        }
        let asked = machine.ended("b1");
        assert_eq!(
            (asked.status, asked.by),
            (EndStatus::Stopped, Some(StoppedBy::Stop))
        );
        // What it wrote, and on some systems a line of its bash's own, which says that what it
        // ran was terminated.
        assert!(
            ["started\n", "started\nTerminated\n"].contains(&asked.tail.as_str()),
            "{:?}",
            asked.tail
        );
        assert!(
            began.elapsed() < Duration::from_millis(250),
            "{:?}",
            began.elapsed()
        );
        let killed = machine.ended("b2");
        assert_eq!(
            (killed.status, killed.by, killed.exit),
            (EndStatus::Stopped, Some(StoppedBy::Stop), None)
        );
        assert!(began.elapsed() >= Duration::from_millis(300));

        // One that has ended has nothing left to stop, and one there never was is said to be none.
        assert!(
            machine
                .commands
                .stop(
                    &Ref {
                        actor: "act_1".into(),
                        task: "b1".into()
                    },
                    StoppedBy::Stop
                )
                .is_ok()
        );
        let none = machine.commands.stop(
            &Ref {
                actor: "act_1".into(),
                task: "b9".into(),
            },
            StoppedBy::Stop,
        );
        assert_eq!(none.unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn a_command_is_stopped_at_its_timeout_and_when_it_writes_too_much() {
        let mut machine = machine("limits");
        machine.commands.options.output_limit = 4000;
        let mut slow = run_of("b1", "echo started; sleep 30");
        slow.timeout = Some(0.2);
        machine.run(&slow).unwrap();
        machine
            .run(&run_of(
                "b2",
                "while :; do echo 0123456789012345678901234567890123456789; done",
            ))
            .unwrap();
        let timed_out = machine.ended("b1");
        assert_eq!(
            (timed_out.status, timed_out.by),
            (EndStatus::Stopped, Some(StoppedBy::Timeout))
        );
        assert!(
            (200..2000).contains(&timed_out.ran_ms),
            "{}",
            timed_out.ran_ms
        );
        let too_much = machine.ended("b2");
        assert_eq!(
            (too_much.status, too_much.by),
            (EndStatus::Stopped, Some(StoppedBy::Output))
        );
        assert!(too_much.bytes > 4000);
    }

    #[test]
    fn an_ending_carries_the_end_of_a_long_output_from_a_whole_character_on() {
        let mut machine = machine("tail");
        machine.commands.options.tail_bytes = 7;
        machine
            .run(&run_of("b1", "printf 'first\\nsecond é\\nlast'"))
            .unwrap();
        let ended = machine.ended("b1");
        assert_eq!((ended.bytes, ended.lines), (20, 3));
        assert_eq!(ended.tail, "é\nlast");
        // The last six bytes start in the middle of the é, which is left out.
        machine.commands.options.tail_bytes = 6;
        machine
            .run(&run_of("b2", "printf 'first\\nsecond é\\nlast'"))
            .unwrap();
        assert_eq!(machine.ended("b2").tail, "\nlast");
    }

    #[test]
    fn a_daemon_that_starts_finds_what_ran_and_what_ended_while_it_was_away() {
        let mut machine = machine("restart");
        machine
            .run(&run_of("b1", "sleep 0.4; echo done later"))
            .unwrap();
        machine.run(&run_of("b2", "echo done at once")).unwrap();
        machine.run(&run_of("b3", "sleep 30")).unwrap();
        let ended = machine.ended("b2");
        machine
            .commands
            .stop(
                &Ref {
                    actor: "act_1".into(),
                    task: "b3".into(),
                },
                StoppedBy::Stop,
            )
            .unwrap();

        // The daemon is gone, and another is started on the same folder a while later.
        std::thread::sleep(Duration::from_millis(600));
        machine.commands = Commands::open(options(&machine.root)).unwrap();
        // What ended and was not acknowledged is sent again.
        assert_eq!(machine.commands.unacked(), vec![ended]);
        // What ran while it was away is told with when it ended, not when it was found.
        let later = machine.ended("b1");
        assert_eq!(
            (later.status, later.exit, later.tail.as_str()),
            (EndStatus::Exited, Some(0), "done later\n")
        );
        assert!((400..560).contains(&later.ran_ms), "{}", later.ran_ms);
        // What was being stopped is stopped, by what asked for it.
        let stopped = machine.ended("b3");
        assert_eq!(
            (stopped.status, stopped.by),
            (EndStatus::Stopped, Some(StoppedBy::Stop))
        );
    }

    #[test]
    fn a_command_that_is_gone_without_a_word_is_lost() {
        let mut machine = machine("lost");
        machine
            .run(&run_of("b1", "echo started; sleep 30"))
            .unwrap();
        std::thread::sleep(Duration::from_millis(150));
        // Killed from outside, shell and all: nothing writes how it ended.
        let pid = number_in(&machine.root.join("tasks/act_1/b1/pid")).unwrap();
        sys::signal_group(pid, libc::SIGKILL);
        let lost = machine.ended("b1");
        assert_eq!(
            (lost.status, lost.exit, lost.by, lost.tail.as_str()),
            (EndStatus::Lost, None, None, "started\n")
        );
    }

    #[test]
    fn a_folder_with_nothing_started_in_it_and_one_long_acknowledged_are_removed() {
        let root =
            std::env::temp_dir().join(format!("acentric-machine-sweep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let tasks = root.join("tasks/act_1");
        fs::create_dir_all(tasks.join("b1")).unwrap();
        fs::create_dir_all(tasks.join("b2")).unwrap();
        let meta =
            r#"{"actor":"act_1","task":"b2","command":"true","cwd":"/","startedAt":1,"boot":1}"#;
        fs::write(tasks.join("b2/meta.json"), meta).unwrap();
        fs::write(tasks.join("b2/pid"), "1\n").unwrap();
        fs::write(tasks.join("b2/ended.json"), "{}").unwrap();
        fs::write(tasks.join("b2/acked"), "").unwrap();

        let commands = Commands::open(options(&root)).unwrap();
        // Nothing was started in the first. The second was acknowledged a moment ago.
        assert!(!tasks.join("b1").exists());
        assert!(tasks.join("b2").exists());
        assert!(commands.unacked().is_empty() && commands.running().is_empty());
        // Acknowledged long enough ago, it goes, and its actor's folder with it.
        let mut gone = options(&root);
        gone.keep_ms = 0;
        std::thread::sleep(Duration::from_millis(5));
        drop(Commands::open(gone).unwrap());
        assert!(!tasks.exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
