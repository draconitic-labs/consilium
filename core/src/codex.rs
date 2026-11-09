use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use color_eyre::eyre::{Context, Result};
use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::api::{send_stream_event, StreamEvent, StreamEventSender};
use crate::child_io::{
    drain_stderr_tail, find_program, is_canonical_session_id, read_bounded_line, user_home_dir,
    CliProvider, ManagedChild, CLI_STDOUT_LINE_LIMIT, CLI_STDOUT_TOTAL_LIMIT,
};

pub fn find_codex() -> Option<PathBuf> {
    find_program(CliProvider::Codex)
}

/// A model listed by the installed Codex CLI's own catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexModel {
    pub slug: String,
    pub display_name: String,
    pub description: Option<String>,
    pub context_window: Option<u64>,
    pub default_effort: Option<String>,
    pub efforts: Vec<CodexEffort>,
}

/// A reasoning effort that a listed Codex model accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexEffort {
    pub id: String,
    pub description: Option<String>,
}

const CODEX_CATALOG_TIMEOUT: Duration = Duration::from_secs(8);
const CODEX_CATALOG_MAX_BYTES: usize = 8 * 1024 * 1024;
const CODEX_CATALOG_MAX_MODELS: usize = 64;

/// Model slugs and effort ids reach the Codex command line, so only plain
/// identifiers are accepted.
fn is_plain_identifier(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

fn is_effort_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 16 && value.chars().all(|c| c.is_ascii_lowercase())
}

fn bounded_text(value: Option<&Value>, max_len: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| {
            !text.is_empty() && text.len() <= max_len && !text.chars().any(char::is_control)
        })
        .map(str::to_owned)
}

/// Parses the JSON printed by `codex debug models`: models Codex marks as
/// listed, in Codex's own priority order. Hidden models, malformed entries
/// and unsafe identifiers are skipped; unreadable output gives an empty list.
pub fn parse_model_catalog(json: &str) -> Vec<CodexModel> {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut listed: Vec<(i64, CodexModel)> = models
        .iter()
        .filter_map(|model| {
            if model.get("visibility").and_then(Value::as_str) != Some("list") {
                return None;
            }
            let slug = model.get("slug")?.as_str()?;
            if !is_plain_identifier(slug, 128) {
                return None;
            }
            let efforts: Vec<CodexEffort> = model
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|level| {
                            let id = level.get("effort")?.as_str()?;
                            is_effort_id(id).then(|| CodexEffort {
                                id: id.to_owned(),
                                description: bounded_text(level.get("description"), 256),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let default_effort = model
                .get("default_reasoning_level")
                .and_then(Value::as_str)
                .filter(|id| efforts.iter().any(|effort| effort.id == *id))
                .map(str::to_owned);
            let priority = model
                .get("priority")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX);
            Some((
                priority,
                CodexModel {
                    slug: slug.to_owned(),
                    display_name: bounded_text(model.get("display_name"), 128)
                        .unwrap_or_else(|| slug.to_owned()),
                    description: bounded_text(model.get("description"), 512),
                    context_window: model.get("context_window").and_then(Value::as_u64),
                    default_effort,
                    efforts,
                },
            ))
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    let mut seen = std::collections::HashSet::new();
    listed
        .into_iter()
        .map(|(_, model)| model)
        .filter(|model| seen.insert(model.slug.clone()))
        .take(CODEX_CATALOG_MAX_MODELS)
        .collect()
}

/// Reads the installed Codex CLI's model catalog with `codex debug models`.
/// Returns `None` when the command is missing, fails, times out, prints too
/// much, or lists no usable model, so callers keep the "default" choice.
pub async fn discover_models(program: &Path) -> Option<Vec<CodexModel>> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(["debug", "models"])
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(CODEX_CATALOG_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > CODEX_CATALOG_MAX_BYTES {
        return None;
    }
    let models = parse_model_catalog(std::str::from_utf8(&output.stdout).ok()?);
    (!models.is_empty()).then_some(models)
}

#[derive(Debug, PartialEq, Eq)]
enum CodexLine {
    Session(String),
    Token(String),
    Thought(String),
    Finished,
    Error(String),
    Skip,
}

fn parse_line(line: &str) -> CodexLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return CodexLine::Skip;
    };
    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "thread.started" => value
            .get("thread_id")
            .and_then(Value::as_str)
            .map(|id| CodexLine::Session(id.to_string()))
            .unwrap_or(CodexLine::Skip),
        "item.started" | "item.completed" => {
            let item = value.get("item");
            let kind = item
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = item
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            match (value.get("type").and_then(Value::as_str), kind) {
                (Some("item.completed"), "agent_message") if !text.is_empty() => {
                    CodexLine::Token(text.to_string())
                }
                (Some("item.completed"), "reasoning") if !text.is_empty() => {
                    CodexLine::Thought(text.to_string())
                }
                (_, "command_execution") => item
                    .and_then(|item| item.get("command"))
                    .and_then(Value::as_str)
                    .map(|command| CodexLine::Thought(format!("Command: {command}\n")))
                    .unwrap_or(CodexLine::Skip),
                (_, "mcp_tool_call") => item
                    .and_then(|item| item.get("server"))
                    .and_then(Value::as_str)
                    .map(|server| CodexLine::Thought(format!("MCP tool call: {server}\n")))
                    .unwrap_or_else(|| CodexLine::Thought("MCP tool call\n".to_string())),
                _ => CodexLine::Skip,
            }
        }
        "turn.completed" => CodexLine::Finished,
        "turn.failed" | "error" => CodexLine::Error(
            value
                .get("error")
                .and_then(|error| error.get("message").or(Some(error)))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Codex reported an error")
                .to_string(),
        ),
        _ => CodexLine::Skip,
    }
}

#[derive(Clone)]
pub struct CodexBackend {
    program: PathBuf,
    model: Arc<Mutex<Option<String>>>,
    effort: Arc<Mutex<Option<String>>>,
    session_id: Arc<Mutex<Option<String>>>,
    session_agent: Arc<Mutex<Option<bool>>>,
}

impl CodexBackend {
    pub fn new(program: PathBuf, model: Option<String>) -> Self {
        Self {
            program,
            model: Arc::new(Mutex::new(model)),
            effort: Arc::new(Mutex::new(None)),
            session_id: Arc::new(Mutex::new(None)),
            session_agent: Arc::new(Mutex::new(None)),
        }
    }

    pub fn model(&self) -> Option<String> {
        self.model
            .lock()
            .expect("Codex model lock poisoned")
            .clone()
    }

    pub fn set_model(&self, model: Option<String>) {
        *self.model.lock().expect("Codex model lock poisoned") = model;
        self.reset_session();
    }

    pub fn effort(&self) -> Option<String> {
        self.effort
            .lock()
            .expect("Codex effort lock poisoned")
            .clone()
    }

    pub fn set_effort(&self, effort: Option<String>) {
        *self.effort.lock().expect("Codex effort lock poisoned") = effort;
    }

    pub fn session_id(&self) -> Option<String> {
        self.session_id
            .lock()
            .expect("Codex session lock poisoned")
            .clone()
    }

    pub fn set_session(&self, session_id: Option<String>) {
        *self.session_id.lock().expect("Codex session lock poisoned") = session_id;
    }

    pub fn set_session_context(&self, session_id: Option<String>, agent: Option<bool>) {
        self.set_session(session_id);
        *self
            .session_agent
            .lock()
            .expect("Codex session mode lock poisoned") = agent;
    }

    pub fn reset_session(&self) {
        self.set_session(None);
        *self
            .session_agent
            .lock()
            .expect("Codex session mode lock poisoned") = None;
    }

    pub(crate) fn prepare_mode(&self, agent: bool) {
        let previous = *self
            .session_agent
            .lock()
            .expect("Codex session mode lock poisoned");
        if self.session_id().is_some() && previous != Some(agent) {
            self.reset_session();
        }
        *self
            .session_agent
            .lock()
            .expect("Codex session mode lock poisoned") = Some(agent);
    }

    pub async fn stream_chat(
        &self,
        prompt: String,
        agent: bool,
        cancel: CancellationToken,
        tx: StreamEventSender,
    ) {
        let result = self
            .stream_chat_inner(prompt, agent, cancel.clone(), tx.clone())
            .await;
        if cancel.is_cancelled() {
            return;
        }
        match result {
            Ok(()) => {
                let _ = tx.send(StreamEvent::Finished).await;
            }
            Err(error) => {
                let _ = tx
                    .send(StreamEvent::Error(format!("[Error] {error}")))
                    .await;
            }
        }
    }

    async fn stream_chat_inner(
        &self,
        prompt: String,
        agent: bool,
        cancel: CancellationToken,
        tx: StreamEventSender,
    ) -> Result<()> {
        if !agent {
            return Err(color_eyre::eyre::eyre!(
                "Codex CLI is available in Agent mode only. Turn on Agent, or choose an OpenAI API connector for regular chat."
            ));
        }
        self.prepare_mode(agent);
        let session_id = self.session_id();
        if let Some(id) = &session_id {
            if !is_canonical_session_id(id) {
                return Err(color_eyre::eyre::eyre!(
                    "The saved Codex thread identifier is invalid. Start a new conversation and try again."
                ));
            }
        }
        let mut command = tokio::process::Command::new(&self.program);
        command.env_remove("OPENAI_API_KEY");
        command.arg("exec");
        if session_id.is_some() {
            command.arg("resume");
        }
        command.args(["--json", "--skip-git-repo-check"]);
        if let Some(model) = self.model() {
            command.args(["--model", &model]);
        }
        if let Some(effort) = self.effort() {
            command.args(["--config", &format!("model_reasoning_effort=\"{effort}\"")]);
        }
        if session_id.is_none() {
            command.args(["--sandbox", "workspace-write"]);
        }
        let work_dir = user_home_dir().unwrap_or_else(std::env::temp_dir);
        command.current_dir(work_dir);
        if let Some(session_id) = session_id {
            command.arg(session_id);
        }
        command.arg("-");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = ManagedChild::spawn(&mut command).context("failed to start Codex CLI")?;
        let stdout = child.take_stdout().expect("Codex stdout was piped");
        let stderr = child.take_stderr().expect("Codex stderr was piped");
        let stderr_task = drain_stderr_tail(stderr);
        let mut stdin = child.take_stdin().expect("Codex stdin was piped");
        let write_result = tokio::select! {
            _ = cancel.cancelled() => {
                child.terminate().await;
                let _ = stderr_task.await;
                return Ok(());
            }
            result = async {
                stdin.write_all(prompt.as_bytes()).await?;
                stdin.shutdown().await
            } => result,
        };
        if let Err(error) = write_result {
            child.terminate().await;
            let _ = stderr_task.await;
            return Err(error).context("failed to send the prompt to Codex CLI");
        }
        drop(stdin);
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut total_output = 0usize;
        let mut saw_finished = false;

        loop {
            let read_result = tokio::select! {
                _ = cancel.cancelled() => {
                    child.terminate().await;
                    let _ = stderr_task.await;
                    return Ok(());
                }
                read = read_bounded_line(&mut reader, &mut line, CLI_STDOUT_LINE_LIMIT) => read,
            };
            let read = match read_result {
                Ok(read) => read,
                Err(error) => {
                    child.terminate().await;
                    let _ = stderr_task.await;
                    return Err(color_eyre::eyre::eyre!(
                        "error reading Codex output: {error}"
                    ));
                }
            };
            if read == 0 {
                break;
            }
            total_output = match total_output.checked_add(read) {
                Some(total) if total <= CLI_STDOUT_TOTAL_LIMIT => total,
                _ => {
                    child.terminate().await;
                    let _ = stderr_task.await;
                    return Err(color_eyre::eyre::eyre!(
                        "Codex output exceeded the 32 MiB size limit"
                    ));
                }
            };
            let line = match std::str::from_utf8(&line) {
                Ok(line) => line,
                Err(error) => {
                    child.terminate().await;
                    let _ = stderr_task.await;
                    return Err(color_eyre::eyre::eyre!(
                        "Codex output was not valid UTF-8: {error}"
                    ));
                }
            };
            match parse_line(line) {
                CodexLine::Session(id) => {
                    if !is_canonical_session_id(&id) {
                        child.terminate().await;
                        let _ = stderr_task.await;
                        return Err(color_eyre::eyre::eyre!(
                            "Codex CLI returned an invalid thread identifier"
                        ));
                    }
                    self.set_session(Some(id));
                }
                CodexLine::Token(text) => {
                    if !send_stream_event(&tx, &cancel, StreamEvent::Token(text)).await {
                        cancel.cancel();
                        child.terminate().await;
                        let _ = stderr_task.await;
                        return Ok(());
                    }
                }
                CodexLine::Thought(text) => {
                    if !send_stream_event(&tx, &cancel, StreamEvent::Thought(text)).await {
                        cancel.cancel();
                        child.terminate().await;
                        let _ = stderr_task.await;
                        return Ok(());
                    }
                }
                CodexLine::Finished => saw_finished = true,
                CodexLine::Error(message) => {
                    child.terminate().await;
                    let stderr = stderr_task.await.unwrap_or_default();
                    return Err(color_eyre::eyre::eyre!(
                        "{}{}",
                        message,
                        if stderr.is_empty() {
                            String::new()
                        } else {
                            format!(" — {stderr}")
                        }
                    ));
                }
                CodexLine::Skip => {}
            }
        }

        let status = child.wait().await.context("Codex CLI did not exit")?;
        let stderr = stderr_task.await.unwrap_or_default();
        if !status.success() {
            return Err(color_eyre::eyre::eyre!(
                "Codex exited with status {status}{}",
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(" — {stderr}")
                }
            ));
        }
        if !saw_finished {
            return Err(color_eyre::eyre::eyre!(
                "Codex closed before reporting a completed turn"
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX_CATALOG_0_167: &str =
        include_str!("../tests/fixtures/codex-debug-models-0.167.0.json");

    #[test]
    fn model_catalog_lists_visible_models_in_codex_priority_order() {
        let models = parse_model_catalog(CODEX_CATALOG_0_167);
        let slugs: Vec<&str> = models.iter().map(|model| model.slug.as_str()).collect();
        assert_eq!(
            slugs,
            [
                "gpt-6.1-sol",
                "gpt-6-astra",
                "gpt-6-sol",
                "gpt-6-luna",
                "gpt-5.6-sol",
                "gpt-6.1-terra",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-5.5",
            ]
        );
        let sol = &models[0];
        assert_eq!(sol.display_name, "GPT-6.1-Sol");
        assert_eq!(sol.context_window, Some(272_000));
        assert_eq!(sol.default_effort.as_deref(), Some("low"));
        let efforts: Vec<&str> = sol
            .efforts
            .iter()
            .map(|effort| effort.id.as_str())
            .collect();
        assert_eq!(efforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
        assert!(sol.efforts[0].description.is_some());
        let older = models
            .iter()
            .find(|model| model.slug == "gpt-5.5")
            .expect("gpt-5.5");
        let efforts: Vec<&str> = older
            .efforts
            .iter()
            .map(|effort| effort.id.as_str())
            .collect();
        assert_eq!(efforts, ["low", "medium", "high", "xhigh"]);
    }

    #[test]
    fn model_catalog_skips_unsafe_hidden_and_malformed_entries() {
        let json = r#"{"models":[
            {"slug":"good-1","display_name":"Good","visibility":"list","priority":2,
             "default_reasoning_level":"ultra",
             "supported_reasoning_levels":[{"effort":"low"},{"effort":"high\"; rm"},{"effort":"medium"}]},
            {"slug":"bad slug\";x","visibility":"list","priority":1},
            {"slug":"hidden","visibility":"hide","priority":0},
            {"display_name":"no slug","visibility":"list"},
            {"slug":"good-1","display_name":"Duplicate","visibility":"list","priority":3},
            "not an object"
        ]}"#;
        let models = parse_model_catalog(json);
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.slug, "good-1");
        assert_eq!(model.display_name, "Good");
        let efforts: Vec<&str> = model
            .efforts
            .iter()
            .map(|effort| effort.id.as_str())
            .collect();
        assert_eq!(efforts, ["low", "medium"]);
        assert_eq!(
            model.default_effort, None,
            "a default outside the list is dropped"
        );
    }

    #[test]
    fn unreadable_model_catalog_is_empty() {
        assert!(parse_model_catalog("").is_empty());
        assert!(parse_model_catalog("not json").is_empty());
        assert!(parse_model_catalog(r#"{"models":"nope"}"#).is_empty());
        assert!(parse_model_catalog("[]").is_empty());
    }

    #[tokio::test]
    async fn missing_codex_program_gives_no_catalog() {
        let missing = std::env::temp_dir().join("consilium-no-such-codex-binary");
        assert_eq!(discover_models(&missing).await, None);
    }

    #[test]
    fn parses_codex_thread_message_reasoning_and_completion() {
        assert_eq!(
            parse_line(r#"{"type":"thread.started","thread_id":"thread-1"}"#),
            CodexLine::Session("thread-1".into())
        );
        assert_eq!(
            parse_line(
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}"#
            ),
            CodexLine::Token("hello".into())
        );
        assert_eq!(
            parse_line(r#"{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}"#),
            CodexLine::Thought("hmm".into())
        );
        assert_eq!(
            parse_line(
                r#"{"type":"item.started","item":{"type":"command_execution","command":"pwd"}}"#
            ),
            CodexLine::Thought("Command: pwd\n".into())
        );
        assert_eq!(
            parse_line(r#"{"type":"turn.completed"}"#),
            CodexLine::Finished
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_codex_streams_and_resumes_thread() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("consilium-codex-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        let arguments = dir.join("args.txt");
        let prompts = dir.join("prompts.txt");
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(
            file,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\ncat >> '{}'\nprintf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"33333333-3333-4333-8333-333333333333\"}}' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"hello\"}}}}' '{{\"type\":\"turn.completed\"}}'",
            arguments.display(),
            prompts.display()
        )
        .unwrap();
        drop(file);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let backend = CodexBackend::new(script, Some("codex-model".into()));
        for prompt in ["first", "second"] {
            let (tx, mut rx) = crate::api::stream_event_channel();
            backend
                .stream_chat(prompt.into(), true, CancellationToken::new(), tx)
                .await;
            assert!(matches!(rx.recv().await, Some(StreamEvent::Token(text)) if text == "hello"));
            assert!(matches!(rx.recv().await, Some(StreamEvent::Finished)));
        }
        let (tx, mut rx) = crate::api::stream_event_channel();
        backend
            .stream_chat("agent turn".into(), true, CancellationToken::new(), tx)
            .await;
        assert!(matches!(rx.recv().await, Some(StreamEvent::Token(_))));
        assert!(matches!(rx.recv().await, Some(StreamEvent::Finished)));
        let args = std::fs::read_to_string(arguments).unwrap();
        assert!(args.contains("--model\ncodex-model"));
        assert!(args.contains("resume"));
        assert!(args.contains("33333333-3333-4333-8333-333333333333"));
        assert!(args.contains("--sandbox\nworkspace-write"));
        assert!(!args.contains("dangerously-bypass-approvals-and-sandbox"));
        assert!(!args.contains("first"));
        assert!(!args.contains("second"));
        assert!(!args.contains("agent turn"));
        assert_eq!(
            std::fs::read_to_string(prompts).unwrap(),
            "firstsecondagent turn"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn switching_between_agent_and_chat_drops_the_old_thread() {
        let backend = CodexBackend::new(PathBuf::from("codex"), None);
        backend.set_session_context(
            Some("33333333-3333-4333-8333-333333333333".into()),
            Some(true),
        );
        backend.prepare_mode(false);
        assert_eq!(backend.session_id(), None);
    }

    #[tokio::test]
    async fn chat_mode_has_a_clear_agent_only_message_without_launching() {
        let backend = CodexBackend::new(PathBuf::from("definitely-not-a-real-codex"), None);
        let (tx, mut rx) = crate::api::stream_event_channel();
        backend
            .stream_chat("hello".into(), false, CancellationToken::new(), tx)
            .await;
        assert!(matches!(
            rx.recv().await,
            Some(StreamEvent::Error(message))
                if message.contains("Agent mode only") && message.contains("OpenAI API")
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn newline_free_oversized_codex_output_is_rejected() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "consilium-codex-output-limit-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh\nhead -c 1048577 /dev/zero | tr '\\000' x").unwrap();
        drop(file);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let backend = CodexBackend::new(script, None);
        let (tx, mut rx) = crate::api::stream_event_channel();
        backend
            .stream_chat("hello".into(), true, CancellationToken::new(), tx)
            .await;
        let Some(StreamEvent::Error(error)) = rx.recv().await else {
            panic!("expected an output-limit error")
        };
        assert!(error.contains("output line exceeded"), "{error}");
        assert!(rx.recv().await.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_restored_thread_is_rejected_before_launch() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "consilium-codex-invalid-session-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("launched");
        let script = dir.join("codex");
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh\ntouch '{}'", marker.display()).unwrap();
        drop(file);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let backend = CodexBackend::new(script, None);
        backend.set_session_context(Some("--last".into()), Some(true));
        let (tx, mut rx) = crate::api::stream_event_channel();
        backend
            .stream_chat("hello".into(), true, CancellationToken::new(), tx)
            .await;
        assert!(matches!(
            rx.recv().await,
            Some(StreamEvent::Error(message)) if message.contains("invalid")
        ));
        assert!(!marker.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
