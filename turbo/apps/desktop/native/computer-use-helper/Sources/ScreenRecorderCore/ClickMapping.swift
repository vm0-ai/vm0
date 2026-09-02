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
    /// `CGEvent.timestamp`: nanoseconds since boot on the host clock.
    public let nanoseconds: UInt64
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
        nanoseconds: UInt64,
        screenX: Double,
        screenY: Double,
        button: String,
        clickCount: Int,
        modifiers: [String],
        geometry: CaptureGeometry? = nil
    ) {
        self.nanoseconds = nanoseconds
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
        guard let offsetMs = timeline.offsetMilliseconds(atNanoseconds: click.nanoseconds)
        else {
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

/// Places `CGEvent` timestamps on the recording's timeline.
///
/// `CGEvent.timestamp` is nanoseconds since boot on the same host clock that
/// stamps the captured frames. It is not raw `mach_absolute_time` ticks: the
/// system has already applied the timebase. Applying it a second time here
/// multiplied every offset by 125/3 on Apple silicon, which reported a click
/// two seconds into a recording as 97 days into it, and looked fine on Intel
/// machines only because their ratio is 1/1.
public struct ClickTimeline: Equatable, Sendable {
    /// Host-clock time of the first captured frame, in nanoseconds.
    public let startNanoseconds: UInt64

    public init(startNanoseconds: UInt64) {
        self.startNanoseconds = startNanoseconds
    }

    /// Milliseconds from the start of the recording, or `nil` for an event that
    /// predates it.
    public func offsetMilliseconds(atNanoseconds nanoseconds: UInt64) -> Int? {
        guard nanoseconds >= startNanoseconds else {
            return nil
        }
        return Int((Double(nanoseconds - startNanoseconds) / 1_000_000).rounded())
    }
}
