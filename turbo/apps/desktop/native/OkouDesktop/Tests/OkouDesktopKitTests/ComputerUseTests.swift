import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@testable import OkouDesktopKit

/// Scripted helper double: answers each `kind` from a queue of results.
final class FakeNativeBackend: ComputerUseNativeBackend, @unchecked Sendable {
    var responses: [String: [Result<[String: JSONValue], Error>]] = [:]
    var calls: [(kind: String, payload: [String: JSONValue])] = []
    var disposed: ComputerUseNativeShutdownReason? = nil
    private let lock = NSLock()

    func enqueue(_ kind: String, _ result: Result<[String: JSONValue], Error>) {
        lock.withLock { responses[kind, default: []].append(result) }
    }

    func dispose(reason: ComputerUseNativeShutdownReason) async {
        disposed = reason
    }

    func run(kind: String, payload: [String: JSONValue]) async throws -> [String: JSONValue] {
        let result: Result<[String: JSONValue], Error>? = lock.withLock {
            calls.append((kind, payload))
            guard var queue = responses[kind], !queue.isEmpty else { return nil }
            let first = queue.removeFirst()
            responses[kind] = queue
            return first
        }
        guard let result else {
            throw ComputerUseNativeHelperError(message: "No scripted response for \(kind)")
        }
        return try result.get()
    }
}

final class ComputerUseTests: XCTestCase {
    private func element(_ raw: [String: JSONValue], _ children: [AccessibilityElement] = []) -> AccessibilityElement {
        AccessibilityElement(raw: raw, children: children)
    }

    private func snapshotResult(elements: [JSONValue], extra: [String: JSONValue] = [:]) -> [String: JSONValue] {
        var result: [String: JSONValue] = [
            "app": "com.apple.Notes", "appDisplayName": "Notes", "bundleId": "com.apple.Notes", "pid": 42,
            "snapshotId": "helper-id", "windowTitle": "My Note", "windowId": 7,
            "windowFrame": ["x": 0, "y": 0, "width": 800, "height": 600],
            "elements": .array(elements),
            "screenshot": "data:image/png;base64,AAAA", "screenshotSource": "window", "screenshotSourceName": "My Note",
            "screenshotWidth": 800, "screenshotHeight": 600,
            "screenshotSourceBounds": ["x": 0, "y": 0, "width": 800, "height": 600],
        ]
        for (key, value) in extra { result[key] = value }
        return result
    }

    func testNormalizationElidesWrappersAndRendersIndexedTree() {
        let tree = AccessibilityAppStateSnapshot(
            raw: ["app": "com.apple.Notes", "snapshotId": "s1", "appDisplayName": "Notes", "pid": 42, "bundleId": "com.apple.Notes"],
            elements: [
                element(["id": "w0", "role": "AXWindow", "name": "My Note"], [
                    element(["id": "w0.e0", "role": "AXGroup"], [
                        element(["id": "w0.e0.e0", "role": "AXButton", "name": "Save", "enabled": false, "actions": ["AXPress"]], [
                            element(["id": "w0.e0.e0.e0", "role": "AXStaticText", "name": "Save"])
                        ]),
                        element(["id": "w0.e0.e1", "role": "AXTextField", "value": "Hello", "valueSettable": true, "valueType": "string", "focused": true]),
                        element(["id": "w0.e0.e2", "role": "AXStaticText", "hidden": true, "name": "gone"]),
                        element(["id": "w0.e0.e3", "role": "AXMenuBar"], [
                            element(["id": "w0.e0.e3.e0", "role": "AXMenuBarItem", "name": "File", "actions": ["AXPress", "AXShowMenu"]], [
                                element(["id": "deep", "role": "AXMenuItem", "name": "Open"])
                            ])
                        ]),
                    ])
                ])
            ]
        )
        let normalized = AccessibilityShaping.normalize(tree)
        // The redundant "Save" label, the hidden text and the menu item under
        // the flattened menu bar are dropped before counting.
        XCTAssertEqual(normalized.nodeCount, 5)
        XCTAssertNil(normalized.truncated)
        let indexed = AccessibilityShaping.index(normalized)
        XCTAssertEqual(indexed.elementIdsByIndex, ["w0", "w0.e0.e0", "w0.e0.e1", "w0.e0.e3", "w0.e0.e3.e0"].count == 5 ? indexed.elementIdsByIndex : [])
        XCTAssertEqual(indexed.elementIdsByIndex.count, 5)
        XCTAssertEqual(indexed.elementIdsByIndex[0], "w0")
        XCTAssertEqual(indexed.elementIdsByIndex[1], "w0.e0.e0")
        XCTAssertEqual(indexed.focusedElementIndex, 2)
        let rendered = AccessibilityShaping.render(indexed.snapshot)
        let expected = """
            Computer Use state
            <app_state>
            App=Notes (bundleID com.apple.Notes, pid 42)
            Window: "My Note", App: Notes.
            0 standard window My Note
            \t1 button (disabled) Save
            \t2 text field (settable, string) Hello
            \t3 menu bar
            \t\t4 menu bar item File

            The focused UI element is 2 text field (settable, string) Hello.
            </app_state>
            """
        XCTAssertEqual(rendered, expected)
        XCTAssertEqual(AccessibilityShaping.labelFromAxRole("AXSplitGroup"), "split group")
        XCTAssertEqual(AccessibilityShaping.normalizeCoverageText("  Hello • World  "), "hello world")
    }

    func testNormalizationHonoursNodeLimit() {
        var children: [AccessibilityElement] = []
        for index in 0..<5 {
            children.append(element(["id": .string("e\(index)"), "role": "AXButton", "name": .string("B\(index)")]))
        }
        let snapshot = AccessibilityAppStateSnapshot(raw: ["app": "a", "snapshotId": "s"], elements: [element(["id": "root", "role": "AXWindow", "name": "W"], children)])
        let normalized = AccessibilityShaping.normalize(snapshot, limits: AccessibilitySnapshotOutputLimits(maxDepth: 32, maxNodes: 3, maxChildrenPerNode: 120))
        XCTAssertEqual(normalized.nodeCount, 3)
        XCTAssertEqual(normalized.truncated, true)
        XCTAssertEqual(normalized.truncationReasons, ["max_nodes"])
        XCTAssertEqual(normalized.elements.first?.children.count, 2)
    }

    func testExecutorAppStateStoresSnapshotAndBuildsResult() async throws {
        let backend = FakeNativeBackend()
        backend.enqueue("app.state", .success(snapshotResult(elements: [
            ["id": "w0", "role": "AXWindow", "name": "My Note", "children": .array([["id": "w0.e0", "role": "AXButton", "name": "Save"]])]
        ])))
        let store = ComputerUseSnapshotStore()
        final class Clock: @unchecked Sendable { var value: Double = 1_700_000_000_000 }
        let clock = Clock()
        let executor = ComputerUseCommandExecutor(backend: backend, snapshotStore: store) { clock.value += 5; return clock.value }
        let permissions = ComputerUsePermissionState(accessibility: true, screenRecording: true)
        let result = await executor.execute(ComputerUseCommand(id: "c1", kind: "app.state", payload: ["app": "com.apple.Notes"]), permissions: permissions)
        guard case let .succeeded(record) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertNil(record["elements"])
        XCTAssertEqual(record["screenshotSourceName"]?.stringValue, "My Note")
        XCTAssertEqual(record["elementIdsByIndex"], .array(["w0", "w0.e0"]))
        XCTAssertEqual(record["metrics"]?["nodeCount"]?.intValue, 2)
        XCTAssertEqual(record["metrics"]?["rawNodeCount"]?.intValue, 2)
        XCTAssertTrue(record["appState"]?.stringValue?.contains("\t1 button Save") == true)
        XCTAssertEqual(backend.calls.first?.payload["snapshotId"]?.stringValue?.hasPrefix("desktop_"), true)
        let stored = store.latest(app: "COM.apple.notes")
        XCTAssertEqual(stored?.elementIdsByIndex, ["w0", "w0.e0"])
        XCTAssertEqual(stored?.windowId, 7)
    }

    func testExecutorResolvesElementIndexAndAppendsPostActionState() async throws {
        let backend = FakeNativeBackend()
        let store = ComputerUseSnapshotStore()
        store.set(ComputerUseSnapshotMetadata(
            app: "com.apple.Notes", snapshotId: "snap-1", elementIdsByIndex: ["w0", "w0.e0"], focusedElementIndex: nil,
            windowId: 7, windowFrame: nil, screenshotWidth: 800, screenshotHeight: 600, screenshotSource: "window",
            screenshotSourceName: "My Note", sourceBounds: nil
        ))
        backend.enqueue("element.click", .success(["dispatchMode": "accessibility_action"]))
        backend.enqueue("app.state", .success(snapshotResult(elements: [["id": "w0", "role": "AXWindow", "name": "After"]])))
        let executor = ComputerUseCommandExecutor(backend: backend, snapshotStore: store)
        let permissions = ComputerUsePermissionState(accessibility: true, screenRecording: true)
        let result = await executor.execute(
            ComputerUseCommand(id: "c2", kind: "element.click", payload: ["app": "com.apple.Notes", "elementIndex": 1, "snapshotId": "snap-1"]),
            permissions: permissions
        )
        guard case let .succeeded(record) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(record["action"]?["summary"]?.stringValue, "Clicked elementIndex=1")
        XCTAssertEqual(record["action"]?["elementIndex"]?.intValue, 1)
        XCTAssertEqual(record["action"]?["dispatchMode"]?.stringValue, "accessibility_action")
        XCTAssertEqual(record["screenshotSource"]?.stringValue, "window")
        let click = backend.calls.first { $0.kind == "element.click" }
        XCTAssertEqual(click?.payload["elementId"]?.stringValue, "w0.e0")
        XCTAssertEqual(click?.payload["button"]?.stringValue, "left")
        XCTAssertEqual(click?.payload["clickCount"]?.intValue, 1)
        XCTAssertEqual(click?.payload["foregroundRecovery"]?.stringValue, "on-window-unavailable")
        XCTAssertEqual(backend.calls.last?.payload["settle"]?.boolValue, true)

        let missing = await executor.execute(
            ComputerUseCommand(id: "c3", kind: "element.click", payload: ["app": "com.apple.Notes", "elementIndex": 9, "snapshotId": "snap-1"]),
            permissions: permissions
        )
        XCTAssertEqual(missing.failure, ComputerUseCommandFailure(code: .unsupportedCommand, message: "Element index 9 was not found in snapshot snap-1"))
        let rightClick = await executor.execute(
            ComputerUseCommand(id: "c4", kind: "element.click", payload: ["app": "com.apple.Notes", "elementIndex": 1, "button": "right"]),
            permissions: permissions
        )
        XCTAssertEqual(rightClick.failure?.code, .unsupportedCommand)
    }

    func testExecutorPermissionGatesAndHelperErrors() async throws {
        let backend = FakeNativeBackend()
        let executor = ComputerUseCommandExecutor(backend: backend, snapshotStore: ComputerUseSnapshotStore())
        let noAccessibility = await executor.execute(ComputerUseCommand(id: "c", kind: "apps.list", payload: [:]), permissions: .none)
        XCTAssertEqual(noAccessibility.failure, ComputerUseCommandFailure(code: .permissionDenied, message: "macOS Accessibility permission is required"))
        let noScreen = await executor.execute(
            ComputerUseCommand(id: "c", kind: "app.state", payload: ["app": "x"]),
            permissions: ComputerUsePermissionState(accessibility: true, screenRecording: false)
        )
        XCTAssertEqual(noScreen.failure?.code, .screenRecordingUnavailable)
        backend.enqueue("app.open", .failure(ComputerUseNativeHelperError(code: .appNotFound, message: "App is not running: x")))
        let failed = await executor.execute(
            ComputerUseCommand(id: "c", kind: "app.open", payload: ["app": "x"]),
            permissions: ComputerUsePermissionState(accessibility: true, screenRecording: true)
        )
        XCTAssertEqual(failed.failure, ComputerUseCommandFailure(code: .appNotFound, message: "App is not running: x"))
        XCTAssertEqual(failed.json.serialized(), #"{"error":{"code":"app_not_found","message":"App is not running: x"},"status":"failed"}"#)
        let unsupported = await executor.execute(
            ComputerUseCommand(id: "c", kind: "nope", payload: ["app": "x"]),
            permissions: ComputerUsePermissionState(accessibility: true, screenRecording: true)
        )
        XCTAssertEqual(unsupported.failure?.message, "Unsupported command: nope")
        XCTAssertEqual(ComputerUseErrorCode.fromHelper("target_app_unresponsive"), .accessibilityUnavailable)
        XCTAssertEqual(ComputerUseErrorCode.fromHelper("window_unavailable"), .windowUnavailable)
    }

    func testHelperResponseParsing() throws {
        XCTAssertEqual(
            try NativeHelperResults.parseResponse(try JSONValue.parse(#"{"status":"succeeded","result":{"a":1},"id":"desktop_1"}"#)),
            .succeeded(["a": 1])
        )
        XCTAssertEqual(
            try NativeHelperResults.parseResponse(try JSONValue.parse(#"{"status":"failed","error":{"code":"window_unavailable","message":"gone"}}"#)),
            .failed(code: "window_unavailable", message: "gone")
        )
        XCTAssertThrowsError(try NativeHelperResults.parseResponse(try JSONValue.parse(#"{"status":"weird"}"#)))
        XCTAssertEqual(NativeHelperResults.failure(code: "bogus", message: "  ").message, "Native Computer Use helper failed")
        let apps = try NativeHelperResults.appRecords(["apps": ["Finder", ["name": "Notes", "bundleId": "com.apple.Notes", "pid": 12, "running": true]]])
        XCTAssertEqual(apps, [ComputerUseNativeAppRecord(name: "Finder"), ComputerUseNativeAppRecord(name: "Notes", bundleId: "com.apple.Notes", running: true, pid: 12)])
    }
}

/// Scripted HTTP double keyed by path suffix.
final class FakeHTTP: @unchecked Sendable {
    struct Call { let path: String; let method: String; let body: JSONValue?; let headers: [String: String] }
    var handlers: [(String, (Call) -> DesktopHTTPResponse)] = []
    var calls: [Call] = []
    private let lock = NSLock()

    func on(_ pathSuffix: String, _ handler: @escaping (Call) -> DesktopHTTPResponse) {
        lock.withLock { handlers.append((pathSuffix, handler)) }
    }

    var fetch: DesktopFetch {
        { request in
            let path = request.url?.path ?? ""
            let body = request.httpBody.flatMap { try? JSONValue.parse($0) }
            let call = Call(path: path, method: request.httpMethod ?? "GET", body: body, headers: request.allHTTPHeaderFields ?? [:])
            self.lock.withLock { self.calls.append(call) }
            let handler = self.lock.withLock { self.handlers.first { path.hasSuffix($0.0) }?.1 }
            guard let handler else { return DesktopHTTPResponse(status: 404) }
            return handler(call)
        }
    }
}

@MainActor
final class HostRuntimeTests: XCTestCase {
    func testStartHeartbeatAndCommandCycle() async throws {
        let http = FakeHTTP()
        var commandServed = false
        http.on("/api/computer-use/hosts/start") { call in
            XCTAssertEqual(call.body?["installationId"]?.stringValue, "install-1")
            XCTAssertEqual(call.body?["hostName"]?.stringValue, "Mac")
            XCTAssertEqual(call.body?["supportedCapabilities"]?.arrayValue?.count, ComputerUseCapabilities.supported.count)
            return DesktopHTTPResponse(status: 200, body: Data(#"{"hostId":"host-1","hostToken":"tok"}"#.utf8))
        }
        http.on("/api/computer-use/heartbeat") { call in
            XCTAssertEqual(call.headers["Authorization"] ?? call.headers["authorization"], "Bearer tok")
            XCTAssertEqual(call.headers["X-Client-Type"], "Desktop")
            XCTAssertEqual(call.headers["X-Client-Product"], "okou")
            return DesktopHTTPResponse(status: 200, body: Data(#"{"ok":true,"hostId":"host-1"}"#.utf8))
        }
        http.on("/api/computer-use/host/commands/next") { _ in
            if commandServed {
                return DesktopHTTPResponse(status: 200, body: Data(#"{"status":"idle"}"#.utf8))
            }
            commandServed = true
            return DesktopHTTPResponse(status: 200, body: Data(#"{"status":"command","command":{"id":"cmd-1","kind":"apps.list","status":"queued","hostId":"host-1","hostName":null,"payload":{},"timeoutMs":null,"createdAt":"2026-09-05T00:00:00.000Z","claimedAt":null,"completedAt":null}}"#.utf8))
        }
        var completion: JSONValue? = nil
        http.on("/complete") { call in
            completion = call.body
            return DesktopHTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8))
        }
        http.on("/api/computer-use/host/stop") { _ in DesktopHTTPResponse(status: 200, body: Data(#"{"ok":true,"hostId":"host-1"}"#.utf8)) }

        var changes = 0
        var executed: [String] = []
        let runtime = ComputerUseHostRuntime(options: ComputerUseHostRuntime.Options(
            platformUrl: URL(string: "https://app.okou.ai")!, installationId: "install-1", hostName: "Mac", appVersion: "1.0.0",
            sessionFetch: http.fetch, hostFetch: http.fetch, clientHeaders: DesktopClientHeaders(clientVersion: "1.0.0", product: .okou),
            getPermissions: { ComputerUsePermissionState(accessibility: true, screenRecording: true) },
            executeCommand: { command, _ in
                executed.append(command.kind)
                return .succeeded(["apps": [], "screenshot": "data:...", "summary": "ok"])
            },
            onChange: { changes += 1 },
            sleep: { ms in try? await Task.sleep(nanoseconds: UInt64(min(ms, 20) * 1_000_000)) }
        ))
        await runtime.start()
        XCTAssertEqual(runtime.state.status, .online)
        XCTAssertEqual(runtime.state.hostId, "host-1")
        for _ in 0..<50 where runtime.state.lastCommandAt == nil {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(executed, ["apps.list"])
        XCTAssertEqual(completion?["status"]?.stringValue, "succeeded")
        XCTAssertNotNil(runtime.state.lastCommandAt)
        let logged = runtime.state.localCommandLog.first
        XCTAssertEqual(logged?.status, .succeeded)
        XCTAssertEqual(logged?.result?["omittedResultFields"], .array(["screenshot"]))
        XCTAssertNil(logged?.result?["screenshot"])
        XCTAssertTrue(changes > 3)
        await runtime.stop()
        XCTAssertEqual(runtime.state.status, .offline)
        XCTAssertTrue(http.calls.contains { $0.path.hasSuffix("/api/computer-use/host/stop") })
    }

    func testStartResponsesMapToStatuses() async throws {
        for (status, expected, meOk) in [(401, ComputerUseHostRuntimeStatus.needsOrganization, true), (401, .unauthenticated, false), (403, .disabled, false), (409, .error, false)] {
            let http = FakeHTTP()
            http.on("/api/computer-use/hosts/start") { _ in DesktopHTTPResponse(status: status) }
            http.on("/api/auth/me") { _ in DesktopHTTPResponse(status: meOk ? 200 : 401) }
            let runtime = ComputerUseHostRuntime(options: ComputerUseHostRuntime.Options(
                platformUrl: URL(string: "https://app.okou.ai")!, installationId: "i", hostName: "h", appVersion: "1",
                sessionFetch: http.fetch, hostFetch: http.fetch, clientHeaders: DesktopClientHeaders(clientVersion: "1"),
                getPermissions: { .none }, executeCommand: { _, _ in .succeeded([:]) }
            ))
            await runtime.start()
            XCTAssertEqual(runtime.state.status, expected, "status \(status)")
        }
    }

    func testRetryableStartFailureSchedulesRecovery() async throws {
        let http = FakeHTTP()
        var attempts = 0
        http.on("/api/computer-use/hosts/start") { _ in
            attempts += 1
            return attempts == 1 ? DesktopHTTPResponse(status: 503, headers: ["Retry-After": "1"]) : DesktopHTTPResponse(status: 200, body: Data(#"{"hostId":"h","hostToken":"t"}"#.utf8))
        }
        http.on("/api/computer-use/heartbeat") { _ in DesktopHTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8)) }
        http.on("/next") { _ in DesktopHTTPResponse(status: 200, body: Data(#"{"status":"idle"}"#.utf8)) }
        http.on("/stop") { _ in DesktopHTTPResponse(status: 200) }
        let runtime = ComputerUseHostRuntime(options: ComputerUseHostRuntime.Options(
            platformUrl: URL(string: "https://app.okou.ai")!, installationId: "i", hostName: "h", appVersion: "1",
            sessionFetch: http.fetch, hostFetch: http.fetch, clientHeaders: DesktopClientHeaders(clientVersion: "1"),
            getPermissions: { .none }, executeCommand: { _, _ in .succeeded([:]) },
            sleep: { _ in try? await Task.sleep(nanoseconds: 10_000_000) }
        ))
        await runtime.start()
        XCTAssertEqual(runtime.state.status, .recovering)
        XCTAssertEqual(runtime.state.recovery?.phase, .start)
        XCTAssertEqual(runtime.state.recovery?.attempt, 1)
        XCTAssertEqual(runtime.state.recovery?.retryDelayMs, 1_000)
        XCTAssertEqual(runtime.state.errorLog.first?.message, "Failed to start Computer Use host: 503")
        for _ in 0..<50 where runtime.state.status != .online {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(runtime.state.status, .online)
        XCTAssertNil(runtime.state.recovery)
        await runtime.stop()
        XCTAssertEqual(ComputerUseHostRuntime.retryDelayForAttempt(1), 2_000)
        XCTAssertEqual(ComputerUseHostRuntime.retryDelayForAttempt(6), 60_000)
        XCTAssertEqual(ComputerUseHostRuntime.retryAfterDelayMs(DesktopHTTPResponse(status: 429, headers: ["retry-after": "900"]), nowMs: 0), 300_000)
    }

    func testAuthSessionStateAndTokenLadder() async throws {
        let http = FakeHTTP()
        var authorizations: [String?] = []
        http.on("/api/auth/me") { call in
            authorizations.append(call.headers["authorization"] ?? call.headers["Authorization"])
            let bearer = call.headers["authorization"] ?? call.headers["Authorization"]
            if bearer == "Bearer expired" || bearer == nil {
                return DesktopHTTPResponse(status: 401)
            }
            return DesktopHTTPResponse(status: 200, body: Data(#"{"userId":"u1","email":"e@x"}"#.utf8))
        }
        http.on("/api/org") { _ in DesktopHTTPResponse(status: 200, body: Data(#"{"id":"o1","name":"Org"}"#.utf8)) }
        struct NoCookies: DesktopSessionCookieSource {
            func cookies(for url: URL) async -> [DesktopSessionCookie] { [DesktopSessionCookie(name: "__session", value: "abc")] }
        }
        struct Client: DesktopHTTPClient {
            let fetch: DesktopFetch
            func send(_ request: URLRequest) async throws -> DesktopHTTPResponse { try await fetch(request) }
        }
        var windows: [DesktopAuthWindowRequest] = []
        var session: DesktopAuthSession! = nil
        session = DesktopAuthSession(
            apiBaseUrl: "https://api.vm0.ai", cookieUrls: [URL(string: "https://www.vm0.ai/")!], cookieSource: NoCookies(),
            http: Client(fetch: http.fetch), clientHeaders: DesktopClientHeaders(clientVersion: "1", product: .okou),
            tokenUrl: "https://www.vm0.ai/desktop-auth/token", consumeUrl: { code, _ in "consume:\(code)" },
            selectOrgUrl: "https://www.vm0.ai/desktop-auth/select-org?force=true",
            runAuthWindow: { request in
                windows.append(request)
                if request.url.hasSuffix("/token") { session.completeSignIn(token: "fresh") }
            }
        )
        session.completeSignIn(token: "expired")
        let state = try await session.getAuthState()
        XCTAssertEqual(state, .signedIn(user: DesktopAuthUser(userId: "u1", email: "e@x"), organization: DesktopAuthOrganization(id: "o1", name: "Org")))
        XCTAssertEqual(authorizations, ["Bearer expired", nil, "Bearer fresh"])
        XCTAssertEqual(windows.map(\.url), ["https://www.vm0.ai/desktop-auth/token"])
        XCTAssertEqual(windows.first?.visible, false)
        XCTAssertEqual(http.calls.first?.headers["cookie"] ?? http.calls.first?.headers["Cookie"], "__session=abc")
        session.signOut()
        let signedOut = try await session.getAuthState()
        XCTAssertEqual(signedOut, .signedOut)
        session.completeSignIn(token: "ignored")
        XCTAssertNil(session.cachedToken)
    }
}
