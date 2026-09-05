import Foundation

/// The quit prompt shown before the app terminates from a user action.
public struct DesktopQuitConfirmationOptions: Equatable, Sendable {
    public let title: String
    public let message: String
    public let detail: String
    public let buttons: [String]
    public let defaultButtonIndex: Int
    public let cancelButtonIndex: Int

    public static func build(displayName: String) -> DesktopQuitConfirmationOptions {
        DesktopQuitConfirmationOptions(
            title: "Quit \(displayName)?",
            message: "Quit \(displayName)?",
            detail: "Computer Use will stop running until you reopen the app.",
            buttons: ["Quit", "Cancel"],
            defaultButtonIndex: 1,
            cancelButtonIndex: 1
        )
    }

    public static func isConfirmed(response: Int) -> Bool {
        response == 0
    }
}

/// Port of `DesktopQuitConfirmationController`: deduplicates concurrent
/// confirmations and remembers that a quit was allowed.
public final class DesktopQuitConfirmationController {
    private let confirmQuit: () async -> Bool
    private let quit: () -> Void
    private var quitAllowed = false
    private var pendingConfirmation: Task<Void, Never>? = nil

    public init(confirmQuit: @escaping () async -> Bool, quit: @escaping () -> Void) {
        self.confirmQuit = confirmQuit
        self.quit = quit
    }

    public var isQuitAllowed: Bool {
        quitAllowed
    }

    public func allowQuitWithoutConfirmation() {
        quitAllowed = true
    }

    public func requestQuit() async {
        if quitAllowed {
            quit()
            return
        }
        if let pendingConfirmation {
            await pendingConfirmation.value
            return
        }
        let confirmQuit = self.confirmQuit
        let quit = self.quit
        let task = Task { @MainActor [weak self] in
            let confirmed = await confirmQuit()
            guard confirmed else { return }
            self?.quitAllowed = true
            quit()
        }
        pendingConfirmation = task
        await task.value
        if pendingConfirmation == task {
            pendingConfirmation = nil
        }
    }
}
