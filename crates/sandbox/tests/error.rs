use sandbox::{
    SandboxError, SandboxIdleTransition, SandboxInitializationPhase, SandboxInvalidStateContext,
    SandboxOperation, SandboxOperationReason,
};

#[test]
fn initialization_error_exposes_phase() {
    let err = SandboxError::Initialization {
        phase: SandboxInitializationPhase::Runtime,
        message: "netns pool".into(),
    };

    match err {
        SandboxError::Initialization { phase, message } => {
            assert_eq!(phase, SandboxInitializationPhase::Runtime);
            assert_eq!(message, "netns pool");
        }
        other => panic!("expected initialization error, got {other:?}"),
    }
}

#[test]
fn operation_error_exposes_operation_and_reason() {
    let err = SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "disk full".into(),
    };

    match err {
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => {
            assert_eq!(operation, SandboxOperation::WriteFile);
            assert_eq!(reason, SandboxOperationReason::Guest);
            assert_eq!(message, "disk full");
        }
        other => panic!("expected operation error, got {other:?}"),
    }
}

#[test]
fn invalid_state_error_exposes_context_and_state() {
    let err = SandboxError::InvalidState {
        context: SandboxInvalidStateContext::Operation(SandboxOperation::Exec),
        state: "stopped".into(),
        message: "sandbox not running".into(),
    };

    match err {
        SandboxError::InvalidState {
            context,
            state,
            message,
        } => {
            assert_eq!(
                context,
                SandboxInvalidStateContext::Operation(SandboxOperation::Exec)
            );
            assert_eq!(state, "stopped");
            assert_eq!(message, "sandbox not running");
        }
        other => panic!("expected invalid state error, got {other:?}"),
    }
}

#[test]
fn idle_transition_error_exposes_transition() {
    let err = SandboxError::IdleTransition {
        transition: SandboxIdleTransition::Unpark,
        message: "vm resume".into(),
    };

    match err {
        SandboxError::IdleTransition {
            transition,
            message,
        } => {
            assert_eq!(transition, SandboxIdleTransition::Unpark);
            assert_eq!(message, "vm resume");
        }
        other => panic!("expected idle transition error, got {other:?}"),
    }
}

#[test]
fn display_includes_category_and_message() {
    let err = SandboxError::Operation {
        operation: SandboxOperation::WaitExit,
        reason: SandboxOperationReason::BackendCrashed,
        message: "firecracker process crashed".into(),
    };

    let text = err.to_string();
    assert!(text.contains("wait exit"), "got: {text}");
    assert!(text.contains("backend crashed"), "got: {text}");
    assert!(text.contains("firecracker process crashed"), "got: {text}");
}

#[test]
fn bounded_exec_operation_display_name_is_stable() {
    let err = SandboxError::Operation {
        operation: SandboxOperation::BoundedExec,
        reason: SandboxOperationReason::Guest,
        message: "guest error".into(),
    };

    let text = err.to_string();
    assert!(text.contains("bounded exec"), "got: {text}");
}
