import Testing

@testable import ScreenRecorderCore

struct RecordableWindowPolicyTests {
    @Test
    func offersAnOrdinaryApplicationWindow() {
        #expect(
            RecordableWindowPolicy.isRecordable(
                title: "Quarterly plan",
                windowLayer: RecordableWindowPolicy.applicationWindowLayer
            )
        )
    }

    @Test
    func refusesTheSystemSurfacesThatFloatAboveWindows() {
        // Reading every Space brings menu bar extras and the Dock along with the
        // real windows. One Mac listed a dozen of them, titled after their
        // owning process, ahead of any document.
        #expect(
            !RecordableWindowPolicy.isRecordable(title: "Menubar", windowLayer: 25)
        )
        #expect(
            !RecordableWindowPolicy.isRecordable(title: "StatusIndicator", windowLayer: 25)
        )
        #expect(!RecordableWindowPolicy.isRecordable(title: "Dock", windowLayer: 20))
    }

    @Test
    func refusesAWindowThePickerCouldNotLabel() {
        #expect(
            !RecordableWindowPolicy.isRecordable(
                title: nil,
                windowLayer: RecordableWindowPolicy.applicationWindowLayer
            )
        )
        #expect(
            !RecordableWindowPolicy.isRecordable(
                title: "",
                windowLayer: RecordableWindowPolicy.applicationWindowLayer
            )
        )
    }
}
