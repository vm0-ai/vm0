import Foundation

public enum DesktopUpdatePolicy {
    /// Updates install silently once Computer Use has been idle this long.
    public static let silentRestartIdleMs: Double = 30 * 60 * 1000

    private static func isRecent(_ timestamp: String?, nowMs: Double) -> Bool {
        guard let timestamp, let parsedMs = ISOTimestamp.milliseconds(timestamp) else {
            return false
        }
        return parsedMs >= nowMs - silentRestartIdleMs
    }

    /// True while a command is running or ran within the last thirty minutes.
    public static func shouldDeferUpdate(hostState: ComputerUseHostRuntimeState, nowMs: Double) -> Bool {
        if isRecent(hostState.lastCommandAt, nowMs: nowMs) {
            return true
        }
        return hostState.localCommandLog.contains { entry in
            if entry.status == .running {
                return true
            }
            return isRecent(entry.startedAt, nowMs: nowMs) || isRecent(entry.completedAt, nowMs: nowMs)
        }
    }
}

/// ISO-8601 helpers matching `Date.toISOString()` / `Date.parse`.
public enum ISOTimestamp {
    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// `new Date().toISOString()` shape: `2026-09-05T04:02:14.123Z`.
    public static func string(from date: Date) -> String {
        fractionalFormatter.string(from: date)
    }

    public static func now() -> String {
        string(from: Date())
    }

    public static func date(from text: String) -> Date? {
        fractionalFormatter.date(from: text) ?? plainFormatter.date(from: text)
    }

    public static func milliseconds(_ text: String) -> Double? {
        guard let date = date(from: text) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }
}
