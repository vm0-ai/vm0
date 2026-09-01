import Foundation
import ScreenCaptureKit

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
    /// macOS reports the user ending the share through its own indicator as an
    /// `SCStreamError`, so the only thing separating "finished" from "broken"
    /// is this code. Taken from the SDK rather than written out, because a
    /// mistyped literal would classify every user stop as a fault and silently
    /// restore the bug this classifier exists to fix.
    public static let userStoppedErrorCode = SCStreamError.Code.userStopped.rawValue

    /// `SCStreamError` values live in this domain; codes from anywhere else
    /// carry no such guarantee and are treated as faults.
    public static let streamErrorDomain = SCStreamError.errorDomain

    public static func classify(domain: String, code: Int) -> StreamStopReason {
        guard domain == streamErrorDomain, code == userStoppedErrorCode else {
            return .failed
        }
        return .userStopped
    }
}
