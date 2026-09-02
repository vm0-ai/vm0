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

/// One observed click, in the plain values the tap captured.
///
/// Kept free of CoreGraphics types so the projection below can be exercised
/// without a capture device or an event tap.
public struct CapturedClick: Equatable, Sendable {
    public let ticks: UInt64
    public let screenX: Double
    public let screenY: Double
    public let button: String
    public let clickCount: Int
    public let modifiers: [String]
    /// Where the captured region stood when this click happened, for a source
    /// that moves during the recording. A window capture follows the window
    /// wherever it is dragged, so a click after the drag must be projected
    /// through the window's position at that moment, not the one it had when
    /// the capture was prepared. `nil` means the recording's geometry applies.
    public let geometry: CaptureGeometry?

    public init(
        ticks: UInt64,
        screenX: Double,
        screenY: Double,
        button: String,
        clickCount: Int,
        modifiers: [String],
        geometry: CaptureGeometry? = nil
    ) {
        self.ticks = ticks
        self.screenX = screenX
        self.screenY = screenY
        self.button = button
        self.clickCount = clickCount
        self.modifiers = modifiers
        self.geometry = geometry
    }
}

/// A captured click placed on the recording's timeline and geometry.
public struct ProjectedClick: Equatable, Sendable {
    public let offsetMs: Int
    public let button: String
    public let clickCount: Int
    public let modifiers: [String]
    public let point: MappedClickPoint
}

/// Places captured clicks onto the recording.
///
/// The two ways a click can fail to land are deliberately not the same thing:
///
/// - A click that predates the first video frame is outside the recording
///   altogether — the tap starts before `SCStream` delivers its first sample —
///   so it is dropped without being counted.
/// - `droppedOutOfFrame` counts only clicks that happened during the recording
///   but landed outside the captured region. Recording one window and clicking
///   elsewhere means the click happened in an application the user never agreed
///   to record, so its position is not ours to keep; the count is what tells
///   downstream that activity happened at all.
public func projectClicks(
    _ clicks: [CapturedClick],
    timeline: ClickTimeline,
    geometry: CaptureGeometry,
    outputSize: OutputSize
) -> (clicks: [ProjectedClick], droppedOutOfFrame: Int) {
    var projected: [ProjectedClick] = []
    var droppedOutOfFrame = 0

    for click in clicks {
        guard let offsetMs = timeline.offsetMilliseconds(atTicks: click.ticks) else {
            continue
        }
        guard
            let point = (click.geometry ?? geometry).mapClick(
                screenX: click.screenX,
                screenY: click.screenY,
                outputSize: outputSize
            )
        else {
            droppedOutOfFrame += 1
            continue
        }
        projected.append(
            ProjectedClick(
                offsetMs: offsetMs,
                button: click.button,
                clickCount: click.clickCount,
                modifiers: click.modifiers,
                point: point
            )
        )
    }

    return (projected, droppedOutOfFrame)
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
