import ComputerUseHelperCore
import Foundation
import Testing

struct AutomationAuthorizationQueriesTests {
    @Test
    func pendingConsentDoesNotBlockCommandsOrAccumulateQueriesAndDecisionsStayFresh() throws {
        let system = AuthorizationSystem()
        defer { system.decision.signal() }
        let queries = AutomationAuthorizationQueries { system.status(for: $0) }
        let commands = PermissionCommandQueue(queries: queries)

        #expect(try commands.status(for: "safari") == nil)
        #expect(system.started.wait(timeout: .now() + 2) == .success)
        for _ in 0..<4 {
            #expect(try commands.status(for: "safari") == nil)
        }
        #expect(system.safariQueries == 1, "Repeated probes must share the still-pending OS query")
        #expect(try commands.status(for: "chrome") == 0, "Another target must remain responsive")

        system.setSafariStatus(-1743)
        system.decision.signal()
        #expect(try commands.status(for: "safari", timeout: 1) == -1743)
        system.setSafariStatus(0)
        #expect(try commands.status(for: "safari", timeout: 1) == 0)
        system.setSafariStatus(-1743)
        #expect(try commands.status(for: "safari", timeout: 1) == -1743)
    }
}

/// The only substitute is the external macOS authorization call. Commands run
/// on a real serial queue, as they do in the JSONL helper.
private final class AuthorizationSystem: @unchecked Sendable {
    let started = DispatchSemaphore(value: 0)
    let decision = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var count = 0
    private var safariStatus: Int32 = -1743

    var safariQueries: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func setSafariStatus(_ status: Int32) {
        lock.lock()
        safariStatus = status
        lock.unlock()
    }

    func status(for target: String) -> Int32 {
        guard target == "safari" else { return 0 }
        lock.lock()
        count += 1
        let first = count == 1
        lock.unlock()
        if first {
            started.signal()
            decision.wait()
        }
        lock.lock()
        defer { lock.unlock() }
        return safariStatus
    }
}

private final class PermissionCommandQueue: @unchecked Sendable {
    private final class Reply: @unchecked Sendable {
        let done = DispatchSemaphore(value: 0)
        var status: Int32?
    }
    private struct UnresponsiveCommand: Error {}
    private let queue = DispatchQueue(label: "automation-permission-command-test")
    private let queries: AutomationAuthorizationQueries

    init(queries: AutomationAuthorizationQueries) { self.queries = queries }

    func status(for target: String, timeout: TimeInterval = 0.02) throws -> Int32? {
        let reply = Reply()
        queue.async { [queries] in
            reply.status = queries.status(for: target, timeout: timeout)
            reply.done.signal()
        }
        guard reply.done.wait(timeout: .now() + 2) == .success else {
            throw UnresponsiveCommand()
        }
        return reply.status
    }
}
