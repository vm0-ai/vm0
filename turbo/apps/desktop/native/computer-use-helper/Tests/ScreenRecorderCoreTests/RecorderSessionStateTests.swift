import Testing

@testable import ScreenRecorderCore

struct RecorderSessionStateTests {
    @Test
    func runsThroughTheHappyPath() {
        #expect(
            RecorderTransitionPolicy.next(from: .ready, command: .start)
                == .success(.recording)
        )
        #expect(
            RecorderTransitionPolicy.next(from: .recording, command: .pause)
                == .success(.paused)
        )
        #expect(
            RecorderTransitionPolicy.next(from: .paused, command: .resume)
                == .success(.recording)
        )
        #expect(
            RecorderTransitionPolicy.next(from: .recording, command: .stop)
                == .success(.stopped)
        )
    }

    @Test
    func stopsAPausedSessionWithoutResumingFirst() {
        #expect(
            RecorderTransitionPolicy.next(from: .paused, command: .stop)
                == .success(.stopped)
        )
    }

    @Test
    func rejectsStartingTwice() {
        let result = RecorderTransitionPolicy.next(from: .recording, command: .start)

        guard case .failure(let failure) = result else {
            Issue.record("expected a rejected transition")
            return
        }
        #expect(failure.code == "invalid_state")
        #expect(failure.message == "Cannot start a screen recording that is recording")
    }

    @Test
    func rejectsEveryCommandOnATerminalSession() {
        for state in [RecorderSessionState.stopped, RecorderSessionState.failed] {
            for command in [
                RecorderCommand.start, .pause, .resume, .stop,
            ] {
                guard
                    case .failure = RecorderTransitionPolicy.next(
                        from: state,
                        command: command
                    )
                else {
                    Issue.record("expected \(command.rawValue) to fail from \(state.rawValue)")
                    continue
                }
            }
            #expect(RecorderTransitionPolicy.isTerminal(state))
        }
    }

    @Test
    func treatsLiveSessionsAsNonTerminal() {
        #expect(!RecorderTransitionPolicy.isTerminal(.ready))
        #expect(!RecorderTransitionPolicy.isTerminal(.recording))
        #expect(!RecorderTransitionPolicy.isTerminal(.paused))
    }
}
