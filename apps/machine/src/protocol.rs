//! What an engine and a machine's daemon say to each other, over one WebSocket the daemon
//! opens. Every frame is one JSON object with a `type`.
//!
//! A connection starts with the daemon proving which machine it is:
//!
//! ```text
//! engine → daemon   challenge { nonce }
//! daemon → engine   proof { signature }     the nonce, signed with the machine's key
//! engine → daemon   ready
//! daemon → engine   hello { … }             what the machine is, and what it has
//! ```
//!
//! After that the engine sends requests, each with an ID, and the daemon answers each with a
//! response of that ID. The daemon knows nothing of waiting or of tasks let go of: it starts
//! a command, and says when it ended.
//!
//! The same messages are written down for the engine in `packages/protocol/src/machine.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The most bytes one `read` or `write` moves.
pub const FILE_BYTES: u64 = 8 << 20;

/// A command is named by the actor and the task it is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ref {
    pub actor: String,
    pub task: String,
}

/// Whether `name` is an actor's ID or a task's as a folder's name: letters, digits, `_` and
/// `-`, not starting with `-`, 64 at most.
pub fn is_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let first = bytes.next();
    name.len() <= 64
        && first.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// What stopped a command that did not end by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoppedBy {
    Stop,
    Timeout,
    Output,
}

impl StoppedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Timeout => "timeout",
            Self::Output => "output",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "stop" => Some(Self::Stop),
            "timeout" => Some(Self::Timeout),
            "output" => Some(Self::Output),
            _ => None,
        }
    }
}

/// What the engine sends.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromEngine {
    Challenge {
        nonce: String,
    },
    Ready,
    /// A request. Its parameters are read by its method: one this daemon does not have is
    /// answered as invalid, and is no reason to drop the connection.
    Request {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    /// The engine has an ending: it is not sent again.
    Ack {
        actor: String,
        task: String,
    },
    Pong,
}

/// `run`: a command, run by bash, with no input.
#[derive(Debug, Clone, Deserialize)]
pub struct RunParams {
    pub actor: String,
    pub task: String,
    pub command: String,
    /// Where it starts: an absolute path, or one that starts with `~`.
    pub cwd: String,
    /// Seconds it may run before it is stopped. Without it, no limit.
    #[serde(default)]
    pub timeout: Option<f64>,
    /// Variables it is run with, over the machine's own. They are given to the command and
    /// kept nowhere on the machine.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct ReadParams {
    /// An absolute path, one that starts with `~`, or one relative to `cwd`.
    pub path: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// The first byte to read. 0 without it.
    #[serde(default)]
    pub from: Option<u64>,
    /// How many bytes to read at most. 1 MiB without it, and never more than 8 MiB.
    #[serde(default)]
    pub max: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct WriteParams {
    pub path: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Where the bytes go. 0, without it: in place of all the file had, or as a new file.
    /// Otherwise the file's size, for more after its end.
    #[serde(default)]
    pub from: Option<u64>,
    /// The bytes, in base64: at most `FILE_BYTES`.
    pub data: String,
}

/// `update`: the daemon takes the program the engine hands out for this machine, in place of
/// itself.
#[derive(Debug, Deserialize)]
pub struct UpdateParams {
    /// The SHA-256 of the program the engine hands out for this machine, in hex.
    pub digest: String,
}

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request is not one the daemon takes.
    Invalid,
    /// `run`: there is no such directory to start in.
    BadCwd,
    /// No such command, or no such file.
    NotFound,
    /// `write`: what it was to follow is not the end of the file.
    NotAtEnd,
    NotAFile,
    PermissionDenied,
    /// The daemon could not do it.
    Failed,
}

/// A request the daemon refuses, with the code it answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub code: ErrorCode,
    pub message: String,
}

impl Refused {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// A command that runs, with where its output is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunningRef {
    pub actor: String,
    pub task: String,
    pub log: String,
}

/// How a command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndStatus {
    /// It ended by itself.
    Exited,
    /// The daemon ended it.
    Stopped,
    /// It is gone and left nothing to say how: the machine restarted, or it was killed from
    /// outside.
    Lost,
}

/// How a command ended. The daemon keeps it and sends it again on every connection until the
/// engine acknowledges it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ended {
    pub actor: String,
    pub task: String,
    pub status: EndStatus,
    /// Its exit status. Null when it was killed and left none.
    pub exit: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<StoppedBy>,
    #[serde(rename = "ranMs")]
    pub ran_ms: u64,
    /// How much it wrote.
    pub bytes: u64,
    pub lines: u64,
    /// The end of what it wrote.
    pub tail: String,
}

/// What the daemon sends.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromDaemon<'a> {
    Proof {
        signature: String,
    },
    /// Sent once on every connection, before anything else the daemon has to say.
    Hello {
        os: &'a str,
        arch: &'a str,
        /// The home directory of the daemon's user: what `~` is on this machine.
        home: &'a str,
        hostname: &'a str,
        /// The daemon's version.
        version: &'a str,
        /// The SHA-256 of the daemon's own program, in hex: which build of it this is.
        #[serde(skip_serializing_if = "Option::is_none")]
        build: Option<&'a str>,
        /// The folder its commands are kept in: one's output is at
        /// `<tasks>/<actor>/<task>/output.log`.
        tasks: &'a str,
        /// The commands that are running, each with where its output is.
        running: Vec<RunningRef>,
        /// The commands that ended and whose ending the engine has not acknowledged: each
        /// follows.
        ended: Vec<Ref>,
    },
    Response {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ResponseError<'a>>,
    },
    Ended(&'a Ended),
    /// The daemon pings, the engine answers. Either side gives up a connection that has gone
    /// silent.
    Ping,
}

#[derive(Debug, Serialize)]
pub struct ResponseError<'a> {
    pub code: ErrorCode,
    pub message: &'a str,
}

/// What a machine signs to prove itself: its ID and the engine's nonce.
pub fn proof_text(machine: &str, nonce: &str) -> String {
    format!("machine {machine}\n{nonce}")
}

/// Where a daemon connects, on an engine.
pub fn connect_path(machine: &str) -> String {
    format!("/v1/machines/{machine}/connect")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_name_is_what_can_be_a_folder_of_its_own() {
        for name in ["act_01m81a5hnee9r82rp36m4xattp", "b3", "_x", "a-b_c"] {
            assert!(is_name(name), "{name}");
        }
        let long = "a".repeat(65);
        for name in ["", "-a", "a/b", "..", "a b", "a.b", long.as_str()] {
            assert!(!is_name(name), "{name}");
        }
    }

    #[test]
    fn what_the_engine_sends_is_read_by_its_type() {
        let challenge: FromEngine =
            serde_json::from_value(json!({ "type": "challenge", "nonce": "n1" })).unwrap();
        assert!(matches!(challenge, FromEngine::Challenge { nonce } if nonce == "n1"));
        let request: FromEngine = serde_json::from_value(json!({
            "type": "request", "id": 7, "method": "run",
            "params": { "actor": "a", "task": "b1", "command": "echo hi", "cwd": "~" }
        }))
        .unwrap();
        let FromEngine::Request { id, method, params } = request else {
            panic!("not a request")
        };
        assert_eq!((id, method.as_str()), (7, "run"));
        let run: RunParams = serde_json::from_value(params).unwrap();
        assert_eq!(
            (run.command.as_str(), run.timeout, run.env.len()),
            ("echo hi", None, 0)
        );
        // A request with no parameters, and a method this daemon has never heard of, are read.
        let bare: FromEngine =
            serde_json::from_value(json!({ "type": "request", "id": 8, "method": "dance" }))
                .unwrap();
        assert!(matches!(bare, FromEngine::Request { id: 8, .. }));
        assert!(
            serde_json::from_value::<FromEngine>(
                json!({ "type": "ack", "actor": "a", "task": "b1" })
            )
            .is_ok()
        );
        assert!(serde_json::from_value::<FromEngine>(json!({ "type": "nothing" })).is_err());
    }

    #[test]
    fn what_the_daemon_sends_is_as_the_engine_reads_it() {
        let ended = Ended {
            actor: "a".into(),
            task: "b1".into(),
            status: EndStatus::Stopped,
            exit: None,
            by: Some(StoppedBy::Timeout),
            ran_ms: 1200,
            bytes: 3,
            lines: 1,
            tail: "hi\n".into(),
        };
        assert_eq!(
            serde_json::to_value(FromDaemon::Ended(&ended)).unwrap(),
            json!({
                "type": "ended", "actor": "a", "task": "b1", "status": "stopped", "exit": null,
                "by": "timeout", "ranMs": 1200, "bytes": 3, "lines": 1, "tail": "hi\n"
            })
        );
        let exited = Ended {
            status: EndStatus::Exited,
            exit: Some(1),
            by: None,
            ..ended
        };
        assert_eq!(serde_json::to_value(&exited).unwrap()["by"], Value::Null);
        assert!(!serde_json::to_string(&exited).unwrap().contains("\"by\""));
        assert_eq!(
            serde_json::to_value(FromDaemon::Response {
                id: 3,
                result: None,
                error: Some(ResponseError {
                    code: ErrorCode::BadCwd,
                    message: "There is no directory /x"
                }),
            })
            .unwrap(),
            json!({ "type": "response", "id": 3, "error": { "code": "bad_cwd", "message": "There is no directory /x" } })
        );
        assert_eq!(
            serde_json::to_value(FromDaemon::Ping).unwrap(),
            json!({ "type": "ping" })
        );
        assert_eq!(proof_text("mch_1", "n1"), "machine mch_1\nn1");
        assert_eq!(connect_path("mch_1"), "/v1/machines/mch_1/connect");
    }
}
