import Foundation

/// A consent dialog can block Apple's authorization query even when that query
/// does not request consent. Keep that wait off the serialized command queue.
public final class AutomationAuthorizationQueries: @unchecked Sendable {
    private final class Pending: @unchecked Sendable {
        let finished = DispatchGroup()
        var status: Int32?

        init() { finished.enter() }
    }

    private let lock = NSLock()
    private var pending: [String: Pending] = [:]
    private let authorization: @Sendable (String) -> Int32

    public init(authorization: @escaping @Sendable (String) -> Int32) {
        self.authorization = authorization
    }

    public func status(for target: String, timeout: TimeInterval = 0.25) -> Int32? {
        lock.lock()
        let query: Pending
        if let existing = pending[target] {
            query = existing
        } else {
            query = Pending()
            pending[target] = query
            DispatchQueue.global(qos: .userInitiated).async { [self, query] in
                let status = authorization(target)
                lock.lock()
                query.status = status
                // Completed answers are never cached: a later probe must see
                // a new grant or revocation, including changes in Settings.
                pending.removeValue(forKey: target)
                lock.unlock()
                query.finished.leave()
            }
        }
        lock.unlock()

        guard query.finished.wait(timeout: .now() + timeout) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return query.status
    }
}
