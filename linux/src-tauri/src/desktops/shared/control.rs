//! Explicit commands for user-configured compositor bindings on the current session bus.
//! No service activation, transcript access, desktop configuration edits, or input injection.
use crate::{Runtime, WorkerCommand};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, Mutex};
use zbus::{message::Header, Connection};

const NAME: &str = "io.github.whisperfree.Control";
const PATH: &str = "/io/github/whisperfree/Control";
const INTERFACE: &str = "io.github.whisperfree.Control1";
const BUSY: &str =
    "OpenWhisper is busy. Wait for transcription, updating, or trigger setup to finish.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Start,
    Stop,
    Toggle,
    Cancel,
}

impl Action {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "start" => Some(Self::Start),
            "stop" => Some(Self::Stop),
            "toggle" => Some(Self::Toggle),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

pub struct Request {
    pub action: Action,
    pub expires: Instant,
    pub reply: oneshot::Sender<Result<String, String>>,
}

impl Request {
    pub fn active(&self, closing: bool) -> bool {
        !closing && !self.reply.is_closed() && Instant::now() <= self.expires
    }
}

#[derive(Default)]
pub struct Service {
    connection: Mutex<Option<Connection>>,
    closing: AtomicBool,
}

impl Service {
    pub fn closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }
}

struct Control {
    runtime: Weak<Runtime>,
    operation: Mutex<()>,
}

async fn authorize(connection: &Connection, header: &Header<'_>) -> zbus::fdo::Result<()> {
    let sender = header
        .sender()
        .ok_or_else(|| zbus::fdo::Error::AccessDenied("Missing caller identity".into()))?;
    let bus = zbus::fdo::DBusProxy::new(connection).await?;
    let uid = tokio::time::timeout(
        Duration::from_secs(1),
        bus.get_connection_unix_user(sender.clone().into()),
    )
    .await
    .map_err(|_| zbus::fdo::Error::AccessDenied("Caller verification timed out".into()))??;
    if uid != rustix::process::getuid().as_raw() {
        return Err(zbus::fdo::Error::AccessDenied(
            "Control requires the same session user".into(),
        ));
    }
    Ok(())
}

impl Control {
    fn runtime(&self) -> zbus::fdo::Result<Arc<Runtime>> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| zbus::fdo::Error::Failed("OpenWhisper is closing".into()))?;
        if runtime.control.closing() {
            return Err(zbus::fdo::Error::Failed("OpenWhisper is closing".into()));
        }
        Ok(runtime)
    }
}

#[zbus::interface(name = "io.github.whisperfree.Control1")]
impl Control {
    async fn status(
        &self,
        #[zbus(connection)] connection: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<String> {
        authorize(connection, &header).await?;
        let runtime = self.runtime()?;
        Ok(status(&runtime))
    }

    async fn execute(
        &self,
        action: &str,
        #[zbus(connection)] connection: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<String> {
        authorize(connection, &header).await?;
        let action = Action::parse(action).ok_or_else(|| {
            zbus::fdo::Error::InvalidArgs("Expected start, stop, toggle, or cancel".into())
        })?;
        // Bound the queue to one control request and reject repeats during inference.
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| zbus::fdo::Error::Failed(BUSY.into()))?;
        let runtime = self.runtime()?;
        {
            let state = runtime.state.lock().unwrap();
            if state.status == "transcribing"
                || state.updates.installing()
                || state.recording_shortcut
            {
                return Err(zbus::fdo::Error::Failed(BUSY.into()));
            }
        }
        let (reply, response) = oneshot::channel();
        runtime
            .commands
            .send(WorkerCommand::Control(Request {
                action,
                expires: Instant::now() + Duration::from_secs(2),
                reply,
            }))
            .map_err(|_| zbus::fdo::Error::Failed("Speech worker stopped".into()))?;
        tokio::time::timeout(Duration::from_secs(3), response)
            .await
            .map_err(|_| zbus::fdo::Error::Failed("Control request timed out".into()))?
            .map_err(|_| zbus::fdo::Error::Failed("Speech worker stopped".into()))?
            .map_err(zbus::fdo::Error::Failed)
    }
}

pub fn status(runtime: &Runtime) -> String {
    let state = runtime.state.lock().unwrap();
    serde_json::json!({"status": state.status, "elapsed": state.elapsed,
        "recovery_available": state.recovery_available})
    .to_string()
}

pub async fn start(runtime: Arc<Runtime>) {
    let connection = zbus::connection::Builder::session()
        .and_then(|builder| builder.name(NAME))
        .and_then(|builder| {
            builder.serve_at(
                PATH,
                Control {
                    runtime: Arc::downgrade(&runtime),
                    operation: Mutex::new(()),
                },
            )
        });
    let result = match connection {
        Ok(builder) => tokio::time::timeout(Duration::from_secs(3), builder.build())
            .await
            .map_err(|_| "timeout".to_owned())
            .and_then(|result| result.map_err(|_| "unavailable".to_owned())),
        Err(_) => Err("unavailable".into()),
    };
    match result {
        Ok(connection) => {
            let mut holder = runtime.control.connection.lock().await;
            if !runtime.control.closing.load(Ordering::Acquire) {
                *holder = Some(connection);
            }
        }
        Err(_) => eprintln!("Compositor command control unavailable on this session bus"),
    }
}

pub async fn shutdown(runtime: &Runtime) {
    runtime.control.closing.store(true, Ordering::Release);
    if let Some(connection) = runtime.control.connection.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(2), connection.close()).await;
    }
}

fn parse_cli(arguments: &[String]) -> Result<Option<&str>, String> {
    if !arguments
        .iter()
        .skip(1)
        .any(|argument| argument == "--control")
    {
        return Ok(None);
    }
    if arguments.len() != 3
        || arguments[1] != "--control"
        || !(arguments[2] == "status" || Action::parse(&arguments[2]).is_some())
    {
        return Err("Usage: openwhisper-desktop --control start|stop|toggle|cancel|status".into());
    }
    Ok(Some(&arguments[2]))
}

pub fn cli(arguments: &[String]) -> Option<i32> {
    let action = match parse_cli(arguments) {
        Ok(None) => return None,
        Ok(Some(action)) => action,
        Err(error) => {
            eprintln!("{error}");
            return Some(2);
        }
    };
    let result = tokio::runtime::Runtime::new()
        .map_err(|_| "Could not create control client".to_owned())
        .and_then(|runtime| {
            runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(5), client(action))
                    .await
                    .map_err(|_| "Control request timed out".to_owned())?
            })
        });
    match result {
        Ok(response) => {
            println!("{response}");
            Some(0)
        }
        Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

async fn client(action: &str) -> Result<String, String> {
    let connection = Connection::session().await.map_err(|_| {
        "No session bus. Open OpenWhisper in this desktop session first.".to_owned()
    })?;
    let bus = zbus::fdo::DBusProxy::new(&connection)
        .await
        .map_err(|_| "Session bus unavailable".to_owned())?;
    // Resolve and pin the existing owner. Never activate a service or launch the GUI.
    let owner = bus
        .get_name_owner(NAME.try_into().unwrap())
        .await
        .map_err(|_| {
            "OpenWhisper is not running in this session. Open the app first.".to_owned()
        })?;
    let uid = bus
        .get_connection_unix_user((&owner).into())
        .await
        .map_err(|_| "Could not verify OpenWhisper owner".to_owned())?;
    if uid != rustix::process::getuid().as_raw() {
        return Err("OpenWhisper belongs to a different user".into());
    }
    let proxy = zbus::Proxy::new(&connection, owner, PATH, INTERFACE)
        .await
        .map_err(|_| "Control interface unavailable".to_owned())?;
    let response: Option<String> = if action == "status" {
        proxy
            .call_with_flags("Status", zbus::proxy::MethodFlags::NoAutoStart.into(), &())
            .await
    } else {
        proxy
            .call_with_flags(
                "Execute",
                zbus::proxy::MethodFlags::NoAutoStart.into(),
                &(action,),
            )
            .await
    }
    .map_err(|error| error.to_string())?;
    response.ok_or_else(|| "Missing control response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }
    #[test]
    fn control_cli_rejects_ambiguous_or_untrusted_commands() {
        for values in [
            vec!["app", "--control"],
            vec!["app", "--control", "retry"],
            vec!["app", "--control", "start", "stop"],
            vec!["app", "--diagnose", "--control", "start"],
            vec!["app", "--control", "start; echo unsafe"],
        ] {
            assert!(parse_cli(&args(&values)).is_err());
        }
        for action in ["start", "stop", "toggle", "cancel", "status"] {
            assert_eq!(
                parse_cli(&args(&["app", "--control", action])).unwrap(),
                Some(action)
            );
        }
        assert_eq!(parse_cli(&args(&["app", "--ui-smoke-test"])).unwrap(), None);
    }

    #[test]
    fn expired_closed_or_shutdown_requests_cannot_start_later_capture() {
        let (reply, receiver) = oneshot::channel();
        let mut request = Request {
            action: Action::Start,
            expires: Instant::now() + Duration::from_secs(2),
            reply,
        };
        assert!(request.active(false));
        assert!(!request.active(true));
        request.expires = Instant::now() - Duration::from_secs(1);
        assert!(!request.active(false));
        request.expires = Instant::now() + Duration::from_secs(2);
        drop(receiver);
        assert!(!request.active(false));
    }
}
