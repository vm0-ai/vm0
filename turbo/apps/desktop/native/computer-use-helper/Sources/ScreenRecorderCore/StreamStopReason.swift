import Foundation

/// Why a capture stream ended without the app asking it to.
public enum StreamStopReason: Equatable, Sendable {
    /// The person recording ended the share themselves, from the system's own
    /// screen-sharing indicator. This is an ordinary finish, not a fault.
    case userStopped
    /// The capture broke: the window closed, the display was unplugged, or the
    /// stream was revoked.
    case failed
}

public enum StreamStopClassifier {
    /// `SCStreamErrorUserStopped`. macOS reports the user ending the share
    /// through its own indicator as an `SCStreamError`, so the only thing
    /// separating "finished" from "broken" is this code.
    public static let userStoppedErrorCode = -3817

    /// `SCStreamError` values live in this domain; codes from anywhere else
    /// carry no such guarantee and are treated as faults.
    public static let streamErrorDomain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"

    public static func classify(domain: String, code: Int) -> StreamStopReason {
        guard domain == streamErrorDomain, code == userStoppedErrorCode else {
            return .failed
        }
        return .userStopped
    }
}
