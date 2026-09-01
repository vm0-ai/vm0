import Foundation

/// Which audio tracks a recording writes.
///
/// System audio and the microphone stay on separate tracks rather than being
/// mixed, so an editor can duck one under the other afterwards. Mixing is not
/// reversible; two tracks can always be flattened later.
public struct AudioTrackPlan: Equatable, Sendable {
    public let systemAudio: Bool
    public let microphone: Bool

    public init(systemAudio: Bool, microphone: Bool) {
        self.systemAudio = systemAudio
        self.microphone = microphone
    }

    public var trackCount: Int {
        return (systemAudio ? 1 : 0) + (microphone ? 1 : 0)
    }
}

public enum AudioTrackPolicy {
    /// Decides the tracks for a request.
    ///
    /// A system that cannot reach the microphone records without it. The app
    /// only offers the microphone where ScreenCaptureKit can capture it, so
    /// this is the helper refusing to open a track it could never fill rather
    /// than quietly overriding a choice the user was able to make.
    public static func plan(
        systemAudio: Bool,
        microphone: Bool,
        microphoneSupported: Bool
    ) -> AudioTrackPlan {
        return AudioTrackPlan(
            systemAudio: systemAudio,
            microphone: microphone && microphoneSupported
        )
    }
}
