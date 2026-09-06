import Foundation
import CoreGraphics

public struct AccessibilityWindowMetadata: Sendable {
    public let title: String?
    public let frame: CGRect?

    public init(title: String?, frame: CGRect?) {
        self.title = title
        self.frame = frame
    }
}

/// Name the captured window, never an unrelated first AX window or floating panel.
public func capturedWindowName(
    title: String?,
    frame: CGRect,
    accessibilityWindows: [AccessibilityWindowMetadata],
    appName: String
) -> String {
    func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }

    if let title = nonEmpty(title) { return title }

    let matching = accessibilityWindows.filter { window in
        guard let candidate = window.frame, candidate.width > 0, candidate.height > 0 else {
            return false
        }
        let distance = abs(candidate.minX - frame.minX) + abs(candidate.minY - frame.minY)
            + abs(candidate.width - frame.width) + abs(candidate.height - frame.height)
        return distance <= 4
    }
    if matching.count == 1, let title = nonEmpty(matching[0].title) {
        return title
    }
    return appName
}
