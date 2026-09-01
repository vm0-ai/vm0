import Testing

@testable import ScreenRecorderCore

struct StreamStopReasonTests {
    private let domain = StreamStopClassifier.streamErrorDomain

    @Test
    func treatsTheUserEndingTheShareAsAnOrdinaryFinish() {
        #expect(
            StreamStopClassifier.classify(
                domain: domain,
                code: StreamStopClassifier.userStoppedErrorCode
            ) == .userStopped
        )
    }

    @Test
    func treatsEveryOtherStreamErrorAsAFault() {
        // A closed window or an unplugged display arrives in the same domain
        // with a different code, and must not be reported as a clean finish.
        #expect(StreamStopClassifier.classify(domain: domain, code: -3801) == .failed)
        #expect(StreamStopClassifier.classify(domain: domain, code: 0) == .failed)
    }

    @Test
    func doesNotTrustTheCodeFromAnotherErrorDomain() {
        // -3817 means something else entirely outside ScreenCaptureKit, so the
        // domain has to match before the code is believed.
        #expect(
            StreamStopClassifier.classify(
                domain: "NSOSStatusErrorDomain",
                code: StreamStopClassifier.userStoppedErrorCode
            ) == .failed
        )
        #expect(StreamStopClassifier.classify(domain: "", code: -3817) == .failed)
    }
}
