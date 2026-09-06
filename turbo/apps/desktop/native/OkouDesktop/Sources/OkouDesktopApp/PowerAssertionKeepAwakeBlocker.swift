#if canImport(AppKit)
import Foundation
import IOKit.pwr_mgt
import OkouDesktopKit

/// Electron's `prevent-display-sleep` power-save blocker as an IOKit
/// `PreventUserIdleDisplaySleep` assertion.
final class PowerAssertionKeepAwakeBlocker: KeepAwakeBlocker {
    private var assertions: [Int: IOPMAssertionID] = [:]
    private var nextId = 0

    func start() -> Int {
        var assertionId = IOPMAssertionID(0)
        let result = IOPMAssertionCreateWithName(
            kIOPMAssertPreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            "Okou keeps this Mac awake for Computer Use" as CFString,
            &assertionId
        )
        nextId += 1
        if result == kIOReturnSuccess {
            assertions[nextId] = assertionId
        }
        return nextId
    }

    func stop(_ id: Int) {
        guard let assertionId = assertions.removeValue(forKey: id) else { return }
        IOPMAssertionRelease(assertionId)
    }

    func isStarted(_ id: Int) -> Bool {
        assertions[id] != nil
    }
}
#endif
