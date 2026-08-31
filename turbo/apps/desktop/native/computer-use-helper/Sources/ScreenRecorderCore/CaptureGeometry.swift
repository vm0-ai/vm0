import Foundation

/// Where a capture sits in global screen points, and how those points become
/// encoded pixels.
///
/// Reported to the Electron side verbatim so click coordinates captured later
/// are mapped through exactly the geometry the frames were encoded with,
/// instead of a second derivation that could drift.
public struct CaptureGeometry: Equatable, Sendable {
    /// Top-left origin of the captured region, in global screen points.
    public let originX: Double
    public let originY: Double
    public let widthPoints: Double
    public let heightPoints: Double
    /// Backing pixels per point on the captured display.
    public let scale: Double

    public init(
        originX: Double,
        originY: Double,
        widthPoints: Double,
        heightPoints: Double,
        scale: Double
    ) {
        self.originX = originX
        self.originY = originY
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
        self.scale = scale
    }
}

/// Encoded frame dimensions in pixels.
public struct OutputSize: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

public enum CaptureSizePolicy {
    /// Widest frame we encode. A 5K display captured natively costs roughly
    /// four times the per-frame work of this cap for detail an intro video
    /// never shows.
    public static let maximumWidth = 1920

    /// Full-resolution pixel size of a captured region, before any cap.
    public static func nativePixelSize(for geometry: CaptureGeometry) -> OutputSize {
        return OutputSize(
            width: evenPixels(geometry.widthPoints * geometry.scale),
            height: evenPixels(geometry.heightPoints * geometry.scale)
        )
    }

    /// Pixel size we actually encode: capped to `maximumWidth`, aspect
    /// preserved, both dimensions even because H.264 4:2:0 cannot encode odd
    /// ones.
    public static func outputSize(
        for geometry: CaptureGeometry,
        maximumWidth: Int = CaptureSizePolicy.maximumWidth
    ) -> OutputSize {
        let native = nativePixelSize(for: geometry)
        guard native.width > maximumWidth, native.width > 0 else {
            return native
        }
        let ratio = Double(maximumWidth) / Double(native.width)
        return OutputSize(
            width: evenPixels(Double(maximumWidth)),
            height: evenPixels(Double(native.height) * ratio)
        )
    }

    private static func evenPixels(_ value: Double) -> Int {
        guard value.isFinite, value >= 2 else {
            return 2
        }
        let rounded = Int(value.rounded())
        return rounded - (rounded % 2)
    }
}
