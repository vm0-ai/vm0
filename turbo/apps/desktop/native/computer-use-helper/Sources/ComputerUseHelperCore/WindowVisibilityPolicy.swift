import CoreGraphics
import Foundation

public func windowServerWindows(ownerPID: Int32, onScreenOnly: Bool) -> [[String: Any]] {
    // Ordered-out windows can retain Space membership while omitting the
    // onscreen flag. The filtered WindowServer list also includes occluded
    // windows and windows on other displays without admitting hidden windows.
    let options: CGWindowListOption = onScreenOnly
        ? [.optionOnScreenOnly, .excludeDesktopElements]
        : [.excludeDesktopElements]
    let records = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    return records.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == ownerPID }
}

public struct VisualPointerTargetWindow: Sendable {
    public let windowNumber: Int
    public let ownerPID: Int
    public let frame: CGRect

    public init(windowNumber: Int, ownerPID: Int, frame: CGRect) {
        self.windowNumber = windowNumber
        self.ownerPID = ownerPID
        self.frame = frame
    }
}

public struct VisualPointerStackWindow: Sendable {
    public let windowNumber: Int
    public let ownerPID: Int
    public let frame: CGRect
    public let isOnScreen: Bool
    public let alpha: Double

    public init(
        windowNumber: Int,
        ownerPID: Int,
        frame: CGRect,
        isOnScreen: Bool,
        alpha: Double
    ) {
        self.windowNumber = windowNumber
        self.ownerPID = ownerPID
        self.frame = frame
        self.isOnScreen = isOnScreen
        self.alpha = alpha
    }
}

public func topVisibleWindow(
    containing point: CGPoint,
    in windowStack: [VisualPointerStackWindow]
) -> VisualPointerStackWindow? {
    return windowStack.first { window in
        window.isOnScreen &&
            window.alpha > 0.01 &&
            window.frame.width > 0 &&
            window.frame.height > 0 &&
            window.frame.contains(point)
    }
}

public func shouldShowVisualPointer(
    target: VisualPointerTargetWindow,
    point: CGPoint,
    windowStack: [VisualPointerStackWindow]
) -> Bool {
    guard target.frame.contains(point),
          let topWindow = topVisibleWindow(containing: point, in: windowStack)
    else {
        return false
    }

    return topWindow.windowNumber == target.windowNumber ||
        topWindow.ownerPID == target.ownerPID
}

public func isControllableWindowLayer(
    _ layer: Int,
    frame: CGRect,
    accessibilityWindowFrames: [CGRect]
) -> Bool {
    if layer == 0 { return true }
    guard layer > 0 else { return false }
    // Floating panels and modal windows are real app windows. Menus, shadows,
    // and other WindowServer surfaces alone are not evidence of an AX target.
    return accessibilityWindowFrames.contains { window in
        let x = abs(frame.minX - window.minX)
        let y = abs(frame.minY - window.minY)
        let width = abs(frame.width - window.width)
        let height = abs(frame.height - window.height)
        return x + y + width + height <= 4
    }
}
