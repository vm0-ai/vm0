import CoreGraphics
import Testing

@testable import ComputerUseHelperCore

struct WindowVisibilityPolicyTests {
    private let target = VisualPointerTargetWindow(
        windowNumber: 10,
        ownerPID: 100,
        frame: CGRect(x: 50, y: 50, width: 400, height: 300)
    )

    @Test
    func showsPointerWhenTargetWindowIsTopmostAtPoint() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func hidesPointerWhenAnotherAppCoversTheTargetPoint() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 20,
                ownerPID: 200,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: true,
                alpha: 1
            ),
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(!shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func showsPointerWhenSameAppAuxiliaryWindowCoversTheTargetPoint() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 11,
                ownerPID: 100,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: true,
                alpha: 1
            ),
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func ignoresTransparentOrOffscreenCoveringWindows() {
        let point = CGPoint(x: 120, y: 140)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 20,
                ownerPID: 200,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: true,
                alpha: 0
            ),
            VisualPointerStackWindow(
                windowNumber: 21,
                ownerPID: 201,
                frame: CGRect(x: 100, y: 100, width: 300, height: 200),
                isOnScreen: false,
                alpha: 1
            ),
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func hidesPointerWhenPointIsOutsideTargetFrame() {
        let point = CGPoint(x: 500, y: 500)
        let stack = [
            VisualPointerStackWindow(
                windowNumber: 10,
                ownerPID: 100,
                frame: CGRect(x: 50, y: 50, width: 400, height: 300),
                isOnScreen: true,
                alpha: 1
            ),
        ]

        #expect(!shouldShowVisualPointer(target: target, point: point, windowStack: stack))
    }

    @Test
    func acceptsAXBackedFloatingAndModalWindows() {
        let frame = CGRect(x: 100, y: 200, width: 268, height: 60)
        for layer in [3, 8] {
            #expect(isControllableWindowLayer(layer, frame: frame, accessibilityWindowFrames: [frame]))
        }
        #expect(isControllableWindowLayer(0, frame: frame, accessibilityWindowFrames: []))
    }

    @Test
    func excludesUnmatchedElevatedSurfacesAndDesktopLayers() {
        let frame = CGRect(x: 100, y: 200, width: 268, height: 60)
        #expect(!isControllableWindowLayer(3, frame: frame, accessibilityWindowFrames: []))
        #expect(!isControllableWindowLayer(24, frame: frame, accessibilityWindowFrames: [
            CGRect(x: 0, y: 0, width: 640, height: 480)
        ]))
        #expect(!isControllableWindowLayer(-1, frame: frame, accessibilityWindowFrames: [frame]))
    }

    @Test
    func matchesPanelGeometryWithBoundedAXRoundingTolerance() {
        let frame = CGRect(x: 100, y: 200, width: 268, height: 60)
        #expect(isControllableWindowLayer(3, frame: frame, accessibilityWindowFrames: [
            CGRect(x: 101, y: 201, width: 267, height: 59)
        ]))
        #expect(!isControllableWindowLayer(3, frame: frame, accessibilityWindowFrames: [
            CGRect(x: 102, y: 202, width: 267, height: 59)
        ]))
    }
}
