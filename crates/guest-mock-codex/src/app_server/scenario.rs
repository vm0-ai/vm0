use std::io;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Scenario {
    Success,
    DisconnectAfterInitialize,
    ExitOnTurnStart,
    ExitOnTurnStartWithStderrHolder,
    HangOnTurnStart,
    InterleavedNotification,
    InvalidResponseId,
    MalformedErrorResponse,
    MalformedInitializeResult,
    LargeNotificationBeforeResponse,
    HangAfterInitializeResponse,
    HangOnThreadStart,
    MalformedStdout,
    HangOnStdinEof,
    SigtermDeafOnStdinEof,
    NullIdServerRequestBeforeResponse,
    NotificationOverflow,
    OversizedStdout,
    ServerRequestBeforeResponse,
    StderrHolderOnStdinEof,
    SplitNotificationAfterThreadStart,
    UnknownResponseBeforeResponse,
    StaleTurn,
    NoActiveTurn,
    ExitOnTurnSteer,
    RuntimeTurnComplete,
    RuntimeTurnCompleteAfterSteer,
    RuntimeTurnCompleteBeforeSteerResponse,
    RuntimeTurnStartedBeforeSteer,
    RuntimeTurnCompleteWithoutThreadStarted,
    RuntimeEventFlood,
    RuntimeLargeEventFlood,
    ResumeDifferentThreadId,
    ResumeRpcErrorWithThreadId,
    ThreadStartInvalidThreadId,
    UnexpectedThreadOutputItemStarted,
    UnexpectedTurnOutputItemStarted,
    UnexpectedThreadTurnCompleted,
    SecondaryThreadNotifications,
}

impl Scenario {
    pub(super) fn from_env() -> io::Result<Self> {
        match std::env::var("MOCK_CODEX_APP_SERVER_SCENARIO") {
            Ok(value) if value.is_empty() => Ok(Self::Success),
            Ok(value) => match value.as_str() {
                "disconnect-after-initialize" => Ok(Self::DisconnectAfterInitialize),
                "exit-on-turn-start" => Ok(Self::ExitOnTurnStart),
                "exit-on-turn-start-with-stderr-holder" => {
                    Ok(Self::ExitOnTurnStartWithStderrHolder)
                }
                "hang-on-turn-start" => Ok(Self::HangOnTurnStart),
                "interleaved-notification" => Ok(Self::InterleavedNotification),
                "invalid-response-id" => Ok(Self::InvalidResponseId),
                "malformed-error-response" => Ok(Self::MalformedErrorResponse),
                "malformed-initialize-result" => Ok(Self::MalformedInitializeResult),
                "large-notification-before-response" => Ok(Self::LargeNotificationBeforeResponse),
                "hang-after-initialize-response" => Ok(Self::HangAfterInitializeResponse),
                "hang-on-thread-start" => Ok(Self::HangOnThreadStart),
                "malformed-stdout" => Ok(Self::MalformedStdout),
                "hang-on-stdin-eof" => Ok(Self::HangOnStdinEof),
                "sigterm-deaf-on-stdin-eof" => Ok(Self::SigtermDeafOnStdinEof),
                "null-id-server-request-before-response" => {
                    Ok(Self::NullIdServerRequestBeforeResponse)
                }
                "notification-overflow" => Ok(Self::NotificationOverflow),
                "oversized-stdout" => Ok(Self::OversizedStdout),
                "server-request-before-response" => Ok(Self::ServerRequestBeforeResponse),
                "stderr-holder-on-stdin-eof" => Ok(Self::StderrHolderOnStdinEof),
                "split-notification-after-thread-start" => {
                    Ok(Self::SplitNotificationAfterThreadStart)
                }
                "unknown-response-before-response" => Ok(Self::UnknownResponseBeforeResponse),
                "stale-turn" => Ok(Self::StaleTurn),
                "no-active-turn" => Ok(Self::NoActiveTurn),
                "exit-on-turn-steer" => Ok(Self::ExitOnTurnSteer),
                "runtime-turn-complete" => Ok(Self::RuntimeTurnComplete),
                "runtime-turn-complete-after-steer" => Ok(Self::RuntimeTurnCompleteAfterSteer),
                "runtime-turn-complete-before-steer-response" => {
                    Ok(Self::RuntimeTurnCompleteBeforeSteerResponse)
                }
                "runtime-turn-started-before-steer" => Ok(Self::RuntimeTurnStartedBeforeSteer),
                "runtime-turn-complete-without-thread-started" => {
                    Ok(Self::RuntimeTurnCompleteWithoutThreadStarted)
                }
                "runtime-event-flood" => Ok(Self::RuntimeEventFlood),
                "runtime-large-event-flood" => Ok(Self::RuntimeLargeEventFlood),
                "resume-different-thread-id" => Ok(Self::ResumeDifferentThreadId),
                "resume-rpc-error-with-thread-id" => Ok(Self::ResumeRpcErrorWithThreadId),
                "thread-start-invalid-thread-id" => Ok(Self::ThreadStartInvalidThreadId),
                "unexpected-thread-output-item-started" => {
                    Ok(Self::UnexpectedThreadOutputItemStarted)
                }
                "unexpected-turn-output-item-started" => Ok(Self::UnexpectedTurnOutputItemStarted),
                "unexpected-thread-turn-completed" => Ok(Self::UnexpectedThreadTurnCompleted),
                "secondary-thread-notifications" => Ok(Self::SecondaryThreadNotifications),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unsupported MOCK_CODEX_APP_SERVER_SCENARIO={value:?}"),
                )),
            },
            Err(_) => Ok(Self::Success),
        }
    }

    pub(super) fn accepts_client_response(self) -> bool {
        matches!(
            self,
            Self::ServerRequestBeforeResponse | Self::NullIdServerRequestBeforeResponse
        )
    }

    pub(super) fn writes_turn_started_before_steer(self) -> bool {
        matches!(
            self,
            Self::ExitOnTurnSteer
                | Self::NoActiveTurn
                | Self::RuntimeTurnCompleteBeforeSteerResponse
                | Self::RuntimeTurnStartedBeforeSteer
                | Self::StaleTurn
        )
    }
}
