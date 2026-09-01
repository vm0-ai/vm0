import Testing

@testable import ScreenRecorderCore

/// A second display sitting to the right of and above the primary one, so a
/// policy that confuses global and display-local coordinates fails visibly.
private let secondaryDisplay = AreaRect(x: 1512, y: -200, width: 1000, height: 500)

struct CaptureAreaTests {
    @Test
    func keepsAnAreaThatFitsInsideTheDisplay() {
        let requested = AreaRect(x: 1600, y: -100, width: 400, height: 300)

        #expect(
            CaptureAreaPolicy.clamp(requested, toDisplay: secondaryDisplay) == requested
        )
    }

    @Test
    func confinesASelectionDraggedPastTheEdges() {
        // Dragged off the top-left and past the bottom-right of the display.
        let requested = AreaRect(x: 1000, y: -400, width: 2000, height: 1200)

        #expect(
            CaptureAreaPolicy.clamp(requested, toDisplay: secondaryDisplay)
                == AreaRect(x: 1512, y: -200, width: 1000, height: 500)
        )
    }

    @Test
    func rejectsASelectionOnADifferentDisplay() {
        let requested = AreaRect(x: 0, y: 0, width: 400, height: 300)

        #expect(CaptureAreaPolicy.clamp(requested, toDisplay: secondaryDisplay) == nil)
    }

    @Test
    func rejectsASelectionTooThinToEncode() {
        // A stray click rather than a drag.
        let sliver = AreaRect(x: 1600, y: -100, width: 1, height: 300)

        #expect(CaptureAreaPolicy.clamp(sliver, toDisplay: secondaryDisplay) == nil)
        #expect(
            CaptureAreaPolicy.clamp(
                AreaRect(x: 1600, y: -100, width: 300, height: 0),
                toDisplay: secondaryDisplay
            ) == nil
        )
    }

    @Test
    func rejectsASelectionThatOnlyTouchesTheDisplayEdge() {
        // Sharing exactly one edge leaves nothing to capture.
        let touching = AreaRect(x: 1112, y: -100, width: 400, height: 300)

        #expect(CaptureAreaPolicy.clamp(touching, toDisplay: secondaryDisplay) == nil)
    }

    /// `sourceRect` is read in the display's own space, so the display origin
    /// has to come back out of the global coordinates.
    @Test
    func rebasesTheAreaOntoTheDisplayOrigin() {
        let area = AreaRect(x: 1600, y: -100, width: 400, height: 300)

        #expect(
            CaptureAreaPolicy.relativeToDisplay(area, display: secondaryDisplay)
                == AreaRect(x: 88, y: 100, width: 400, height: 300)
        )
    }

    @Test
    func leavesAnAreaOnThePrimaryDisplayWhereItIs() {
        let primary = AreaRect(x: 0, y: 0, width: 1512, height: 982)
        let area = AreaRect(x: 100, y: 200, width: 400, height: 300)

        #expect(CaptureAreaPolicy.relativeToDisplay(area, display: primary) == area)
    }

    /// The clamped area feeds `CaptureGeometry` directly, so a click inside the
    /// selection has to land inside the cropped frame.
    @Test
    func clampedAreaMapsClicksIntoTheCroppedFrame() {
        let area = AreaRect(x: 1600, y: -100, width: 400, height: 200)
        let geometry = CaptureGeometry(
            originX: area.x,
            originY: area.y,
            widthPoints: area.width,
            heightPoints: area.height,
            scale: 2
        )
        let outputSize = CaptureSizePolicy.outputSize(for: geometry)

        let centre = geometry.mapClick(screenX: 1800, screenY: 0, outputSize: outputSize)

        #expect(centre?.normalizedX == 0.5)
        #expect(centre?.normalizedY == 0.5)
        // A click on the display but outside the selection is not in the video.
        #expect(
            geometry.mapClick(screenX: 1550, screenY: 0, outputSize: outputSize) == nil
        )
    }
}
