import Testing

@testable import ScreenRecorderCore

struct SampleTimingPolicyTests {
    @Test
    func writesTheFirstSampleOfATrackAtTheAnchor() {
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 0,
                pauses: PauseTimeline(),
                lastWrittenSeconds: nil
            ) == 0
        )
    }

    @Test
    func dropsSamplesStampedBeforeTheAnchorFrame() {
        // Audio can arrive stamped earlier than the video frame the session
        // was anchored on. Folding those onto the anchor gave the audio track
        // several samples at the same instant, which the writer refused — and
        // then refused everything after them.
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: -0.02,
                pauses: PauseTimeline(),
                lastWrittenSeconds: nil
            ) == nil
        )
    }

    @Test
    func refusesASampleThatDoesNotAdvanceItsTrack() {
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 1.0,
                pauses: PauseTimeline(),
                lastWrittenSeconds: 1.0
            ) == nil
        )
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 0.9,
                pauses: PauseTimeline(),
                lastWrittenSeconds: 1.0
            ) == nil
        )
    }

    @Test
    func admitsASampleLaterThanTheLastWritten() {
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 1.05,
                pauses: PauseTimeline(),
                lastWrittenSeconds: 1.0
            ) == 1.05
        )
    }

    @Test
    func refusesAnAudioBufferThatOverlapsThePreviousOne() {
        // The previous buffer ran from 6.04s to 6.06s. A buffer that starts at
        // 6.05s overlaps it, which the writer refuses; one that starts exactly
        // where it ended, or later, is fine.
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 6.05,
                pauses: PauseTimeline(),
                lastWrittenSeconds: 6.04,
                lastWrittenEndSeconds: 6.06
            ) == nil
        )
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 6.06,
                pauses: PauseTimeline(),
                lastWrittenSeconds: 6.04,
                lastWrittenEndSeconds: 6.06
            ) == 6.06
        )
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 6.5,
                pauses: PauseTimeline(),
                lastWrittenSeconds: 6.04,
                lastWrittenEndSeconds: 6.06
            ) == 6.5
        )
    }

    @Test
    func toleratesFloatingPointDriftAtTheBoundary() {
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 6.06 - 0.000_000_1,
                pauses: PauseTimeline(),
                lastWrittenSeconds: 6.04,
                lastWrittenEndSeconds: 6.06
            ) != nil
        )
    }

    @Test
    func stillTakesThePausedStretchBackOut() {
        var pauses = PauseTimeline()
        pauses.pause(at: 2)
        pauses.resume(at: 5)

        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 3,
                pauses: pauses,
                lastWrittenSeconds: 2
            ) == nil
        )
        #expect(
            SampleTimingPolicy.mediaTime(
                captureSeconds: 6,
                pauses: pauses,
                lastWrittenSeconds: 2
            ) == 3
        )
    }
}
