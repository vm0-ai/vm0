import Foundation

/// Bounded restart policy for plugin server processes: retry with increasing
/// delays, give up once the budget is exhausted, and forget past failures once
/// a process has stayed up for a stable window.
public final class PluginRestartPolicy: @unchecked Sendable {
    public static let defaultDelaysMs: [Double] = [1_000, 5_000, 30_000]
    public static let defaultStableUptimeMs: Double = 60_000

    private let delaysMs: [Double]
    private let stableUptimeMs: Double
    private let now: () -> Double
    private var attempts = 0
    private var startedAtMs: Double? = nil
    private let lock = NSLock()

    public init(
        delaysMs: [Double] = PluginRestartPolicy.defaultDelaysMs,
        stableUptimeMs: Double = PluginRestartPolicy.defaultStableUptimeMs,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.delaysMs = delaysMs
        self.stableUptimeMs = stableUptimeMs
        self.now = now
    }

    public func notifyStarted() {
        lock.lock()
        defer { lock.unlock() }
        startedAtMs = now()
    }

    /// The next restart delay, or `nil` once the retry budget is exhausted.
    public func nextDelayMs() -> Double? {
        lock.lock()
        defer { lock.unlock() }
        if let startedAtMs, now() - startedAtMs >= stableUptimeMs {
            attempts = 0
        }
        startedAtMs = nil
        guard attempts < delaysMs.count else {
            return nil
        }
        let delay = delaysMs[attempts]
        attempts += 1
        return delay
    }

    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        attempts = 0
        startedAtMs = nil
    }
}
