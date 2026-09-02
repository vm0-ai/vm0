import Foundation

/// Decides where a captured sample lands on the movie's timeline, or that it
/// must not be written at all.
///
/// The writer refuses a sample whose time is not later than the previous one
/// on the same track, and once it has refused one it refuses everything after
/// it for the rest of the recording. Two things in the capture produce such
/// samples: audio buffers that arrive stamped earlier than the video frame the
/// session was anchored on, which the pause arithmetic would fold onto the
/// anchor as duplicates, and any sample whose adjusted time fails to advance.
/// Both are dropped here rather than handed to the writer.
public enum SampleTimingPolicy {
    /// Slack allowed when comparing against the previous sample's end, so
    /// floating-point drift between neighbouring buffers is not read as overlap.
    public static let overlapTolerance = 0.000_001

    /// The media time to write `captureSeconds` at, or `nil` to drop it.
    ///
    /// - `captureSeconds`: the sample's time relative to the anchor frame.
    /// - `pauses`: the recording's pause spans.
    /// - `lastWrittenSeconds`: the media time of the last sample written to
    ///   the same track, or `nil` when the track has none yet.
    /// - `lastWrittenEndSeconds`: where that sample ended, for tracks whose
    ///   samples have extent. Audio buffers carry 20 ms of sound each, and the
    ///   writer refuses one that starts before the previous one has finished:
    ///   a window capture's audio jumps like that when the window's app starts
    ///   making sound. Video frames pass their own start here.
    public static func mediaTime(
        captureSeconds: Double,
        pauses: PauseTimeline,
        lastWrittenSeconds: Double?,
        lastWrittenEndSeconds: Double? = nil
    ) -> Double? {
        guard captureSeconds >= 0 else {
            return nil
        }
        guard let mediaSeconds = pauses.mediaTime(forCaptureTime: captureSeconds) else {
            return nil
        }
        if let lastWrittenSeconds, mediaSeconds <= lastWrittenSeconds {
            return nil
        }
        if let lastWrittenEndSeconds, mediaSeconds + overlapTolerance < lastWrittenEndSeconds {
            return nil
        }
        return mediaSeconds
    }
}
