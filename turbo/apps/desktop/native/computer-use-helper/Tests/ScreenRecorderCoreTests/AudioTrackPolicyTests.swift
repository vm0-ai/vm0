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
        #expect(plan.microphoneUnavailableReason == nil)
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
        #expect(plan.microphoneUnavailableReason == nil)
    }

    /// Silently dropping the microphone would hand back a recording that was
    /// meant to carry narration and does not.
    @Test
    func saysWhyWhenTheSystemCannotRecordTheMicrophone() {
        let plan = AudioTrackPolicy.plan(
            systemAudio: true,
            microphone: true,
            microphoneSupported: false
        )

        #expect(!plan.microphone)
        #expect(plan.systemAudio)
        #expect(
            plan.microphoneUnavailableReason
                == AudioTrackPolicy.microphoneRequiresNewerSystem
        )
    }

    @Test
    func staysQuietWhenNoMicrophoneWasAskedFor() {
        let plan = AudioTrackPolicy.plan(
            systemAudio: true,
            microphone: false,
            microphoneSupported: false
        )

        #expect(plan.microphoneUnavailableReason == nil)
    }
}
