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
    /// A recording that started a little over two days into an uptime, the
    /// magnitudes a real capture actually produces.
    private let timeline = ClickTimeline(startNanoseconds: 196_584_887_536_968)

    /// `CGEvent.timestamp` is nanoseconds since startup, not raw mach ticks.
    /// Applying the mach timebase ratio on top of it scaled every offset by
    /// `numer/denom`, which is 1/1 on Intel and 125/3 on Apple silicon — so the
    /// mistake only ever corrupted Apple silicon captures, and by enough that a
    /// 21 second recording reported click offsets spanning 12 minutes.
    @Test
    func placesAnEventOnTheRecordingTimeline() {
        #expect(
            timeline.offsetMilliseconds(
                atNanoseconds: 196_584_890_536_968
            ) == 3_000
        )
    }

    @Test
    func reportsZeroAtTheStartOfTheRecording() {
        #expect(
            timeline.offsetMilliseconds(
                atNanoseconds: 196_584_887_536_968
            ) == 0
        )
    }

    @Test
    func dropsEventsThatPredateTheRecording() {
        #expect(
            timeline.offsetMilliseconds(
                atNanoseconds: 196_584_887_536_967
            ) == nil
        )
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
    private let timeline = ClickTimeline(startNanoseconds: 24_000)

    private func click(
        atNanoseconds nanoseconds: UInt64,
        x: Double,
        y: Double
    ) -> CapturedClick {
        return CapturedClick(
            timestampNanoseconds: nanoseconds,
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
            [click(atNanoseconds: 2_024_000, x: 500, y: 250)],
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
            [click(atNanoseconds: 1_000, x: 500, y: 250)],
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
            [click(atNanoseconds: 2_024_000, x: 1_500, y: 250)],
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
                click(atNanoseconds: 1_000, x: 500, y: 250),
                click(atNanoseconds: 2_024_000, x: 1_500, y: 250),
                click(atNanoseconds: 3_024_000, x: 500, y: 250),
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
