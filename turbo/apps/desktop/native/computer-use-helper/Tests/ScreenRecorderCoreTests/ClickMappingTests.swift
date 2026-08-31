import Testing

@testable import ScreenRecorderCore

private let secondaryDisplay = CaptureGeometry(
    originX: 1512,
    originY: -200,
    widthPoints: 1000,
    heightPoints: 500,
    scale: 2
)

struct ClickMappingTests {
    @Test
    func mapsAClickOnASecondDisplayWithANegativeOrigin() {
        let mapped = secondaryDisplay.mapClick(
            screenX: 2012,
            screenY: 50,
            outputSize: OutputSize(width: 1920, height: 960)
        )

        #expect(mapped?.normalizedX == 0.5)
        #expect(mapped?.normalizedY == 0.5)
        #expect(mapped?.frameX == 960)
        #expect(mapped?.frameY == 480)
        // The raw screen position survives the mapping unchanged.
        #expect(mapped?.screenX == 2012)
        #expect(mapped?.screenY == 50)
    }

    @Test
    func mapsTheTopLeftCornerToTheFrameOrigin() {
        let mapped = secondaryDisplay.mapClick(
            screenX: 1512,
            screenY: -200,
            outputSize: OutputSize(width: 1920, height: 960)
        )

        #expect(mapped?.frameX == 0)
        #expect(mapped?.frameY == 0)
    }

    @Test
    func dropsClicksOutsideTheCapturedRegion() {
        let outputSize = OutputSize(width: 1920, height: 960)

        // Left of, above, right of, and below the captured region.
        #expect(
            secondaryDisplay.mapClick(screenX: 1511, screenY: 0, outputSize: outputSize)
                == nil
        )
        #expect(
            secondaryDisplay.mapClick(screenX: 1600, screenY: -201, outputSize: outputSize)
                == nil
        )
        #expect(
            secondaryDisplay.mapClick(screenX: 2512, screenY: 0, outputSize: outputSize)
                == nil
        )
        #expect(
            secondaryDisplay.mapClick(screenX: 1600, screenY: 300, outputSize: outputSize)
                == nil
        )
    }

    @Test
    func treatsTheFarEdgeAsOutsideSoTheFrameIndexStaysInBounds() {
        let outputSize = OutputSize(width: 1920, height: 960)

        // A click exactly on the right/bottom edge would map to frame index
        // 1920/960, which is one past the last addressable pixel.
        #expect(
            secondaryDisplay.mapClick(screenX: 2512, screenY: 50, outputSize: outputSize)
                == nil
        )
        let inside = secondaryDisplay.mapClick(
            screenX: 2511.9,
            screenY: 299.9,
            outputSize: outputSize
        )
        #expect(inside != nil)
        #expect((inside?.frameX ?? 0) < outputSize.width)
        #expect((inside?.frameY ?? 0) < outputSize.height)
    }

    @Test
    func dropsClicksWhenTheCapturedRegionIsDegenerate() {
        let empty = CaptureGeometry(
            originX: 0,
            originY: 0,
            widthPoints: 0,
            heightPoints: 0,
            scale: 2
        )

        #expect(
            empty.mapClick(screenX: 0, screenY: 0, outputSize: OutputSize(width: 2, height: 2))
                == nil
        )
    }
}

struct ClickTimelineTests {
    /// Apple silicon reports 125/3 nanoseconds per tick rather than 1/1, so a
    /// timeline that ignores the ratio is wrong by ~40x on those machines.
    private let appleSilicon = ClickTimeline(
        startTicks: 1_000,
        timebaseNumerator: 125,
        timebaseDenominator: 3
    )

    @Test
    func convertsTicksToMillisecondsUsingTheTimebaseRatio() {
        // 24_000 ticks * 125/3 = 1_000_000ns = 1ms
        #expect(appleSilicon.offsetMilliseconds(atTicks: 25_000) == 1)
    }

    @Test
    func reportsZeroAtTheStartOfTheRecording() {
        #expect(appleSilicon.offsetMilliseconds(atTicks: 1_000) == 0)
    }

    @Test
    func dropsEventsThatPredateTheRecording() {
        #expect(appleSilicon.offsetMilliseconds(atTicks: 999) == nil)
    }

    @Test
    func handlesTheOneToOneTimebase() {
        let intel = ClickTimeline(
            startTicks: 0,
            timebaseNumerator: 1,
            timebaseDenominator: 1
        )

        #expect(intel.offsetMilliseconds(atTicks: 2_000_000) == 2)
    }

    @Test
    func neverDividesByAZeroDenominator() {
        let degenerate = ClickTimeline(
            startTicks: 0,
            timebaseNumerator: 1,
            timebaseDenominator: 0
        )

        #expect(degenerate.timebaseDenominator == 1)
        #expect(degenerate.offsetMilliseconds(atTicks: 1_000_000) == 1)
    }
}

struct ClickProjectionTests {
    private let display = CaptureGeometry(
        originX: 0,
        originY: 0,
        widthPoints: 1000,
        heightPoints: 500,
        scale: 2
    )
    private let outputSize = OutputSize(width: 1920, height: 960)
    private let timeline = ClickTimeline(
        startTicks: 24_000,
        timebaseNumerator: 1,
        timebaseDenominator: 1
    )

    private func click(ticks: UInt64, x: Double, y: Double) -> CapturedClick {
        return CapturedClick(
            ticks: ticks,
            screenX: x,
            screenY: y,
            button: "left",
            clickCount: 1,
            modifiers: ["command"]
        )
    }

    @Test
    func projectsAClickThatLandedInsideTheRecording() {
        let projection = projectClicks(
            [click(ticks: 2_024_000, x: 500, y: 250)],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(projection.droppedOutOfFrame == 0)
        #expect(projection.clicks.count == 1)
        #expect(projection.clicks.first?.offsetMs == 2)
        #expect(projection.clicks.first?.button == "left")
        #expect(projection.clicks.first?.clickCount == 1)
        #expect(projection.clicks.first?.modifiers == ["command"])
        #expect(projection.clicks.first?.point.frameX == 960)
        #expect(projection.clicks.first?.point.frameY == 480)
    }

    /// The tap starts before `SCStream` delivers its first sample, so clicks
    /// during capture startup are routine. They are outside the recording
    /// rather than outside the frame, and reporting them as out-of-frame would
    /// claim the user clicked in an application that was never recorded.
    @Test
    func dropsClicksFromBeforeTheFirstFrameWithoutCountingThemOutOfFrame() {
        let projection = projectClicks(
            [click(ticks: 1_000, x: 500, y: 250)],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(projection.clicks.isEmpty)
        #expect(projection.droppedOutOfFrame == 0)
    }

    @Test
    func countsClicksThatLandedOutsideTheCapturedRegion() {
        let projection = projectClicks(
            [click(ticks: 2_024_000, x: 1_500, y: 250)],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(projection.clicks.isEmpty)
        #expect(projection.droppedOutOfFrame == 1)
    }

    @Test
    func separatesTheTwoDropReasonsInOneRecording() {
        let projection = projectClicks(
            [
                click(ticks: 1_000, x: 500, y: 250),
                click(ticks: 2_024_000, x: 1_500, y: 250),
                click(ticks: 3_024_000, x: 500, y: 250),
            ],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(projection.clicks.count == 1)
        #expect(projection.clicks.first?.offsetMs == 3)
        #expect(projection.droppedOutOfFrame == 1)
    }
}
