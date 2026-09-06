import Foundation

/// Tracks the spans a recording spent paused, and maps wall-clock capture times
/// onto the shorter timeline the finished movie actually has.
///
/// `SCStream` has no pause: frames keep arriving while the user is paused, they
/// are simply not written. Appending later frames at their raw timestamps would
/// leave the movie frozen for exactly as long as the pause lasted, so every time
/// written after a pause has the accumulated paused duration taken back out.
///
/// The click track is mapped through the same timeline, otherwise clicks after a
/// pause would point at the wrong moment in the video.
public struct PauseTimeline: Equatable, Sendable {
    private struct Span: Equatable, Sendable {
        let start: Double
        var end: Double?
    }

    private var spans: [Span] = []

    public init() {}

    public var isPaused: Bool {
        guard let last = spans.last else {
            return false
        }
        return last.end == nil
    }

    /// Ignores a pause while already paused, so a repeated request cannot open
    /// a second span and double-count the same stretch of time.
    public mutating func pause(at seconds: Double) {
        guard !isPaused else {
            return
        }
        spans.append(Span(start: seconds, end: nil))
    }

    /// Ignores a resume that was not paused.
    public mutating func resume(at seconds: Double) {
        guard isPaused, var last = spans.last else {
            return
        }
        last.end = max(seconds, last.start)
        spans[spans.count - 1] = last
    }

    /// Seconds spent paused strictly before `seconds`.
    public func pausedSecondsBefore(_ seconds: Double) -> Double {
        var total = 0.0
        for span in spans {
            let end = min(span.end ?? seconds, seconds)
            if span.start < end {
                total += end - span.start
            }
        }
        return total
    }

    /// The parts of a captured buffer that belong to the movie. Audio can
    /// arrive after pause was pressed or straddle either edge of a pause.
    public func recordedRanges(in range: Range<Double>) -> [Range<Double>] {
        var cursor = range.lowerBound
        var result: [Range<Double>] = []
        for span in spans {
            let end = span.end ?? range.upperBound
            if end <= cursor { continue }
            if span.start >= range.upperBound { break }
            if span.start > cursor {
                result.append(cursor..<min(span.start, range.upperBound))
            }
            cursor = max(cursor, end)
            if cursor >= range.upperBound { return result }
        }
        if cursor < range.upperBound { result.append(cursor..<range.upperBound) }
        return result
    }

    /// Where a capture timestamp lands in the finished movie, or `nil` when it
    /// falls inside a pause and therefore is not in the movie at all.
    public func mediaTime(forCaptureTime seconds: Double) -> Double? {
        for span in spans where span.start <= seconds {
            if let end = span.end {
                if seconds < end {
                    return nil
                }
            } else {
                return nil
            }
        }
        return max(0, seconds - pausedSecondsBefore(seconds))
    }
}
