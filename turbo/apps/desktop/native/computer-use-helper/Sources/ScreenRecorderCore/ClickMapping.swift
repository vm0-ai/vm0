import Foundation

/// A click expressed in every coordinate space the downstream editor needs.
///
/// All three are reported because they answer different questions: `screen` is
/// the raw fact, `frame` can be drawn straight onto the encoded video, and
/// `normalized` survives the video being transcoded or resized later.
public struct MappedClickPoint: Equatable, Sendable {
    public let screenX: Double
    public let screenY: Double
    public let frameX: Int
    public let frameY: Int
    public let normalizedX: Double
    public let normalizedY: Double

    public init(
        screenX: Double,
        screenY: Double,
        frameX: Int,
        frameY: Int,
        normalizedX: Double,
        normalizedY: Double
    ) {
        self.screenX = screenX
        self.screenY = screenY
        self.frameX = frameX
        self.frameY = frameY
        self.normalizedX = normalizedX
        self.normalizedY = normalizedY
    }
}

extension CaptureGeometry {
    /// Maps a global screen point into the encoded frame.
    ///
    /// Returns `nil` when the click landed outside the captured region. Those
    /// clicks are dropped rather than clamped: while recording a single window,
    /// a click elsewhere happened in an application the user never agreed to
    /// record, so its position is not ours to keep.
    ///
    /// Both `CGEvent` locations and `CaptureGeometry` use a top-left origin, so
    /// no vertical flip belongs here. Callers reading positions from `NSEvent`,
    /// which has a bottom-left origin, must convert before calling.
    public func mapClick(
        screenX: Double,
        screenY: Double,
        outputSize: OutputSize
    ) -> MappedClickPoint? {
        guard widthPoints > 0, heightPoints > 0 else {
            return nil
        }
        let relativeX = screenX - originX
        let relativeY = screenY - originY
        guard
            relativeX >= 0, relativeX < widthPoints,
            relativeY >= 0, relativeY < heightPoints
        else {
            return nil
        }
        let normalizedX = relativeX / widthPoints
        let normalizedY = relativeY / heightPoints
        return MappedClickPoint(
            screenX: screenX,
            screenY: screenY,
            frameX: Int((normalizedX * Double(outputSize.width)).rounded(.down)),
            frameY: Int((normalizedY * Double(outputSize.height)).rounded(.down)),
            normalizedX: normalizedX,
            normalizedY: normalizedY
        )
    }
}

/// Converts `CGEvent` timestamps onto the recording's timeline.
///
/// `CGEvent.timestamp` is mach absolute time in raw tick units, which are not
/// nanoseconds on every machine; the timebase ratio has to be applied or every
/// click lands at the wrong moment in the video.
public struct ClickTimeline: Equatable, Sendable {
    public let startTicks: UInt64
    public let timebaseNumerator: UInt32
    public let timebaseDenominator: UInt32

    public init(
        startTicks: UInt64,
        timebaseNumerator: UInt32,
        timebaseDenominator: UInt32
    ) {
        self.startTicks = startTicks
        self.timebaseNumerator = timebaseNumerator
        self.timebaseDenominator = max(1, timebaseDenominator)
    }

    /// Milliseconds from the start of the recording, or `nil` for an event that
    /// predates it.
    public func offsetMilliseconds(atTicks ticks: UInt64) -> Int? {
        guard ticks >= startTicks else {
            return nil
        }
        let elapsedTicks = Double(ticks - startTicks)
        let nanoseconds =
            elapsedTicks * Double(timebaseNumerator) / Double(timebaseDenominator)
        return Int((nanoseconds / 1_000_000).rounded())
    }
}
