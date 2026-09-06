import Foundation

/// Coalesces concurrent callers onto one in-flight task. Port of `singleFlight`.
public final class SingleFlight<Value: Sendable>: @unchecked Sendable {
    private let operation: @Sendable () async throws -> Value
    private var inFlightTask: Task<Value, Error>? = nil
    private let lock = NSLock()

    public init(_ operation: @escaping @Sendable () async throws -> Value) {
        self.operation = operation
    }

    public var inFlight: Bool {
        lock.withLock { inFlightTask != nil }
    }

    public func clear() {
        lock.withLock { inFlightTask = nil }
    }

    private func currentOrStart() -> (task: Task<Value, Error>, started: Bool) {
        lock.withLock {
            if let existing = inFlightTask {
                return (existing, false)
            }
            let operation = self.operation
            let created = Task<Value, Error> { try await operation() }
            inFlightTask = created
            return (created, true)
        }
    }

    private func finish(_ task: Task<Value, Error>) {
        lock.withLock {
            if inFlightTask == task {
                inFlightTask = nil
            }
        }
    }

    public func run() async throws -> Value {
        let (task, started) = currentOrStart()
        if started {
            defer { finish(task) }
            return try await task.value
        }
        return try await task.value
    }
}

/// Runs a task at most once at a time; a request made while it runs schedules
/// exactly one follow-up. Port of `latestWinsSingleFlight`.
public final class LatestWinsSingleFlight: @unchecked Sendable {
    private let operation: @Sendable () async throws -> Void
    private let onError: (@Sendable (Error) -> Void)?
    private var running = false
    private var rerunRequested = false
    private let lock = NSLock()

    public init(
        onError: (@Sendable (Error) -> Void)? = nil,
        _ operation: @escaping @Sendable () async throws -> Void
    ) {
        self.operation = operation
        self.onError = onError
    }

    public func request() {
        let shouldStart: Bool = lock.withLock {
            if running {
                rerunRequested = true
                return false
            }
            running = true
            return true
        }
        guard shouldStart else { return }
        Task { await self.drain() }
    }

    private func beginIteration() {
        lock.withLock { rerunRequested = false }
    }

    /// Returns true when the loop should run again.
    private func endIteration() -> Bool {
        lock.withLock {
            if rerunRequested {
                return true
            }
            running = false
            return false
        }
    }

    private func drain() async {
        while true {
            beginIteration()
            do {
                try await operation()
            } catch {
                onError?(error)
            }
            if !endIteration() {
                return
            }
        }
    }
}

/// Version token that lets a stale async result recognize itself.
public final class LatestWinsGuard: @unchecked Sendable {
    public struct Token: Sendable {
        private let version: Int
        private let guardRef: LatestWinsGuard

        fileprivate init(version: Int, guardRef: LatestWinsGuard) {
            self.version = version
            self.guardRef = guardRef
        }

        public var isCurrent: Bool {
            guardRef.currentVersion == version
        }
    }

    private var version = 0
    private let lock = NSLock()

    public init() {}

    fileprivate var currentVersion: Int {
        lock.withLock { version }
    }

    public func next() -> Token {
        lock.withLock {
            version += 1
            return Token(version: version, guardRef: self)
        }
    }
}
