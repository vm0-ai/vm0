import Testing

@testable import ScreenRecorderCore

struct PauseTimelineTests {
    private func timeline(pausedFrom start: Double, to end: Double) -> PauseTimeline {
        var timeline = PauseTimeline()
        timeline.pause(at: start)
        timeline.resume(at: end)
        return timeline
    }

    @Test
    func leavesAnUninterruptedRecordingAlone() {
        let timeline = PauseTimeline()

        #expect(timeline.mediaTime(forCaptureTime: 0) == 0)
        #expect(timeline.mediaTime(forCaptureTime: 12.5) == 12.5)
        #expect(!timeline.isPaused)
    }

    /// Without this the movie freezes for exactly as long as the pause lasted.
    @Test
    func takesThePausedStretchBackOutOfLaterTimes() {
        let timeline = timeline(pausedFrom: 10, to: 15)

        #expect(timeline.mediaTime(forCaptureTime: 9) == 9)
        #expect(timeline.mediaTime(forCaptureTime: 15) == 10)
        #expect(timeline.mediaTime(forCaptureTime: 20) == 15)
    }

    @Test
    func placesNothingInsideAPause() {
        let timeline = timeline(pausedFrom: 10, to: 15)

        #expect(timeline.mediaTime(forCaptureTime: 10) == nil)
        #expect(timeline.mediaTime(forCaptureTime: 12) == nil)
    }

    @Test
    func keepsSubtractingAcrossSeveralPauses() {
        var timeline = PauseTimeline()
        timeline.pause(at: 10)
        timeline.resume(at: 15)
        timeline.pause(at: 30)
        timeline.resume(at: 34)

        // 40 seconds of wall clock minus 9 seconds paused.
        #expect(timeline.mediaTime(forCaptureTime: 40) == 31)
    }

    @Test
    func reportsNothingWhileStillPaused() {
        var timeline = PauseTimeline()
        timeline.pause(at: 10)

        #expect(timeline.isPaused)
        #expect(timeline.mediaTime(forCaptureTime: 12) == nil)
    }

    @Test
    func stoppingDuringAPauseKeepsOnlyRecordedTime() {
        var timeline = PauseTimeline()
        timeline.pause(at: 2)
        timeline.resume(at: 5)
        timeline.pause(at: 10)

        #expect(timeline.pausedSecondsBefore(1) == 0)
        #expect(10 - timeline.pausedSecondsBefore(10) == 7)
        #expect(16 - timeline.pausedSecondsBefore(16) == 7)
        #expect(timeline.mediaTime(forCaptureTime: 16) == nil)
        timeline.resume(at: 20)
        #expect(timeline.mediaTime(forCaptureTime: 22) == 9)
    }

    /// A repeated pause must not open a second span, or the same stretch would
    /// be subtracted twice and later frames would land before earlier ones.
    @Test
    func ignoresARepeatedPause() {
        var timeline = PauseTimeline()
        timeline.pause(at: 10)
        timeline.pause(at: 12)
        timeline.resume(at: 15)

        #expect(timeline.mediaTime(forCaptureTime: 20) == 15)
    }

    @Test
    func ignoresAResumeThatWasNotPaused() {
        var timeline = PauseTimeline()
        timeline.resume(at: 10)

        #expect(!timeline.isPaused)
        #expect(timeline.mediaTime(forCaptureTime: 20) == 20)
    }

    @Test
    func neverLetsTimeRunBackwardsOnAnOutOfOrderResume() {
        var timeline = PauseTimeline()
        timeline.pause(at: 10)
        timeline.resume(at: 8)

        #expect(!timeline.isPaused)
        #expect(timeline.mediaTime(forCaptureTime: 20) == 20)
    }
}
