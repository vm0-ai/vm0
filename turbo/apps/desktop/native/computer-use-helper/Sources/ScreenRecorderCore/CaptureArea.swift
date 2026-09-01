import Foundation

/// A rectangle in global screen points, top-left origin.
public struct AreaRect: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var maxX: Double { x + width }
    public var maxY: Double { y + height }
}

public enum CaptureAreaPolicy {
    /// Smallest area worth capturing, in points. Anything thinner cannot encode
    /// to the two-pixel floor `CaptureSizePolicy` enforces.
    public static let minimumSidePoints = 2.0

    /// Confines a requested area to the display it will be captured from.
    ///
    /// A selection dragged past the edge of the screen is ordinary, so the
    /// overlap is captured rather than the request being rejected. `nil` means
    /// there is nothing to capture: the areas do not overlap, or what remains is
    /// too thin to encode.
    public static func clamp(_ requested: AreaRect, toDisplay display: AreaRect) -> AreaRect? {
        let left = max(requested.x, display.x)
        let top = max(requested.y, display.y)
        let right = min(requested.maxX, display.maxX)
        let bottom = min(requested.maxY, display.maxY)

        let width = right - left
        let height = bottom - top
        guard width >= minimumSidePoints, height >= minimumSidePoints else {
            return nil
        }
        return AreaRect(x: left, y: top, width: width, height: height)
    }

    /// Re-expresses a global area in the display's own coordinate space, which
    /// is what `SCStreamConfiguration.sourceRect` expects. Passing global
    /// coordinates straight through crops the wrong region on every display
    /// whose origin is not (0, 0).
    public static func relativeToDisplay(_ area: AreaRect, display: AreaRect) -> AreaRect {
        return AreaRect(
            x: area.x - display.x,
            y: area.y - display.y,
            width: area.width,
            height: area.height
        )
    }
}
