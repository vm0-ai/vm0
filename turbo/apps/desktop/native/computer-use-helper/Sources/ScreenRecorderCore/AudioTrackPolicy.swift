import Foundation

/// Which audio tracks a recording writes.
///
/// System audio and the microphone stay on separate tracks rather than being
/// mixed, so an editor can duck one under the other afterwards. Mixing is not
/// reversible; two tracks can always be flattened later.
public struct AudioTrackPlan: Equatable, Sendable {
    public let systemAudio: Bool
    public let microphone: Bool
    /// Set when the microphone was asked for but cannot be recorded, so the
    /// caller can say why instead of silently producing a silent track.
    public let microphoneUnavailableReason: String?

    public init(
        systemAudio: Bool,
        microphone: Bool,
        microphoneUnavailableReason: String?
    ) {
        self.systemAudio = systemAudio
        self.microphone = microphone
        self.microphoneUnavailableReason = microphoneUnavailableReason
    }

    public var trackCount: Int {
        return (systemAudio ? 1 : 0) + (microphone ? 1 : 0)
    }
}

public enum AudioTrackPolicy {
    public static let microphoneRequiresNewerSystem =
        "Recording the microphone needs macOS 15 or later"

    /// Decides the tracks for a request.
    ///
    /// A microphone asked for on a system that cannot capture it is reported
    /// rather than quietly dropped: a recording that was supposed to carry
    /// narration and does not is worse than being told up front.
    public static func plan(
        systemAudio: Bool,
        microphone: Bool,
        microphoneSupported: Bool
    ) -> AudioTrackPlan {
        guard microphone else {
            return AudioTrackPlan(
                systemAudio: systemAudio,
                microphone: false,
                microphoneUnavailableReason: nil
            )
        }
        guard microphoneSupported else {
            return AudioTrackPlan(
                systemAudio: systemAudio,
                microphone: false,
                microphoneUnavailableReason: microphoneRequiresNewerSystem
            )
        }
        return AudioTrackPlan(
            systemAudio: systemAudio,
            microphone: true,
            microphoneUnavailableReason: nil
        )
    }
}
