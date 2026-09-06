import XCTest

@testable import OkouDesktopKit

final class CoreLogicTests: XCTestCase {
    func testJSONRoundTrip() throws {
        let text = #"{"a":[1,2.5,-3,true,null,"x\né😀"],"b":{"nested":{"k":"v"}},"c":1e21,"d":0.1}"#
        let value = try JSONValue.parse(text)
        XCTAssertEqual(value["a"]?[0]?.intValue, 1)
        XCTAssertEqual(value["a"]?[1]?.doubleValue, 2.5)
        XCTAssertEqual(value["a"]?[5]?.stringValue, "x\né😀")
        XCTAssertEqual(value["b"]?["nested"]?["k"]?.stringValue, "v")
        let serialized = value.serialized()
        XCTAssertEqual(try JSONValue.parse(serialized), value)
        XCTAssertEqual(JSONValue.object(["z": 1, "a": [true, "s"]]).serialized(), #"{"a":[true,"s"],"z":1}"#)
        XCTAssertEqual(JSONValue.number(.infinity).serialized(), "null")
        XCTAssertEqual(JSONValue.number(3.0).serialized(), "3")
        XCTAssertEqual(JSONValue.number(-0.5).serialized(), "-0.5")
        XCTAssertEqual(JSONValue.object(["a": 1]).serialized(options: JSONSerializationOptions(pretty: true)), "{\n  \"a\": 1\n}")
        XCTAssertThrowsError(try JSONValue.parse("{\"a\":}"))
        XCTAssertThrowsError(try JSONValue.parse("[1,]"))
        XCTAssertThrowsError(try JSONValue.parse("nul"))
    }

    func testPreferencesAndInstallationId() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("okou-kit-\(UUID().uuidString)")
        let store = DesktopPreferencesStore(fileURL: directory.appendingPathComponent("desktop-preferences.json"))
        XCTAssertEqual(try store.read(), [:])
        try store.write(["keepAwakeEnabled": true])
        var generated = 0
        let id = try ComputerUseInstallationId.readOrCreate(store: store) {
            generated += 1
            return "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b"
        }
        XCTAssertEqual(id, "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b")
        XCTAssertEqual(try ComputerUseInstallationId.readOrCreate(store: store) { XCTFail("should reuse"); return "" }, id)
        XCTAssertEqual(generated, 1)
        XCTAssertEqual(try store.read()["keepAwakeEnabled"], .bool(true))
        let text = try String(contentsOf: store.fileURL, encoding: .utf8)
        XCTAssertTrue(text.hasSuffix("\n"))
        XCTAssertTrue(text.contains("  \"computerUseInstallationId\""))
        try store.write(["computerUseInstallationId": "not-a-uuid"])
        XCTAssertEqual(try ComputerUseInstallationId.readOrCreate(store: store) { "1f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b" }, "1f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b")
        try? FileManager.default.removeItem(at: directory)
    }

    func testKeepAwakeController() throws {
        final class FakeBlocker: KeepAwakeBlocker {
            var started: Set<Int> = []
            var next = 0
            func start() -> Int { next += 1; started.insert(next); return next }
            func stop(_ id: Int) { started.remove(id) }
            func isStarted(_ id: Int) -> Bool { started.contains(id) }
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("okou-kit-\(UUID().uuidString)")
        let store = DesktopPreferencesStore(fileURL: directory.appendingPathComponent("desktop-preferences.json"))
        try store.write(["computerUseInstallationId": "x", "keepAwakeEnabled": true])
        let blocker = FakeBlocker()
        var changes = 0
        let controller = DesktopKeepAwakeController(store: store, blocker: blocker) { changes += 1 }
        XCTAssertEqual(try controller.load(), DesktopKeepAwakeState(enabled: true, active: true))
        XCTAssertEqual(try controller.setEnabled(true), DesktopKeepAwakeState(enabled: true, active: true))
        XCTAssertEqual(changes, 0)
        XCTAssertEqual(controller.release(), DesktopKeepAwakeState(enabled: true, active: false))
        XCTAssertEqual(changes, 1)
        XCTAssertEqual(try store.read()["keepAwakeEnabled"], .bool(true))
        XCTAssertEqual(try controller.setEnabled(false), DesktopKeepAwakeState(enabled: false, active: false))
        XCTAssertEqual(try store.read()["keepAwakeEnabled"], .bool(false))
        XCTAssertEqual(try store.read()["computerUseInstallationId"], .string("x"))
        try? FileManager.default.removeItem(at: directory)
    }

    func testRestartPolicy() {
        var nowMs: Double = 0
        let policy = PluginRestartPolicy { nowMs }
        XCTAssertEqual(policy.nextDelayMs(), 1_000)
        XCTAssertEqual(policy.nextDelayMs(), 5_000)
        policy.notifyStarted()
        nowMs += 60_000
        XCTAssertEqual(policy.nextDelayMs(), 1_000)
        XCTAssertEqual(policy.nextDelayMs(), 5_000)
        XCTAssertEqual(policy.nextDelayMs(), 30_000)
        XCTAssertNil(policy.nextDelayMs())
        policy.reset()
        XCTAssertEqual(policy.nextDelayMs(), 1_000)
    }

    func testStartupGate() {
        let permissions = ComputerUsePermissionState(accessibility: true, screenRecording: true)
        XCTAssertEqual(
            resolveComputerUseStartupGate(authState: .signedOut, permissions: ComputerUsePermissionState(accessibility: true, screenRecording: false)),
            .missingPermissions
        )
        if case let .blocked(host) = resolveComputerUseStartupGate(authState: .signedOut, permissions: permissions) {
            XCTAssertEqual(host.status, .unauthenticated)
            XCTAssertEqual(host.lastError, ComputerUseStartupMessages.unauthenticated)
        } else {
            XCTFail("expected blocked")
        }
        let user = DesktopAuthUser(userId: "u", email: "e")
        if case let .blocked(host) = resolveComputerUseStartupGate(authState: .signedIn(user: user, organization: nil), permissions: permissions) {
            XCTAssertEqual(host.status, .needsOrganization)
        } else {
            XCTFail("expected blocked")
        }
        XCTAssertEqual(
            resolveComputerUseStartupGate(authState: .signedIn(user: user, organization: DesktopAuthOrganization(id: "o", name: "n")), permissions: permissions),
            .ready
        )
        XCTAssertTrue(isComputerUseSetupRequired(authState: nil, permissions: permissions))
    }

    func testUpdateDeferral() {
        let now = ISOTimestamp.milliseconds("2026-09-05T10:00:00.000Z")!
        var host = ComputerUseHostRuntimeState.offline
        XCTAssertFalse(DesktopUpdatePolicy.shouldDeferUpdate(hostState: host, nowMs: now))
        host.lastCommandAt = "2026-09-05T09:31:00.000Z"
        XCTAssertTrue(DesktopUpdatePolicy.shouldDeferUpdate(hostState: host, nowMs: now))
        host.lastCommandAt = "2026-09-05T09:29:59.000Z"
        XCTAssertFalse(DesktopUpdatePolicy.shouldDeferUpdate(hostState: host, nowMs: now))
        host.localCommandLog = [
            ComputerUseLocalCommandLogEntry(
                commandId: "c", kind: "k", app: nil, status: .running, payload: [:], result: nil, error: nil,
                startedAt: "garbage", completedAt: nil, durationMs: nil)
        ]
        XCTAssertTrue(DesktopUpdatePolicy.shouldDeferUpdate(hostState: host, nowMs: now))
        host.localCommandLog[0].status = .succeeded
        XCTAssertFalse(DesktopUpdatePolicy.shouldDeferUpdate(hostState: host, nowMs: now))
    }

    func testOverlayGeometry() {
        let display = OverlayRect(x: 0, y: 0, width: 1512, height: 982)
        XCTAssertEqual(RecorderOverlayGeometry.recorderBarBounds(display: display), OverlayRect(x: 323, y: 818, width: 866, height: 92))
        XCTAssertEqual(
            RecorderOverlayGeometry.areaFromDrag(start: OverlayPoint(x: 100.4, y: 200), end: OverlayPoint(x: 20, y: 50)),
            DesktopRecorderArea(x: 20, y: 50, width: 80, height: 150)
        )
        XCTAssertEqual(jsRound(-2.5), -2)
        XCTAssertEqual(jsRound(2.5), 3)
        let captured = DesktopRecorderArea(x: 100, y: 100, width: 400, height: 300)
        XCTAssertEqual(RecorderOverlayGeometry.recorderControllerBounds(captured: captured, display: display), OverlayPoint(x: 166, y: 416))
        let tall = DesktopRecorderArea(x: 100, y: 10, width: 400, height: 960)
        XCTAssertEqual(RecorderOverlayGeometry.recorderControllerBounds(captured: tall, display: display), OverlayPoint(x: 516, y: 10))
        let full = DesktopRecorderArea(x: 0, y: 0, width: 1512, height: 982)
        XCTAssertEqual(RecorderOverlayGeometry.recorderControllerBounds(captured: full, display: display), OverlayPoint(x: 622, y: 906))
        XCTAssertEqual(RecorderOverlayGeometry.bottomCentredBounds(display: display, size: RecorderOverlayGeometry.controllerSize, margin: 24), OverlayPoint(x: 622, y: 898))
    }

    func testWindowOptions() {
        let sources = [
            DesktopRecorderSource(id: "window:1", kind: .window, title: "Doc", appName: "Pages", bundleId: "com.apple.iWork.Pages"),
            DesktopRecorderSource(id: "window:2", kind: .window, title: "Dock", appName: "Dock", bundleId: "com.apple.dock"),
            DesktopRecorderSource(id: "window:3", kind: .window, title: "No preview", appName: "X", bundleId: nil),
            DesktopRecorderSource(id: "display:1", kind: .display, title: "Display 1", appName: nil, bundleId: nil),
            DesktopRecorderSource(id: "window:4", kind: .window, title: "Alpha", appName: nil, bundleId: nil),
        ]
        let previews = [
            DesktopRecorderWindowPreview(id: "window:1", previewDataUrl: "data:1"),
            DesktopRecorderWindowPreview(id: "window:2", previewDataUrl: "data:2"),
            DesktopRecorderWindowPreview(id: "window:4", previewDataUrl: "data:4"),
        ]
        let options = RecorderWindowOptions.build(sources: sources, previews: previews)
        XCTAssertEqual(options.map(\.id), ["window:4", "window:1"])
        XCTAssertEqual(options[0].appName, "Alpha")
    }

    func testSingleFlightCoalesces() async throws {
        actor Counter {
            var value = 0
            func increment() -> Int { value += 1; return value }
        }
        let counter = Counter()
        let flight = SingleFlight<Int> {
            try await Task.sleep(nanoseconds: 50_000_000)
            return await counter.increment()
        }
        async let first = flight.run()
        async let second = flight.run()
        let results = try await [first, second]
        XCTAssertEqual(results, [1, 1])
        XCTAssertFalse(flight.inFlight)
        let third = try await flight.run()
        XCTAssertEqual(third, 2)
    }

    func testLatestWinsGuard() {
        let guardRef = LatestWinsGuard()
        let first = guardRef.next()
        XCTAssertTrue(first.isCurrent)
        let second = guardRef.next()
        XCTAssertFalse(first.isCurrent)
        XCTAssertTrue(second.isCurrent)
    }
}
