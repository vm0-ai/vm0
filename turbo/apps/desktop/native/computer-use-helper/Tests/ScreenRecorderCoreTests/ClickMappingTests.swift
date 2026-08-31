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
