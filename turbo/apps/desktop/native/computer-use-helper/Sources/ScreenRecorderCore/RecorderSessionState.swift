import Foundation

/// Lifecycle of a single recording session, as reported to the Electron side.
public enum RecorderSessionState: String, Equatable, Sendable {
    case ready
    case recording
    case paused
    case stopped
    case failed
}

public enum RecorderCommand: String, Equatable, Sendable {
    case start
    case pause
    case resume
    case stop
}

/// Conforms to `Error` because it is the failure type of the `Result` returned
/// by `RecorderTransitionPolicy`, which constrains it to `Error`.
public struct RecorderTransitionFailure: Error, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// Validates session commands before they reach `SCStream` / `AVAssetWriter`.
///
/// Kept pure so the ordering rules are testable without a capture device: the
/// helper only ever performs a transition this policy already accepted.
public enum RecorderTransitionPolicy {
    public static func next(
        from state: RecorderSessionState,
        command: RecorderCommand
    ) -> Result<RecorderSessionState, RecorderTransitionFailure> {
        switch (state, command) {
        case (.ready, .start):
            return .success(.recording)
        case (.recording, .pause):
            return .success(.paused)
        case (.paused, .resume):
            return .success(.recording)
        case (.recording, .stop), (.paused, .stop):
            return .success(.stopped)
        default:
            return .failure(
                RecorderTransitionFailure(
                    code: "invalid_state",
                    message:
                        "Cannot \(command.rawValue) a screen recording that is \(state.rawValue)"
                )
            )
        }
    }

    /// A stopped or failed session holds no capture resources, so its state is
    /// terminal and the helper may release it.
    public static func isTerminal(_ state: RecorderSessionState) -> Bool {
        return state == .stopped || state == .failed
    }
}
