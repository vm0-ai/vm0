import Foundation

/// A display-sleep blocker, backed by an IOKit power assertion in the app and
/// by a fake in tests.
public protocol KeepAwakeBlocker: AnyObject {
    func start() -> Int
    func stop(_ id: Int)
    func isStarted(_ id: Int) -> Bool
}

/// Port of `DesktopKeepAwakeController`: persisted `keepAwakeEnabled`
/// preference applied to a display-sleep blocker.
public final class DesktopKeepAwakeController {
    public static let preferenceKey = "keepAwakeEnabled"

    private let store: DesktopPreferencesStore
    private let blocker: KeepAwakeBlocker
    private let onChange: () -> Void
    private var enabled = false
    private var blockerId: Int? = nil

    public init(store: DesktopPreferencesStore, blocker: KeepAwakeBlocker, onChange: @escaping () -> Void) {
        self.store = store
        self.blocker = blocker
        self.onChange = onChange
    }

    @discardableResult
    public func load() throws -> DesktopKeepAwakeState {
        enabled = (try store.read())[Self.preferenceKey]?.boolValue ?? false
        apply()
        return state
    }

    public var state: DesktopKeepAwakeState {
        DesktopKeepAwakeState(enabled: enabled, active: isActive)
    }

    @discardableResult
    public func setEnabled(_ newValue: Bool) throws -> DesktopKeepAwakeState {
        let previous = state
        if enabled != newValue {
            enabled = newValue
            try store.update { record in
                record[Self.preferenceKey] = .bool(newValue)
            }
        }
        apply()
        return notifyIfChanged(previous)
    }

    /// Stops the blocker without touching the saved preference.
    @discardableResult
    public func release() -> DesktopKeepAwakeState {
        let previous = state
        stopBlocker()
        return notifyIfChanged(previous)
    }

    private func apply() {
        if enabled {
            startBlocker()
        } else {
            stopBlocker()
        }
    }

    private func startBlocker() {
        if isActive { return }
        blockerId = blocker.start()
    }

    private func stopBlocker() {
        let id = blockerId
        blockerId = nil
        if let id, blocker.isStarted(id) {
            blocker.stop(id)
        }
    }

    private var isActive: Bool {
        guard let blockerId else { return false }
        return blocker.isStarted(blockerId)
    }

    private func notifyIfChanged(_ previous: DesktopKeepAwakeState) -> DesktopKeepAwakeState {
        let next = state
        if previous != next {
            onChange()
        }
        return next
    }
}
