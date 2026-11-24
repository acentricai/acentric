//! The daemon as it runs: its own program, started as a person starts it, against an engine
//! that is a stand-in. The stand-in speaks what an engine speaks, and nothing else of one.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tungstenite::{Message, WebSocket};

const PROGRAM: &str = env!("CARGO_BIN_EXE_acentric-machine");
const TOKEN: &str = "the-token-the-engine-gave";

/// What an engine knows of the one machine of these tests.
#[derive(Default)]
struct Known {
    /// The public key the machine enrolled with.
    public_key: Option<VerifyingKey>,
    /// What the engine hands out as the daemon for this machine.
    program: Vec<u8>,
}

/// An engine, as far as a daemon can tell. It answers what is asked of it over HTTP by
/// itself, and hands each daemon that connects to the test.
struct Engine {
    url: String,
    known: Arc<Mutex<Known>>,
    connections: Receiver<TcpStream>,
    request: u64,
}

/// A request as it came: its first line, and its body.
fn read_http(stream: &mut TcpStream) -> (String, Vec<u8>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read_exact(&mut byte).is_err() {
            break;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse().ok())
        })
        .unwrap_or(0usize);
    let mut body = vec![0u8; length];
    let _ = stream.read_exact(&mut body);
    (head.lines().next().unwrap_or_default().to_string(), body)
}

fn answer_http(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

impl Engine {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let known = Arc::new(Mutex::new(Known::default()));
        let (connected, connections) = mpsc::channel();
        let shared = Arc::clone(&known);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
                let mut start = [0u8; 64];
                let peeked = stream.peek(&mut start).unwrap_or(0);
                // A daemon's WebSocket is the test's to take.
                if String::from_utf8_lossy(&start[..peeked]).contains("/connect") {
                    if connected.send(stream).is_err() {
                        return;
                    }
                    continue;
                }
                let (line, body) = read_http(&mut stream);
                if line.starts_with("POST /v1/machines/mch_1/enrol") {
                    let given: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    if given["token"] != TOKEN {
                        let refused = json!({ "error": { "code": "forbidden", "message": "The token is not one this machine was given" } });
                        answer_http(
                            &mut stream,
                            "403 Forbidden",
                            "application/json",
                            refused.to_string().as_bytes(),
                        );
                        continue;
                    }
                    let der = STANDARD
                        .decode(given["publicKey"].as_str().unwrap_or_default())
                        .unwrap_or_default();
                    let key = der
                        .get(12..)
                        .and_then(|key| key.try_into().ok())
                        .and_then(|key| VerifyingKey::from_bytes(key).ok());
                    shared.lock().unwrap().public_key = key;
                    answer_http(&mut stream, "200 OK", "application/json", b"{}");
                } else if line.starts_with("GET /machine/") {
                    let program = shared.lock().unwrap().program.clone();
                    answer_http(&mut stream, "200 OK", "application/octet-stream", &program);
                } else {
                    answer_http(&mut stream, "404 Not Found", "application/json", b"{}");
                }
            }
        });
        Self {
            url,
            known,
            connections,
            request: 0,
        }
    }

    fn public_key(&self) -> Option<VerifyingKey> {
        self.known.lock().unwrap().public_key
    }

    fn hand_out(&self, program: &[u8]) {
        self.known.lock().unwrap().program = program.to_vec();
    }

    /// Takes a daemon's connection as an engine does: it proves itself, and says what it is.
    fn connected(&mut self) -> (WebSocket<TcpStream>, Value) {
        let stream = self
            .connections
            .recv_timeout(Duration::from_secs(20))
            .expect("the daemon never connected");
        let mut socket = tungstenite::accept(stream).unwrap();
        send(
            &mut socket,
            &json!({ "type": "challenge", "nonce": "a-nonce-of-this-connection" }),
        );
        let proof = next(&mut socket, "proof");
        let signature = STANDARD
            .decode(proof["signature"].as_str().unwrap())
            .unwrap();
        let signature = Signature::from_slice(&signature).unwrap();
        let key = self.public_key().expect("the machine never enrolled");
        key.verify(b"machine mch_1\na-nonce-of-this-connection", &signature)
            .expect("the proof is not the machine's");
        send(&mut socket, &json!({ "type": "ready" }));
        let hello = next(&mut socket, "hello");
        (socket, hello)
    }

    /// Asks the daemon something, and gives what it answered.
    fn ask(&mut self, socket: &mut WebSocket<TcpStream>, method: &str, params: Value) -> Value {
        self.request += 1;
        let id = self.request;
        send(
            socket,
            &json!({ "type": "request", "id": id, "method": method, "params": params }),
        );
        loop {
            let response = next(socket, "response");
            if response["id"] == id {
                return response;
            }
        }
    }
}

fn send(socket: &mut WebSocket<TcpStream>, message: &Value) {
    socket.send(Message::text(message.to_string())).unwrap();
}

/// The next message of a type the daemon sends. Pings are answered on the way, and anything
/// else that comes first is passed over.
fn next(socket: &mut WebSocket<TcpStream>, kind: &str) -> Value {
    loop {
        let Message::Text(text) = socket
            .read()
            .unwrap_or_else(|error| panic!("no {kind} came: {error}"))
        else {
            continue;
        };
        let message: Value = serde_json::from_str(text.as_str()).unwrap();
        if message["type"] == "ping" {
            send(socket, &json!({ "type": "pong" }));
        }
        if message["type"] == kind {
            return message;
        }
    }
}

/// A machine: a folder for the daemon, and a home of its own.
struct Machine {
    root: PathBuf,
    /// How long the daemon takes an engine that says nothing to be there.
    silence_ms: u64,
}

impl Machine {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("acentric-daemon-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home/work")).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
            silence_ms: 10_000,
        }
    }

    fn dir(&self) -> PathBuf {
        self.root.join("daemon")
    }

    fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    fn command(&self, program: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command
            .args(args)
            .env("MACHINE_DIR", self.dir())
            .env("HOME", self.home())
            .env("MACHINE_SHELL", "none")
            .env("MACHINE_PING_MS", "100")
            .env("MACHINE_RECONNECT_MS", "50")
            .env("MACHINE_SILENCE_MS", self.silence_ms.to_string())
            .env("MACHINE_STOP_GRACE_MS", "300")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn enrol(&self, engine: &Engine, token: &str) -> Output {
        self.command(
            Path::new(PROGRAM),
            &[
                "enrol",
                "--server",
                &engine.url,
                "--id",
                "mch_1",
                "--token",
                token,
            ],
        )
        .output()
        .unwrap()
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A daemon that is ended when the test is over, however it ends.
struct Running(Child);

impl Running {
    fn stop(&mut self) -> Option<i32> {
        // SAFETY: the process is this test's own child.
        unsafe {
            libc::kill(self.0.id() as i32, libc::SIGTERM);
        }
        self.0.wait().unwrap().code()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("it never happened: {what}");
}

#[test]
fn a_machine_enrols_once_with_a_token_and_keeps_its_key_to_itself() {
    let machine = Machine::new("enrol");
    let engine = Engine::start();
    let refused = machine.enrol(&engine, "not-the-token");
    assert_eq!(refused.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&refused.stderr).trim(),
        "acentric-machine: The engine refused to enrol this machine: The token is not one this machine was given"
    );
    assert!(!machine.dir().join("machine.json").exists());
    // Not enrolled, it has nothing to connect as.
    let early = machine
        .command(Path::new(PROGRAM), &["connect"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&early.stderr).contains("This machine has not enrolled"));

    let enrolled = machine.enrol(&engine, TOKEN);
    assert_eq!(
        enrolled.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&enrolled.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&enrolled.stdout).trim(),
        "enrolled as mch_1"
    );
    let identity: Value =
        serde_json::from_slice(&std::fs::read(machine.dir().join("machine.json")).unwrap())
            .unwrap();
    assert_eq!(identity, json!({ "server": engine.url, "id": "mch_1" }));
    // Its key is its owner's alone, and the engine has only the half that is no secret.
    let key = std::fs::metadata(machine.dir().join("key")).unwrap();
    assert_eq!(key.permissions().mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::metadata(machine.dir())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(engine.public_key().is_some());
}

#[test]
fn a_daemon_proves_itself_runs_what_it_is_asked_and_says_how_each_ended() {
    let machine = Machine::new("session");
    let mut engine = Engine::start();
    assert!(machine.enrol(&engine, TOKEN).status.success());
    let mut daemon = Running(
        machine
            .command(Path::new(PROGRAM), &["connect"])
            .spawn()
            .unwrap(),
    );
    let (mut socket, hello) = engine.connected();

    let program = std::fs::read(PROGRAM).unwrap();
    let build: String = Sha256::digest(&program)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(hello["home"], machine.home().to_string_lossy().as_ref());
    assert_eq!(
        hello["tasks"],
        machine.dir().join("tasks").to_string_lossy().as_ref()
    );
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(hello["build"], build);
    assert!(["darwin", "linux"].contains(&hello["os"].as_str().unwrap()));
    assert!(["arm64", "x64"].contains(&hello["arch"].as_str().unwrap()));
    assert_eq!(
        (hello["running"].clone(), hello["ended"].clone()),
        (json!([]), json!([]))
    );
    // Another daemon on the same folder is refused, by the one that runs there.
    let second = machine
        .command(Path::new(PROGRAM), &["connect"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&second.stderr).contains("A daemon runs on this folder already")
    );

    // A command: answered as soon as it has started, and its ending follows.
    let run = json!({ "actor": "act_1", "task": "b1", "command": "echo hi; echo \"$GREETING\"; exit 4", "cwd": "~/work", "env": { "GREETING": "from the actor" } });
    let started = engine.ask(&mut socket, "run", run.clone());
    let log = machine.dir().join("tasks/act_1/b1/output.log");
    assert_eq!(started["result"], json!({ "log": log.to_string_lossy() }));
    let ended = next(&mut socket, "ended");
    assert_eq!(
        (
            ended["actor"].as_str(),
            ended["task"].as_str(),
            ended["status"].as_str(),
            ended["exit"].as_i64()
        ),
        (Some("act_1"), Some("b1"), Some("exited"), Some(4))
    );
    assert_eq!(
        (
            ended["tail"].as_str(),
            ended["bytes"].as_u64(),
            ended["lines"].as_u64()
        ),
        (Some("hi\nfrom the actor\n"), Some(18), Some(2))
    );
    assert!(ended.get("by").is_none());
    send(
        &mut socket,
        &json!({ "type": "ack", "actor": "act_1", "task": "b1" }),
    );

    // `show` is the daemon's own, on the command's PATH: the images come with the ending.
    let show = json!({ "actor": "act_1", "task": "b9", "command": "printf 'GIF89a..' > shot.gif && show shot.gif && echo shown; show notes.txt; printf text > notes.txt; show notes.txt", "cwd": "~/work" });
    engine.ask(&mut socket, "run", show);
    let ended = next(&mut socket, "ended");
    let kept = machine.dir().join("tasks/act_1/b9/images/1");
    assert_eq!(
        ended["images"],
        json!([{ "path": kept.to_string_lossy(), "name": "shot.gif" }])
    );
    assert_eq!(std::fs::read(&kept).unwrap(), b"GIF89a..");
    assert_eq!(
        ended["tail"].as_str(),
        Some(
            "shown\nshow: there is no file notes.txt\nshow: notes.txt is not a png, jpeg, gif or webp image\n"
        )
    );
    assert_eq!(ended["exit"].as_i64(), Some(1));
    send(
        &mut socket,
        &json!({ "type": "ack", "actor": "act_1", "task": "b9" }),
    );

    // A command that is stopped says that it was, and what it had written.
    engine.ask(
        &mut socket,
        "run",
        json!({ "actor": "act_1", "task": "b2", "command": "echo started; sleep 30", "cwd": "~" }),
    );
    eventually("b2 wrote", || {
        std::fs::read_to_string(machine.dir().join("tasks/act_1/b2/output.log"))
            .is_ok_and(|text| text == "started\n")
    });
    assert_eq!(
        engine.ask(
            &mut socket,
            "stop",
            json!({ "actor": "act_1", "task": "b2" })
        )["result"],
        json!({})
    );
    let stopped = next(&mut socket, "ended");
    assert_eq!(
        (stopped["status"].as_str(), stopped["by"].as_str()),
        (Some("stopped"), Some("stop"))
    );
    // What it wrote, and on some systems a line of its bash's own.
    assert!(stopped["tail"].as_str().unwrap().starts_with("started\n"));
    send(
        &mut socket,
        &json!({ "type": "ack", "actor": "act_1", "task": "b2" }),
    );

    // Files, a part at a time.
    let written = engine.ask(
        &mut socket,
        "write",
        json!({ "path": "notes/a.txt", "cwd": "~/work", "data": STANDARD.encode("hello") }),
    );
    assert_eq!(
        written["result"],
        json!({ "path": machine.home().join("work/notes/a.txt").to_string_lossy(), "size": 5 })
    );
    let read = engine.ask(
        &mut socket,
        "read",
        json!({ "path": "~/work/notes/a.txt", "from": 1, "max": 3 }),
    );
    assert_eq!(
        read["result"],
        json!({ "size": 5, "from": 1, "data": STANDARD.encode("ell") })
    );

    // What it refuses, it refuses with why, and goes on.
    let nowhere = engine.ask(
        &mut socket,
        "run",
        json!({ "actor": "act_1", "task": "b3", "command": "true", "cwd": "~/gone" }),
    );
    assert_eq!(nowhere["error"]["code"], "bad_cwd");
    assert_eq!(
        engine.ask(&mut socket, "read", json!({ "path": "~/gone.txt" }))["error"]["code"],
        "not_found"
    );
    assert_eq!(
        engine.ask(&mut socket, "dance", json!({}))["error"],
        json!({ "code": "invalid", "message": "There is no such method" })
    );
    assert_eq!(
        engine.ask(&mut socket, "run", json!({ "actor": "act_1" }))["error"]["code"],
        "invalid"
    );
    // It pings, for as long as the engine answers.
    next(&mut socket, "ping");

    // Asked to end, it ends, and lets go of its folder.
    assert_eq!(daemon.stop(), Some(0));
    assert!(!machine.dir().join("lock").exists());
}

#[test]
fn a_connection_that_is_lost_is_opened_again_with_what_happened_meanwhile_said_first() {
    let machine = Machine::new("reconnect");
    let mut engine = Engine::start();
    assert!(machine.enrol(&engine, TOKEN).status.success());
    let mut daemon = Running(
        machine
            .command(Path::new(PROGRAM), &["connect"])
            .spawn()
            .unwrap(),
    );
    let (mut socket, _) = engine.connected();
    engine.ask(
        &mut socket,
        "run",
        json!({ "actor": "act_1", "task": "b1", "command": "echo quick", "cwd": "~" }),
    );
    engine.ask(
        &mut socket,
        "run",
        json!({ "actor": "act_1", "task": "b2", "command": "sleep 0.6; echo slow", "cwd": "~" }),
    );
    // The first ended, and the engine went away before it said that it has the ending.
    next(&mut socket, "ended");
    drop(socket);

    // The daemon comes back by itself, and says what it has.
    let (mut socket, hello) = engine.connected();
    assert_eq!(hello["ended"], json!([{ "actor": "act_1", "task": "b1" }]));
    assert_eq!(hello["running"][0]["task"], "b2");
    let again = next(&mut socket, "ended");
    assert_eq!(
        (again["task"].as_str(), again["tail"].as_str()),
        (Some("b1"), Some("quick\n"))
    );
    send(
        &mut socket,
        &json!({ "type": "ack", "actor": "act_1", "task": "b1" }),
    );
    // What ran on through the break is told when it ends.
    let slow = next(&mut socket, "ended");
    assert_eq!(
        (
            slow["task"].as_str(),
            slow["status"].as_str(),
            slow["tail"].as_str()
        ),
        (Some("b2"), Some("exited"), Some("slow\n"))
    );
    send(
        &mut socket,
        &json!({ "type": "ack", "actor": "act_1", "task": "b2" }),
    );
    eventually("b2 was acknowledged", || {
        machine.dir().join("tasks/act_1/b2/acked").exists()
    });

    // A command outlives the daemon that started it, and the next daemon tells how it ended.
    engine.ask(&mut socket, "run", json!({ "actor": "act_1", "task": "b3", "command": "sleep 0.5; echo outlived", "cwd": "~" }));
    assert_eq!(daemon.stop(), Some(0));
    std::thread::sleep(Duration::from_millis(700));
    let _daemon = Running(
        machine
            .command(Path::new(PROGRAM), &["connect"])
            .spawn()
            .unwrap(),
    );
    let (mut socket, hello) = engine.connected();
    assert_eq!(hello["ended"], json!([{ "actor": "act_1", "task": "b3" }]));
    let outlived = next(&mut socket, "ended");
    assert_eq!(
        (
            outlived["status"].as_str(),
            outlived["exit"].as_i64(),
            outlived["tail"].as_str()
        ),
        (Some("exited"), Some(0), Some("outlived\n"))
    );
}

#[test]
fn an_engine_that_goes_silent_is_given_up_and_another_connection_is_opened() {
    let mut machine = Machine::new("silence");
    machine.silence_ms = 300;
    let mut engine = Engine::start();
    assert!(machine.enrol(&engine, TOKEN).status.success());
    let _daemon = Running(
        machine
            .command(Path::new(PROGRAM), &["connect"])
            .spawn()
            .unwrap(),
    );
    // The engine takes the connection, and then says nothing more on it: no ping is answered.
    let (silent, _) = engine.connected();
    let began = Instant::now();
    let (_socket, hello) = engine.connected();
    assert!(
        began.elapsed() >= Duration::from_millis(250),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(hello["running"], json!([]));
    drop(silent);
}

#[test]
fn a_daemon_takes_the_engines_build_when_asked_and_becomes_it() {
    let machine = Machine::new("update");
    let mut engine = Engine::start();
    assert!(machine.enrol(&engine, TOKEN).status.success());
    // Its own copy of the program: an update replaces the file it runs from.
    let own = machine.root.join("bin/acentric-machine");
    std::fs::create_dir_all(own.parent().unwrap()).unwrap();
    std::fs::copy(PROGRAM, &own).unwrap();
    let mut daemon = Running(machine.command(&own, &["connect"]).spawn().unwrap());
    let pid = daemon.0.id();
    let (mut socket, _) = engine.connected();
    engine.ask(
        &mut socket,
        "run",
        json!({ "actor": "act_1", "task": "b1", "command": "sleep 1; echo went on", "cwd": "~" }),
    );

    // What it is said to be handed out, and is not, changes nothing.
    engine.hand_out(b"#!/bin/sh\nexit 0\n");
    let wrong = engine.ask(&mut socket, "update", json!({ "digest": "0".repeat(64) }));
    assert_eq!(wrong["error"]["code"], "failed");
    assert!(
        wrong["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not what it said")
    );
    assert_eq!(
        std::fs::read(&own).unwrap(),
        std::fs::read(PROGRAM).unwrap()
    );

    // The engine's build: a program that says what it was started with, and ends.
    let became = machine.root.join("became");
    let program = format!(
        "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\necho \"$$ $*\" > '{}'\n",
        became.display()
    )
    .into_bytes();
    engine.hand_out(&program);
    let digest: String = Sha256::digest(&program)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let updated = engine.ask(&mut socket, "update", json!({ "digest": digest }));
    assert_eq!(
        updated["result"],
        json!({ "updated": true, "build": digest })
    );
    // It became the new program, as the same process, started as the old one was.
    eventually("the new program ran", || became.exists());
    assert_eq!(
        std::fs::read_to_string(&became).unwrap().trim(),
        format!("{pid} connect")
    );
    assert_eq!(std::fs::read(&own).unwrap(), program);
    let _ = daemon.0.wait();

    // The command that ran is not the daemon's to take with it.
    let log = machine.dir().join("tasks/act_1/b1/output.log");
    eventually("the command went on", || {
        std::fs::read_to_string(&log).is_ok_and(|text| text == "went on\n")
    });
}
