import CoreGraphics
import Testing

@testable import ComputerUseHelperCore

struct CapturedWindowMetadataTests {
    private let frame = CGRect(x: 240, y: 268, width: 640, height: 392)
    private let overlay = AccessibilityWindowMetadata(
        title: "Floating controls", frame: CGRect(x: 1000, y: 296, width: 240, height: 84)
    )

    @Test
    func capturedWindowTitleTakesPrecedenceOverFirstAccessibilityWindow() {
        #expect(capturedWindowName(
            title: "Captured document", frame: frame,
            accessibilityWindows: [overlay], appName: "Editor"
        ) == "Captured document")
    }

    @Test(arguments: [nil, "", " \n"] as [String?])
    func absentCaptureTitleUsesOnlyTheMatchingAccessibilityWindow(title: String?) {
        #expect(capturedWindowName(
            title: title, frame: frame,
            accessibilityWindows: [overlay, AccessibilityWindowMetadata(title: "Document", frame: frame)],
            appName: "Editor"
        ) == "Document")
    }

    @Test
    func missingBoundsOrAnotherWindowCannotSupplyTheCaptureName() {
        #expect(capturedWindowName(
            title: nil, frame: frame,
            accessibilityWindows: [overlay, AccessibilityWindowMetadata(title: "Unlocated", frame: nil)],
            appName: "Editor"
        ) == "Editor")
    }

    @Test
    func ambiguousBoundsDoNotGuessBetweenDifferentWindows() {
        #expect(capturedWindowName(
            title: nil, frame: frame,
            accessibilityWindows: [
                AccessibilityWindowMetadata(title: "First", frame: frame),
                AccessibilityWindowMetadata(title: "Second", frame: frame),
            ], appName: "Editor"
        ) == "Editor")
    }

    @Test
    func geometryToleranceDoesNotMatchMovedWindows() {
        let window = AccessibilityWindowMetadata(title: "Document", frame: frame.offsetBy(dx: 2, dy: 2))
        #expect(capturedWindowName(
            title: nil, frame: frame, accessibilityWindows: [window], appName: "Editor"
        ) == "Document")
        #expect(capturedWindowName(
            title: nil, frame: frame.offsetBy(dx: -1, dy: 0),
            accessibilityWindows: [window], appName: "Editor"
        ) == "Editor")
    }
}
