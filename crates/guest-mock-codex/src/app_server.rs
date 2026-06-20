use crate::session;
use chrono::Utc;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use uuid::Uuid;

const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    Success,
    DisconnectAfterInitialize,
    ExitOnTurnStart,
    StaleTurn,
    NoActiveTurn,
}

impl Scenario {
    fn from_env() -> io::Result<Self> {
        match std::env::var("MOCK_CODEX_APP_SERVER_SCENARIO") {
            Ok(value) if value.is_empty() => Ok(Self::Success),
            Ok(value) => match value.as_str() {
                "disconnect-after-initialize" => Ok(Self::DisconnectAfterInitialize),
                "exit-on-turn-start" => Ok(Self::ExitOnTurnStart),
                "stale-turn" => Ok(Self::StaleTurn),
                "no-active-turn" => Ok(Self::NoActiveTurn),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unsupported MOCK_CODEX_APP_SERVER_SCENARIO={value:?}"),
                )),
            },
            Err(_) => Ok(Self::Success),
        }
    }
}

pub fn run_app_server(listen: &str) -> io::Result<()> {
    if listen != "stdio://" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "guest-mock-codex app-server only supports stdio transport, got {:?}",
                listen
            ),
        ));
    }

    let scenario = Scenario::from_env()?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut state = AppServerState::new(scenario);
    state.run(stdin.lock(), stdout.lock())
}

#[derive(Debug)]
struct AppServerState {
    initialized: bool,
    thread_id: Option<String>,
    session_artifact_thread_id: Option<String>,
    session_artifact_thread_ids: BTreeMap<String, String>,
    active_turn_id: Option<String>,
    initial_inputs: Vec<String>,
    steered_inputs: Vec<String>,
    scenario: Scenario,
}

impl AppServerState {
    fn new(scenario: Scenario) -> Self {
        Self {
            initialized: false,
            thread_id: None,
            session_artifact_thread_id: None,
            session_artifact_thread_ids: BTreeMap::new(),
            active_turn_id: None,
            initial_inputs: Vec::new(),
            steered_inputs: Vec::new(),
            scenario,
        }
    }

    fn run<R: BufRead, W: Write>(&mut self, input: R, mut output: W) -> io::Result<()> {
        for line_result in input.lines() {
            let line = line_result?;
            if line.trim().is_empty() {
                continue;
            }

            let message: Value = serde_json::from_str(&line)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            if self.handle_message(message, &mut output)? == ServerAction::Stop {
                return Ok(());
            }
        }
        Ok(())
    }

    fn handle_message<W: Write>(
        &mut self,
        message: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?;
        let params = message.get("params").unwrap_or(&Value::Null);

        if let Some(id) = message.get("id").cloned() {
            self.handle_request(id, method, params, output)
        } else {
            self.handle_notification(method);
            Ok(ServerAction::Continue)
        }
    }

    fn handle_request<W: Write>(
        &mut self,
        id: Value,
        method: &str,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        match method {
            "initialize" => {
                self.initialized = true;
                write_success(output, id, initialize_response())?;
                if self.scenario == Scenario::DisconnectAfterInitialize {
                    return Ok(ServerAction::Stop);
                }
                Ok(ServerAction::Continue)
            }
            "thread/start" => {
                if !self.initialized {
                    write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
                    return Ok(ServerAction::Continue);
                }
                let thread_id = Uuid::now_v7().to_string();
                self.set_current_thread(thread_id.clone());
                write_success(output, id, thread_response(&thread_id, false))?;
                Ok(ServerAction::Continue)
            }
            "thread/resume" => {
                if !self.initialized {
                    write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
                    return Ok(ServerAction::Continue);
                }
                let Some(thread_id) = non_empty_string_param(params, "threadId") else {
                    write_error(output, id, INVALID_REQUEST, "missing threadId")?;
                    return Ok(ServerAction::Continue);
                };
                self.set_current_thread(thread_id.to_string());
                write_success(output, id, thread_response(thread_id, true))?;
                Ok(ServerAction::Continue)
            }
            "turn/start" => {
                if self.scenario == Scenario::ExitOnTurnStart {
                    return Ok(ServerAction::Stop);
                }

                let (thread_id, artifact_thread_id) =
                    match self.current_thread(string_param(params, "threadId")) {
                        Ok((thread_id, artifact_thread_id)) => {
                            (thread_id.to_string(), artifact_thread_id.to_string())
                        }
                        Err(message) => {
                            write_error(output, id, INVALID_REQUEST, message)?;
                            return Ok(ServerAction::Continue);
                        }
                    };
                let inputs = match text_inputs(params) {
                    Ok(inputs) => inputs,
                    Err(message) => {
                        write_error(output, id, INVALID_REQUEST, &message)?;
                        return Ok(ServerAction::Continue);
                    }
                };

                let turn_id = Uuid::now_v7().to_string();
                if self.scenario != Scenario::NoActiveTurn {
                    self.active_turn_id = Some(turn_id.clone());
                }
                self.initial_inputs.extend(inputs.iter().cloned());
                persist_input_events(
                    &artifact_thread_id,
                    &thread_id,
                    &turn_id,
                    "initial",
                    &inputs,
                )?;
                write_success(output, id, json!({ "turn": turn(&turn_id) }))?;
                Ok(ServerAction::Continue)
            }
            "turn/steer" => {
                let Some(active_turn_id) = self.active_turn_id.clone() else {
                    write_error(output, id, INVALID_REQUEST, "no active turn")?;
                    return Ok(ServerAction::Continue);
                };
                let Some(expected_turn_id) = string_param(params, "expectedTurnId") else {
                    write_error(output, id, INVALID_REQUEST, "missing expectedTurnId")?;
                    return Ok(ServerAction::Continue);
                };
                if self.scenario == Scenario::StaleTurn || expected_turn_id != active_turn_id {
                    write_error(output, id, INVALID_REQUEST, "stale expectedTurnId")?;
                    return Ok(ServerAction::Continue);
                }

                let (thread_id, artifact_thread_id) =
                    match self.current_thread(string_param(params, "threadId")) {
                        Ok((thread_id, artifact_thread_id)) => {
                            (thread_id.to_string(), artifact_thread_id.to_string())
                        }
                        Err(message) => {
                            write_error(output, id, INVALID_REQUEST, message)?;
                            return Ok(ServerAction::Continue);
                        }
                    };
                let inputs = match text_inputs(params) {
                    Ok(inputs) => inputs,
                    Err(message) => {
                        write_error(output, id, INVALID_REQUEST, &message)?;
                        return Ok(ServerAction::Continue);
                    }
                };
                self.steered_inputs.extend(inputs.iter().cloned());
                persist_input_events(
                    &artifact_thread_id,
                    &thread_id,
                    &active_turn_id,
                    "steered",
                    &inputs,
                )?;
                write_success(output, id, json!({ "turnId": active_turn_id }))?;
                Ok(ServerAction::Continue)
            }
            "mock/inputs" => {
                write_success(
                    output,
                    id,
                    json!({
                        "initial": &self.initial_inputs,
                        "steered": &self.steered_inputs,
                    }),
                )?;
                Ok(ServerAction::Continue)
            }
            _ => {
                write_error(output, id, METHOD_NOT_FOUND, "unsupported method")?;
                Ok(ServerAction::Continue)
            }
        }
    }

    fn handle_notification(&mut self, _method: &str) {
        // The client sends `initialized` after the `initialize` request. It
        // must not substitute for the request itself because later requests
        // need initialize response state to exist.
    }

    fn set_current_thread(&mut self, thread_id: String) {
        let artifact_thread_id = self
            .session_artifact_thread_ids
            .entry(thread_id.clone())
            .or_insert_with(|| session_artifact_thread_id(&thread_id))
            .clone();
        self.session_artifact_thread_id = Some(artifact_thread_id);
        self.thread_id = Some(thread_id);
        self.active_turn_id = None;
    }

    fn current_thread(&self, requested_thread_id: Option<&str>) -> Result<(&str, &str), &str> {
        let Some(thread_id) = self.thread_id.as_deref() else {
            return Err("no active thread");
        };
        if let Some(requested_thread_id) = requested_thread_id
            && requested_thread_id != thread_id
        {
            return Err("unknown threadId");
        }
        let Some(artifact_thread_id) = self.session_artifact_thread_id.as_deref() else {
            return Err("missing session artifact thread id");
        };
        Ok((thread_id, artifact_thread_id))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServerAction {
    Continue,
    Stop,
}

fn initialize_response() -> Value {
    json!({
        "userAgent": format!("guest-mock-codex-app-server/{}", env!("CARGO_PKG_VERSION")),
        "codexHome": session::codex_home(),
        "platformFamily": std::env::consts::FAMILY,
        "platformOs": std::env::consts::OS,
    })
}

fn thread_response(thread_id: &str, resume: bool) -> Value {
    let mut response = json!({
        "thread": thread(thread_id),
        "model": "gpt-5",
        "modelProvider": "openai",
        "serviceTier": null,
        "cwd": "/tmp",
        "runtimeWorkspaceRoots": [],
        "instructionSources": [],
        "approvalPolicy": "on-failure",
        "approvalsReviewer": "user",
        "sandbox": {
            "type": "dangerFullAccess"
        },
        "activePermissionProfile": null,
        "reasoningEffort": null,
        "multiAgentMode": null
    });
    if resume && let Value::Object(fields) = &mut response {
        fields.insert("initialTurnsPage".to_string(), Value::Null);
    }
    response
}

fn thread(thread_id: &str) -> Value {
    json!({
        "id": thread_id,
        "sessionId": thread_id,
        "forkedFromId": null,
        "parentThreadId": null,
        "preview": "guest-mock-codex app-server thread",
        "ephemeral": false,
        "modelProvider": "openai",
        "createdAt": 1,
        "updatedAt": 1,
        "recencyAt": 1,
        "status": {
            "type": "idle"
        },
        "path": null,
        "cwd": "/tmp",
        "cliVersion": "guest-mock-codex",
        "source": "appServer",
        "threadSource": null,
        "agentNickname": null,
        "agentRole": null,
        "gitInfo": null,
        "name": null,
        "turns": []
    })
}

fn turn(turn_id: &str) -> Value {
    json!({
        "id": turn_id,
        "items": [],
        "itemsView": "full",
        "status": "inProgress",
        "error": null,
        "startedAt": 1,
        "completedAt": null,
        "durationMs": null
    })
}

fn string_param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params.get(name).and_then(Value::as_str)
}

fn non_empty_string_param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    string_param(params, name).filter(|value| !value.is_empty())
}

fn text_inputs(params: &Value) -> Result<Vec<String>, String> {
    let Some(values) = params.get("input").and_then(Value::as_array) else {
        return Err("missing input".to_string());
    };
    if values.is_empty() {
        return Err("input must not be empty".to_string());
    }

    let mut inputs = Vec::with_capacity(values.len());
    for value in values {
        let input_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if input_type != "text" {
            return Err(format!("unsupported input type {input_type:?}"));
        }
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            return Err("text input is missing text".to_string());
        };
        if text.is_empty() {
            return Err("text input must not be empty".to_string());
        }
        inputs.push(text.to_string());
    }
    Ok(inputs)
}

fn persist_input_events(
    artifact_thread_id: &str,
    thread_id: &str,
    turn_id: &str,
    kind: &str,
    inputs: &[String],
) -> io::Result<()> {
    let events = inputs
        .iter()
        .map(|text| {
            json!({
                "type": "mock.app_server.input",
                "kind": kind,
                "thread_id": thread_id,
                "turn_id": turn_id,
                "text": text
            })
        })
        .collect::<Vec<_>>();
    let home = session::codex_home();
    session::persist_resume_session(&home, Utc::now().date_naive(), artifact_thread_id, &events)
}

fn session_artifact_thread_id(thread_id: &str) -> String {
    match Uuid::parse_str(thread_id) {
        Ok(uuid) if uuid.to_string() == thread_id => thread_id.to_string(),
        _ => Uuid::now_v7().to_string(),
    }
}

fn write_success<W: Write>(output: &mut W, id: Value, result: Value) -> io::Result<()> {
    write_json_line(output, &json!({ "id": id, "result": result }))
}

fn write_error<W: Write>(output: &mut W, id: Value, code: i64, message: &str) -> io::Result<()> {
    write_json_line(
        output,
        &json!({
            "id": id,
            "error": {
                "code": code,
                "message": message
            }
        }),
    )
}

fn write_json_line<W: Write>(output: &mut W, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value).map_err(io::Error::other)?;
    writeln!(output)?;
    output.flush()
}
