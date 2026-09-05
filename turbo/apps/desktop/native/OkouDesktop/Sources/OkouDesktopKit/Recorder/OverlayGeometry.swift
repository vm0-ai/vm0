import Foundation

/// A rectangle in global screen points, top-left origin, like Electron's
/// `Display.bounds`.
public struct OverlayRect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct OverlayPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct OverlaySize: Equatable, Sendable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

/// `Math.round`: halves round toward positive infinity, unlike Swift's
/// schoolbook rounding, which matters for displays left of the primary.
@inlinable
public func jsRound(_ value: Double) -> Double {
    (value + 0.5).rounded(.down)
}

/// Overlay placement rules shared by the recorder windows. Port of
/// `desktop-recorder-overlay-geometry.ts`.
public enum RecorderOverlayGeometry {
    /// The bar is exactly the surface it draws; failure text lives inside it.
    public static let barSize = OverlaySize(width: 866, height: 92)
    public static let barBottomMargin: Double = 72
    public static let controllerSize = OverlaySize(width: 268, height: 60)
    public static let windowPickerSize = OverlaySize(width: 900, height: 620)
    public static let controllerClearance: Double = 16

    public static func recorderBarBounds(display: OverlayRect) -> OverlayRect {
        OverlayRect(
            x: jsRound(display.x + (display.width - barSize.width) / 2),
            y: jsRound(display.y + display.height - barSize.height - barBottomMargin),
            width: barSize.width,
            height: barSize.height
        )
    }

    /// Orders the two corners of a drag so dragging up or left works too.
    public static func areaFromDrag(start: OverlayPoint, end: OverlayPoint) -> DesktopRecorderArea {
        DesktopRecorderArea(
            x: jsRound(min(start.x, end.x)),
            y: jsRound(min(start.y, end.y)),
            width: jsRound(abs(end.x - start.x)),
            height: jsRound(abs(end.y - start.y))
        )
    }

    public static func areaToGlobal(_ area: DesktopRecorderArea, display: OverlayRect) -> DesktopRecorderArea {
        DesktopRecorderArea(x: area.x + display.x, y: area.y + display.y, width: area.width, height: area.height)
    }

    public static func centredBounds(display: OverlayRect, size: OverlaySize) -> OverlayPoint {
        OverlayPoint(
            x: jsRound(display.x + (display.width - size.width) / 2),
            y: jsRound(display.y + (display.height - size.height) / 2)
        )
    }

    public static func bottomCentredBounds(display: OverlayRect, size: OverlaySize, margin: Double) -> OverlayPoint {
        OverlayPoint(
            x: jsRound(display.x + (display.width - size.width) / 2),
            y: jsRound(display.y + display.height - size.height - margin)
        )
    }

    /// Keeps the controller out of an area capture: below, above, right, left,
    /// and only when the region covers the display does it overlap.
    public static func recorderControllerBounds(captured: DesktopRecorderArea, display: OverlayRect) -> OverlayPoint {
        let width = controllerSize.width
        let height = controllerSize.height
        let centredX = jsRound(captured.x + (captured.width - width) / 2)
        let x = min(max(centredX, display.x), display.x + display.width - width)

        let below = captured.y + captured.height + controllerClearance
        if below + height <= display.y + display.height {
            return OverlayPoint(x: x, y: jsRound(below))
        }

        let above = captured.y - controllerClearance - height
        if above >= display.y {
            return OverlayPoint(x: x, y: jsRound(above))
        }

        let clampedY = jsRound(min(max(captured.y, display.y), display.y + display.height - height))
        let rightOf = captured.x + captured.width + controllerClearance
        if rightOf + width <= display.x + display.width {
            return OverlayPoint(x: jsRound(rightOf), y: clampedY)
        }

        let leftOf = captured.x - controllerClearance - width
        if leftOf >= display.x {
            return OverlayPoint(x: jsRound(leftOf), y: clampedY)
        }

        return OverlayPoint(x: x, y: jsRound(display.y + display.height - height - controllerClearance))
    }
}
