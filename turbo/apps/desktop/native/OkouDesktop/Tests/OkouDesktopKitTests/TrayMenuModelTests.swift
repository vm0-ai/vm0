import XCTest

@testable import OkouDesktopKit

final class TrayMenuModelTests: XCTestCase {
    private var clicked: [String] = []

    private func actions() -> DesktopTrayMenuActions {
        DesktopTrayMenuActions(
            showMainWindow: { self.clicked.append("showMainWindow") },
            startComputerUse: { self.clicked.append("startComputerUse") },
            stopComputerUse: { self.clicked.append("stopComputerUse") },
            refreshStatus: { self.clicked.append("refreshStatus") },
            openSignIn: { self.clicked.append("openSignIn") },
            switchWorkspace: { self.clicked.append("switchWorkspace") },
            signOut: { self.clicked.append("signOut") },
            requestAccessibilityPermission: { self.clicked.append("requestAccessibilityPermission") },
            requestScreenRecordingPermission: { self.clicked.append("requestScreenRecordingPermission") },
            openAccessibilitySettings: { self.clicked.append("openAccessibilitySettings") },
            openScreenRecordingSettings: { self.clicked.append("openScreenRecordingSettings") },
            setKeepAwakeEnabled: { self.clicked.append("setKeepAwakeEnabled:\($0)") },
            startScreenRecording: { self.clicked.append("startScreenRecording") },
            stopScreenRecording: { self.clicked.append("stopScreenRecording") },
            retryScreenRecordingDelivery: { self.clicked.append("retryScreenRecordingDelivery") },
            quit: { self.clicked.append("quit") }
        )
    }

    private func computerUse(
        status: ComputerUseHostRuntimeStatus, permissions: ComputerUsePermissionState = ComputerUsePermissionState(accessibility: true, screenRecording: true),
        log: [ComputerUseLocalCommandLogEntry] = []
    ) -> DesktopComputerUseState {
        DesktopComputerUseState(
            platform: "darwin", supported: true, deviceName: "Mac", permissions: permissions,
            host: ComputerUseHostRuntimeState(status: status, localCommandLog: log),
            keepAwake: DesktopKeepAwakeState(enabled: false, active: false), plugins: nil
        )
    }

    private let signedIn = DesktopAuthState.signedIn(
        user: DesktopAuthUser(userId: "u", email: "ethan@okou.ai"),
        organization: DesktopAuthOrganization(id: "o", name: "Max & Zoe")
    )

    func testOnlineSignedInLabels() {
        let items = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online), auth: signedIn, authError: nil),
            actions: actions()
        )
        XCTAssertEqual(
            items.compactMap(\.label),
            ["Open Zero", "Workspace: Max & Zoe", "Computer Use: Online", "Keep Mac Awake", "No Recent Commands", "Quit"]
        )
        let computerUseMenu = items[3].submenu!
        XCTAssertEqual(computerUseMenu.compactMap(\.label), [
            "Status: Online", "Accessibility: Ready", "Accessibility Settings", "Screen Recording: Ready",
            "Screen Recording Settings", "Start Computer Use", "Stop Computer Use", "Refresh Status",
        ])
        XCTAssertEqual(computerUseMenu[7].enabled, false)
        XCTAssertEqual(computerUseMenu[8].enabled, true)
    }

    func testOkouBrandAndSignedOut() {
        let items = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(brandName: .okou, computerUse: computerUse(status: .offline), auth: .signedOut, authError: nil),
            actions: actions()
        )
        XCTAssertEqual(items[0].label, "Open Okou")
        XCTAssertEqual(items[1].label, "Sign in to Okou")
        XCTAssertEqual(items[1].submenu?.compactMap(\.label), ["Not signed in", "Sign in to Okou", "Refresh Account Status"])
        XCTAssertEqual(items[3].label, "Computer Use: Sign in required")
        items[1].submenu![1].click!()
        XCTAssertEqual(clicked, ["openSignIn"])
    }

    func testMissingPermissionsShortCircuits() {
        let items = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(
                computerUse: computerUse(status: .offline, permissions: ComputerUsePermissionState(accessibility: false, screenRecording: true)),
                auth: signedIn, authError: nil
            ),
            actions: actions()
        )
        XCTAssertEqual(items[3].label, "Computer Use: Needs permissions")
        XCTAssertEqual(items[3].submenu?.compactMap(\.label), [
            "Status: Needs permissions", "Request Accessibility Permission", "Accessibility Settings",
            "Screen Recording: Ready", "Screen Recording Settings", "Refresh Status",
        ])
    }

    func testRecentCommandsAndKeepAwake() {
        let entry = ComputerUseLocalCommandLogEntry(
            commandId: "c", kind: "command-0", app: "App 0", status: .succeeded, payload: [:], result: nil, error: nil,
            startedAt: "2026-06-09T10:00:00.000Z", completedAt: "2026-06-09T10:00:01.000Z", durationMs: 1000
        )
        let now = ISOTimestamp.date(from: "2027-01-01T00:00:00.000Z")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let items = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online, log: [entry]), auth: signedIn, authError: nil),
            actions: actions(), now: now
        )
        XCTAssertEqual(
            DesktopTrayMenu.formatTrayTimestamp(entry.completedAt, now: now, calendar: calendar),
            "2026/06/09"
        )
        XCTAssertTrue(items.contains { $0.label == "Recent Commands" })
        XCTAssertTrue(items.contains { $0.label?.hasSuffix(" - App 0 - command-0 - Succeeded") == true })
        items[4].click!()
        XCTAssertEqual(clicked, ["setKeepAwakeEnabled:true"])
        XCTAssertEqual(
            DesktopTrayMenu.formatTrayTimestamp("2026-06-09T10:05:00.000Z", now: ISOTimestamp.date(from: "2026-06-09T22:00:00.000Z")!, calendar: calendar),
            "10:05"
        )
        XCTAssertEqual(
            DesktopTrayMenu.formatTrayTimestamp("2026-06-09T10:05:00.000Z", now: ISOTimestamp.date(from: "2026-07-09T22:00:00.000Z")!, calendar: calendar),
            "06/09"
        )
        XCTAssertEqual(DesktopTrayMenu.formatTrayTimestamp(nil), "running")
    }

    func testScreenRecordingSection() {
        let recording = DesktopRecorderState(
            available: true, status: .recording, sessionId: "s", elapsedMs: 65_000, error: nil, lastRecording: nil
        )
        let items = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online), auth: signedIn, authError: nil, recorder: recording),
            actions: actions()
        )
        XCTAssertEqual(items[5].label, "Screen Recording: 01:05")
        XCTAssertEqual(items[5].submenu?.first?.label, "Stop Recording (⌃⇧R)")

        let failed = DesktopRecorderState(
            available: true, status: .idle, sessionId: nil, elapsedMs: 0,
            error: DesktopRecorderError(code: .deliveryFailed, message: String(repeating: "x", count: 100)),
            lastRecording: DesktopRecorderRecording(videoPath: "/v", clickTrackPath: "/c", durationMs: 1, sizeBytes: 1, width: 1, height: 1, failure: nil)
        )
        let failedItems = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online), auth: signedIn, authError: nil, recorder: failed),
            actions: actions()
        )
        let submenu = failedItems[5].submenu!
        XCTAssertEqual(failedItems[5].label, "Screen Recording: Failed")
        XCTAssertEqual(submenu.compactMap(\.label), ["New Recording...", String(repeating: "x", count: 87) + "...", "Retry Delivery"])

        let signedOutError = DesktopRecorderState(
            available: true, status: .idle, sessionId: nil, elapsedMs: 0,
            error: DesktopRecorderError(code: .signedOut, message: "Sign in"), lastRecording: failed.lastRecording
        )
        let signedOutItems = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online), auth: signedIn, authError: nil, recorder: signedOutError),
            actions: actions()
        )
        XCTAssertFalse(signedOutItems[5].submenu!.contains { $0.label == "Retry Delivery" })
        XCTAssertEqual(DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online), auth: signedIn, authError: nil, recorder: .unavailable),
            actions: actions()
        ).compactMap(\.label).count, 6)
    }

    func testSignatureIgnoresClosures() {
        let a = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online), auth: signedIn, authError: nil), actions: actions()
        )
        let b = DesktopTrayMenu.buildItems(
            DesktopTrayMenuState(computerUse: computerUse(status: .online), auth: signedIn, authError: nil), actions: actions()
        )
        XCTAssertEqual(JSONValue.array(a.map(\.signature)).serialized(), JSONValue.array(b.map(\.signature)).serialized())
    }
}
