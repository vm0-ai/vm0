import Testing

@testable import ScreenRecorderCore

struct AudioTrackPolicyTests {
    @Test
    func keepsSystemAudioAndMicrophoneOnSeparateTracks() {
        let plan = AudioTrackPolicy.plan(
            systemAudio: true,
            microphone: true,
            microphoneSupported: true
        )

        // Two tracks, not one mixed track: mixing cannot be undone later.
        #expect(plan.systemAudio)
        #expect(plan.microphone)
        #expect(plan.trackCount == 2)
    }

    @Test
    func recordsNarrationAloneWhenSystemAudioIsOff() {
        let plan = AudioTrackPolicy.plan(
            systemAudio: false,
            microphone: true,
            microphoneSupported: true
        )

        #expect(!plan.systemAudio)
        #expect(plan.microphone)
        #expect(plan.trackCount == 1)
    }

    @Test
    func writesNoAudioTrackWhenNeitherIsWanted() {
        let plan = AudioTrackPolicy.plan(
            systemAudio: false,
            microphone: false,
            microphoneSupported: true
        )

        #expect(plan.trackCount == 0)
    }

    /// Opening a microphone track the system cannot fill would leave the
    /// recording carrying a silent second track.
    @Test
    func writesNoMicrophoneTrackOnAnOlderSystem() {
        let plan = AudioTrackPolicy.plan(
            systemAudio: true,
            microphone: true,
            microphoneSupported: false
        )

        #expect(!plan.microphone)
        #expect(plan.systemAudio)
        #expect(plan.trackCount == 1)
    }
}
