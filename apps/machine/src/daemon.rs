//! The daemon: one process on a machine. It enrols the machine with an engine once, and from
//! then on keeps one connection open to it, opened from here. The engine never connects to a
//! machine.
//!
//! The connection is not what holds anything together. Commands run without it, their endings
//! are kept on disk until the engine has them, and a connection that is lost, by a network, by
//! a sleep or by either side restarting, is opened again, with what happened meanwhile said
//! first.
//!
//! Its folder:
//!
//! ```text
//! machine.json   the engine's address and this machine's ID
//! key            the machine's private key. Never sent anywhere
//! lock           the process ID of the daemon that runs on this folder
//! tasks/         the commands: see `commands.rs`
//! ```

use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tungstenite::http::Uri;
use tungstenite::{Message, WebSocket};

use crate::commands::{self, Commands};
use crate::environment::{self, Environment};
use crate::files;
use crate::identity::Enrolled;
use crate::protocol::{
    ErrorCode, FromDaemon, FromEngine, ReadParams, Ref, Refused, ResponseError, RunParams,
    StoppedBy, UpdateParams, WriteParams, connect_path,
};
use crate::{sys, update};

pub struct Times {
    /// How long a command that was asked to end has before it is killed.
    pub stop_grace_ms: u64,
    /// How often the commands that run are looked at.
    pub poll_ms: u64,
    /// How often the engine is pinged.
    pub ping_ms: u64,
    /// A connection the engine has said nothing on for this long is given up.
    pub silence_ms: u64,
    /// The wait before connecting again: the first, doubled after each failure up to the last.
    pub reconnect_ms: (u64, u64),
    /// How long a command's folder is kept after its ending was acknowledged.
    pub keep_ms: u64,
    /// How long the user's shell has to say what its environment is, when the daemon starts.
    pub environment_ms: u64,
}

impl Default for Times {
    fn default() -> Self {
        Self {
            stop_grace_ms: 5000,
            poll_ms: 100,
            ping_ms: 15_000,
            silence_ms: 45_000,
            reconnect_ms: (1000, 30_000),
            keep_ms: 7 * 24 * 3_600_000,
            environment_ms: 10_000,
        }
    }
}

pub struct Options {
    /// The daemon's folder.
    pub dir: PathBuf,
    /// What `~` is for a command.
    pub home: PathBuf,
    /// The shell whose environment commands run in: it is asked once, when the daemon starts.
    /// None leaves commands the daemon's own environment.
    pub shell: Option<String>,
    pub times: Times,
    /// A command that writes more than this many bytes is stopped.
    pub output_limit: u64,
    /// How much of the end of its output an ending carries, in bytes.
    pub tail_bytes: u64,
}

fn log(line: &str) {
    eprintln!("{line}");
}

/// A connection to the engine, plain or over TLS.
enum Stream {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Stream {
    fn tcp(&self) -> &TcpStream {
        match self {
            Self::Plain(stream) => stream,
            Self::Tls(stream) => &stream.sock,
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.read(buffer),
            Self::Tls(stream) => stream.read(buffer),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.write(buffer),
            Self::Tls(stream) => stream.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(stream) => stream.flush(),
            Self::Tls(stream) => stream.flush(),
        }
    }
}

/// How long opening a connection may take, and one write on it.
const CONNECT: Duration = Duration::from_secs(10);
const WRITE: Duration = Duration::from_secs(30);

/// Opens the WebSocket of a machine at an engine.
fn open(server: &str, machine: &str, poll: Duration) -> Result<WebSocket<Stream>, String> {
    let uri: Uri = server
        .parse()
        .map_err(|_| format!("{server} is not an engine's address"))?;
    let secure = match uri.scheme_str() {
        Some("https") => true,
        Some("http") => false,
        _ => {
            return Err(format!(
                "{server} is not an engine's address: it starts with http:// or https://"
            ));
        }
    };
    let host = uri
        .host()
        .ok_or_else(|| format!("{server} names no host"))?
        .to_string();
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
    let failed = |error: io::Error| error.to_string();
    let address = (host.trim_matches(['[', ']']), port)
        .to_socket_addrs()
        .map_err(failed)?
        .next()
        .ok_or_else(|| format!("{host} has no address"))?;
    let tcp = TcpStream::connect_timeout(&address, CONNECT).map_err(failed)?;
    tcp.set_nodelay(true).map_err(failed)?;
    tcp.set_read_timeout(Some(CONNECT)).map_err(failed)?;
    tcp.set_write_timeout(Some(WRITE)).map_err(failed)?;

    let stream = if secure {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|_| format!("{host} is not a name a certificate can be for"))?;
        let connection = rustls::ClientConnection::new(Arc::new(config), name)
            .map_err(|error| error.to_string())?;
        Stream::Tls(Box::new(rustls::StreamOwned::new(connection, tcp)))
    } else {
        Stream::Plain(tcp)
    };
    let scheme = if secure { "wss" } else { "ws" };
    let rest = server.split_once("://").map_or(server, |(_, rest)| rest);
    let url = format!("{scheme}://{rest}{}", connect_path(machine));
    let (socket, _) =
        tungstenite::client::client(url.as_str(), stream).map_err(|error| error.to_string())?;
    // From here on a read waits no longer than until the commands are next looked at.
    socket
        .get_ref()
        .tcp()
        .set_read_timeout(Some(poll))
        .map_err(failed)?;
    Ok(socket)
}

/// One connection, from opening it to losing it.
struct Session {
    socket: WebSocket<Stream>,
    /// Whether the engine has taken this connection: commands can arrive.
    ready: bool,
    /// When the engine was last heard on it.
    heard: u64,
    pinged: u64,
}

/// What the daemon is to do once a request was answered.
#[derive(PartialEq, Eq)]
enum Next {
    GoOn,
    /// Its program was replaced: it becomes the new one.
    Restart,
}

pub struct Daemon {
    options: Options,
    enrolled: Enrolled,
    commands: Commands,
    environment: Environment,
    /// Which build this daemon is.
    build: Option<String>,
    session: Option<Session>,
}

impl Daemon {
    /// Takes the folder, asks the user's shell for its environment, and finds the commands on
    /// the folder.
    pub fn start(options: Options) -> Result<Self, String> {
        let enrolled = Enrolled::read(&options.dir).ok_or_else(|| {
            format!(
                "This machine has not enrolled: there is no {}",
                options.dir.join("machine.json").display()
            )
        })?;
        let lock = options.dir.join("lock");
        let own = std::process::id() as i32;
        let holder = fs::read_to_string(&lock)
            .ok()
            .and_then(|text| text.trim().parse::<i32>().ok());
        if let Some(holder) =
            holder.filter(|&holder| holder > 0 && holder != own && sys::alive(holder))
        {
            return Err(format!(
                "A daemon runs on this folder already, as process {holder}"
            ));
        }
        fs::write(&lock, own.to_string()).map_err(|error| error.to_string())?;

        let mut environment = environment::own();
        if let Some(shell) = &options.shell {
            let asked = sys::now_ms();
            let timeout = Duration::from_millis(options.times.environment_ms);
            match environment::capture(shell, &options.home, timeout) {
                Ok(read) => {
                    environment = read;
                    log(&format!(
                        "environment read from {shell} in {} ms",
                        sys::now_ms() - asked
                    ));
                }
                Err(why) => log(&format!(
                    "the environment could not be read from {shell}: {why}. Commands run in the daemon's own"
                )),
            }
        }
        let commands = Commands::open(commands::Options {
            dir: options.dir.join("tasks"),
            home: options.home.clone(),
            stop_grace_ms: options.times.stop_grace_ms,
            output_limit: options.output_limit,
            tail_bytes: options.tail_bytes,
            keep_ms: options.times.keep_ms,
        })
        .map_err(|error| error.to_string())?;
        Ok(Self {
            options,
            enrolled,
            commands,
            environment,
            build: update::own_build(),
            session: None,
        })
    }

    /// Connects, again and again, until the daemon is asked to end. The commands that run are
    /// left running. True when its program was replaced, and it is to become the new one.
    pub fn run(&mut self) -> bool {
        let (first, last) = self.options.times.reconnect_ms;
        let poll = Duration::from_millis(self.options.times.poll_ms);
        let mut wait = first;
        let mut connect_at = 0u64;
        let mut restart = false;
        while !sys::stopped() && !restart {
            // What ended is stored, whether there is a connection to say it on or not.
            for ended in self.commands.tick() {
                if let Some(session) = self.session.as_mut().filter(|session| session.ready) {
                    let _ = send(&mut session.socket, &FromDaemon::Ended(&ended));
                }
            }
            if self.session.is_none() {
                if sys::now_ms() < connect_at {
                    std::thread::sleep(poll);
                    continue;
                }
                let identity = &self.enrolled.identity;
                match open(&identity.server, &identity.id, poll) {
                    Ok(socket) => {
                        self.session = Some(Session {
                            socket,
                            ready: false,
                            heard: sys::now_ms(),
                            pinged: 0,
                        });
                    }
                    Err(why) => {
                        log(&format!("connection failed: {why}"));
                        connect_at = sys::now_ms() + wait;
                        wait = (wait * 2).min(last);
                    }
                }
                continue;
            }
            match self.pump() {
                Ok(Next::GoOn) => {}
                Ok(Next::Restart) => restart = true,
                Err(()) => {
                    // A connection that worked is tried again soon; one that never did, more
                    // and more slowly.
                    let was_ready = self.session.take().is_some_and(|session| session.ready);
                    if was_ready {
                        log("disconnected");
                    }
                    let delay = if was_ready { first } else { wait };
                    wait = (delay * 2).min(last);
                    connect_at = sys::now_ms() + delay;
                }
            }
        }
        if let Some(mut session) = self.session.take() {
            let _ = session.socket.close(None);
            let _ = session.socket.flush();
        }
        if !restart {
            let _ = fs::remove_file(self.options.dir.join("lock"));
        }
        restart
    }

    /// Reads what the engine has sent, answers it, and keeps the connection alive. An error
    /// when the connection is over.
    fn pump(&mut self) -> Result<Next, ()> {
        loop {
            let Some(session) = self.session.as_mut() else {
                return Err(());
            };
            let message = match session.socket.read() {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(_)) => return Err(()),
                Ok(_) => continue,
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(_) => return Err(()),
            };
            session.heard = sys::now_ms();
            // What cannot be read is passed over: an engine may say what this daemon is too
            // old to know.
            let Ok(message) = serde_json::from_str::<FromEngine>(message.as_str()) else {
                continue;
            };
            if self.handle(message)? == Next::Restart {
                return Ok(Next::Restart);
            }
        }
        let Some(session) = self.session.as_mut() else {
            return Err(());
        };
        let now = sys::now_ms();
        // The clock jumps over a sleep too, and the connection did not outlive it.
        if now.saturating_sub(session.heard) > self.options.times.silence_ms {
            log("the engine has gone silent");
            return Err(());
        }
        if session.ready && now.saturating_sub(session.pinged) >= self.options.times.ping_ms {
            session.pinged = now;
            send(&mut session.socket, &FromDaemon::Ping)?;
        }
        Ok(Next::GoOn)
    }

    fn handle(&mut self, message: FromEngine) -> Result<Next, ()> {
        let Some(session) = self.session.as_mut() else {
            return Err(());
        };
        match message {
            FromEngine::Challenge { nonce } => {
                let signature = self.enrolled.proof(&nonce);
                send(&mut session.socket, &FromDaemon::Proof { signature })?;
            }
            FromEngine::Ready => {
                session.ready = true;
                let unacked = self.commands.unacked();
                let hostname = sys::hostname();
                let home = self.options.home.to_string_lossy();
                let tasks = self.options.dir.join("tasks");
                let hello = FromDaemon::Hello {
                    os: sys::os(),
                    arch: sys::arch(),
                    home: &home,
                    hostname: &hostname,
                    version: env!("CARGO_PKG_VERSION"),
                    build: self.build.as_deref(),
                    tasks: &tasks.to_string_lossy(),
                    running: self.commands.running(),
                    ended: unacked
                        .iter()
                        .map(|ended| Ref {
                            actor: ended.actor.clone(),
                            task: ended.task.clone(),
                        })
                        .collect(),
                };
                send(&mut session.socket, &hello)?;
                // What ended while there was no connection, or was never acknowledged.
                for ended in &unacked {
                    send(&mut session.socket, &FromDaemon::Ended(ended))?;
                }
                log("connected");
            }
            FromEngine::Request { id, method, params } => {
                let answered = self.answer(&method, params);
                let Some(session) = self.session.as_mut() else {
                    return Err(());
                };
                let (result, error, next) = match &answered {
                    Ok((result, next)) => (Some(result.clone()), None, *next == Next::Restart),
                    Err(refused) => (
                        None,
                        Some(ResponseError {
                            code: refused.code,
                            message: &refused.message,
                        }),
                        false,
                    ),
                };
                send(
                    &mut session.socket,
                    &FromDaemon::Response { id, result, error },
                )?;
                if next {
                    return Ok(Next::Restart);
                }
            }
            FromEngine::Ack { actor, task } => self.commands.acked(&Ref { actor, task }),
            FromEngine::Pong => {}
        }
        Ok(Next::GoOn)
    }

    /// Does what a request asks, and gives what it is answered with.
    fn answer(&mut self, method: &str, params: Value) -> Result<(Value, Next), Refused> {
        fn read<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, Refused> {
            serde_json::from_value(params)
                .map_err(|error| Refused::new(ErrorCode::Invalid, error.to_string()))
        }
        let home: &Path = &self.options.home;
        match method {
            "run" => {
                let params: RunParams = read(params)?;
                let log = self.commands.run(&params, &self.environment)?;
                Ok((json!({ "log": log }), Next::GoOn))
            }
            "stop" => {
                let target: Ref = read(params)?;
                self.commands.stop(&target, StoppedBy::Stop)?;
                Ok((json!({}), Next::GoOn))
            }
            "read" => Ok((files::read(home, &read::<ReadParams>(params)?)?, Next::GoOn)),
            "write" => Ok((
                files::write(home, &read::<WriteParams>(params)?)?,
                Next::GoOn,
            )),
            "update" => {
                let params: UpdateParams = read(params)?;
                let updated = update::update(&self.enrolled.identity.server, &params.digest)?;
                let next = if updated { Next::Restart } else { Next::GoOn };
                Ok((json!({ "updated": updated, "build": params.digest }), next))
            }
            _ => Err(Refused::new(ErrorCode::Invalid, "There is no such method")),
        }
    }
}

/// Sends a message. An error when the connection is going: what matters is kept on disk, and
/// sent on the next one.
fn send(socket: &mut WebSocket<Stream>, message: &FromDaemon<'_>) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    socket.send(Message::text(text)).map_err(|_| ())
}
