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
    /// A first frame stamped 57 hours after boot, which is what both
    /// `CGEvent.timestamp` and the host clock count from.
    private let timeline = ClickTimeline(startNanoseconds: 207_760_000_000_000)

    /// `CGEvent.timestamp` is already nanoseconds. Treating it as raw mach ticks
    /// and applying the 125/3 Apple silicon timebase multiplied every offset by
    /// ~41.7, so this click 2.2 s into a 23 s recording came out 97 days in and
    /// no downstream consumer could find a single click inside the video.
    @Test
    func placesAClickAtItsOffsetInPlainNanoseconds() {
        #expect(timeline.offsetMilliseconds(atNanoseconds: 207_762_200_000_000) == 2_200)
    }

    @Test
    func reportsZeroAtTheStartOfTheRecording() {
        #expect(timeline.offsetMilliseconds(atNanoseconds: 207_760_000_000_000) == 0)
    }

    @Test
    func dropsEventsThatPredateTheRecording() {
        #expect(timeline.offsetMilliseconds(atNanoseconds: 207_759_999_999_999) == nil)
    }

    @Test
    func roundsToTheNearestMillisecond() {
        #expect(timeline.offsetMilliseconds(atNanoseconds: 207_760_001_500_000) == 2)
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

    private func click(nanoseconds: UInt64, x: Double, y: Double) -> CapturedClick {
        return CapturedClick(
            nanoseconds: nanoseconds,
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
            [click(nanoseconds: 2_024_000, x: 500, y: 250)],
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
            [click(nanoseconds: 1_000, x: 500, y: 250)],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(projection.clicks.isEmpty)
        #expect(projection.droppedOutOfFrame == 0)
    }

    @Test
    func projectsAClickThroughTheGeometryOfItsOwnMoment() {
        // The window was dragged 100 points right and down before this click.
        // Projected through the recording's original geometry the click would
        // land at (0.6, 0.7) — the wrong place in a video that followed the
        // window; through the geometry captured with it, it lands where the
        // user actually clicked.
        let moved = CaptureGeometry(
            originX: 100,
            originY: 100,
            widthPoints: 1000,
            heightPoints: 500,
            scale: 2
        )
        let projection = projectClicks(
            [
                CapturedClick(
                    nanoseconds: 2_024_000,
                    screenX: 600,
                    screenY: 350,
                    button: "left",
                    clickCount: 1,
                    modifiers: [],
                    geometry: moved
                )
            ],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(projection.droppedOutOfFrame == 0)
        #expect(projection.clicks.first?.point.normalizedX == 0.5)
        #expect(projection.clicks.first?.point.normalizedY == 0.5)
        #expect(projection.clicks.first?.point.frameX == 960)
        #expect(projection.clicks.first?.point.frameY == 480)
    }

    @Test
    func countsClicksThatLandedOutsideTheCapturedRegion() {
        let projection = projectClicks(
            [click(nanoseconds: 2_024_000, x: 1_500, y: 250)],
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
                click(nanoseconds: 1_000, x: 500, y: 250),
                click(nanoseconds: 2_024_000, x: 1_500, y: 250),
                click(nanoseconds: 3_024_000, x: 500, y: 250),
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

struct PointerTrailPolicyTests {
    private let policy = PointerTrailPolicy()

    @Test
    func keepsTheFirstSample() {
        #expect(policy.shouldKeep(x: 10, y: 10, previous: nil))
    }

    /// The sampler runs thirty times a second whether or not the mouse moved;
    /// a resting pointer would otherwise fill the track with copies.
    @Test
    func skipsAPointerThatHasNotMoved() {
        let previous = CapturedPointerSample(nanoseconds: 1, screenX: 10, screenY: 10)

        #expect(!policy.shouldKeep(x: 10.2, y: 9.9, previous: previous))
    }

    @Test
    func keepsAPointerThatMoved() {
        let previous = CapturedPointerSample(nanoseconds: 1, screenX: 10, screenY: 10)

        #expect(policy.shouldKeep(x: 11, y: 10, previous: previous))
        #expect(policy.shouldKeep(x: 10, y: 9, previous: previous))
    }
}

struct PointerSampleProjectionTests {
    private let display = CaptureGeometry(
        originX: 0,
        originY: 0,
        widthPoints: 1000,
        heightPoints: 500,
        scale: 2
    )
    private let outputSize = OutputSize(width: 1920, height: 960)
    private let timeline = ClickTimeline(startNanoseconds: 24_000)

    @Test
    func placesASampleAtItsOffsetAndPosition() {
        let trail = projectPointerSamples(
            [CapturedPointerSample(nanoseconds: 2_024_000, screenX: 500, screenY: 250)],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(trail.count == 1)
        #expect(trail.first?.offsetMs == 2)
        #expect(trail.first?.point.frameX == 960)
        #expect(trail.first?.point.frameY == 480)
        #expect(trail.first?.point.normalizedX == 0.5)
    }

    /// The sampler starts with the tap, before `SCStream` delivers a frame.
    @Test
    func dropsSamplesFromBeforeTheFirstFrame() {
        let trail = projectPointerSamples(
            [CapturedPointerSample(nanoseconds: 1_000, screenX: 500, screenY: 250)],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(trail.isEmpty)
    }

    @Test
    func dropsSamplesOutsideTheCapturedRegion() {
        let trail = projectPointerSamples(
            [CapturedPointerSample(nanoseconds: 2_024_000, screenX: 1_500, screenY: 250)],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(trail.isEmpty)
    }

    @Test
    func projectsASampleThroughTheGeometryOfItsOwnMoment() {
        let moved = CaptureGeometry(
            originX: 100,
            originY: 100,
            widthPoints: 1000,
            heightPoints: 500,
            scale: 2
        )
        let trail = projectPointerSamples(
            [
                CapturedPointerSample(
                    nanoseconds: 2_024_000,
                    screenX: 600,
                    screenY: 350,
                    geometry: moved
                )
            ],
            timeline: timeline,
            geometry: display,
            outputSize: outputSize
        )

        #expect(trail.first?.point.normalizedX == 0.5)
        #expect(trail.first?.point.normalizedY == 0.5)
    }
}

struct TypingBurstTests {
    @Test
    func groupsKeyDownsCloserThanTheGapIntoOneBurst() {
        let bursts = typingBursts(fromKeyDownOffsetsMs: [1_000, 1_150, 1_400, 1_900])

        #expect(bursts == [TypingBurst(startMs: 1_000, endMs: 1_900)])
    }

    @Test
    func splitsAtAGapLongerThanTheLimit() {
        let bursts = typingBursts(fromKeyDownOffsetsMs: [1_000, 1_200, 2_100, 2_300])

        #expect(bursts == [
            TypingBurst(startMs: 1_000, endMs: 1_200),
            TypingBurst(startMs: 2_100, endMs: 2_300),
        ])
    }

    /// A shortcut is one key-down: a burst of length zero, which a camera can
    /// tell apart from typing without knowing which key it was.
    @Test
    func reportsALoneKeyDownAsAZeroLengthBurst() {
        #expect(typingBursts(fromKeyDownOffsetsMs: [5_000]) == [TypingBurst(startMs: 5_000, endMs: 5_000)])
    }

    @Test
    func ordersKeyDownsBeforeGrouping() {
        let bursts = typingBursts(fromKeyDownOffsetsMs: [1_400, 1_000, 1_150])

        #expect(bursts == [TypingBurst(startMs: 1_000, endMs: 1_400)])
    }

    @Test
    func reportsNothingWithoutKeyDowns() {
        #expect(typingBursts(fromKeyDownOffsetsMs: []).isEmpty)
    }
}
