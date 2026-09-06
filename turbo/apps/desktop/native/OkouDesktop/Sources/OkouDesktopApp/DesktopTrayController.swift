#if canImport(AppKit)
import AppKit
import OkouDesktopKit

enum DesktopTrayIconFrame {
    case disabled
    case online
    case running
}

/// `NSMenuItem` carrying its own action closure.
final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(title: String, keyEquivalent: String = "", handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(invoke), keyEquivalent: keyEquivalent)
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @objc private func invoke() {
        handler()
    }
}

/// Port of `DesktopTrayController`: menu-bar item with disabled / online /
/// running icon frames, the running animation, and menu rebuilds only when
/// the structural signature changes.
@MainActor
final class DesktopTrayController {
    static let runningFrameMs = 500
    static let runningActivityLingerMs: Double = 15_000
    static let runningFrameCount = 4

    private let displayName: String
    private let assets: DesktopAssetLocator
    private let getComputerUseState: () -> DesktopComputerUseState
    private let buildMenuItems: () -> [DesktopTrayMenuItem]
    private var statusItem: NSStatusItem?
    private var iconFrame: DesktopTrayIconFrame? = nil
    private var iconCache: [ObjectIdentifier: NSImage] = [:]
    private var runningActivityUntilMs: Double? = nil
    private var runningFrameIndex = 0
    private var runningTimer: Timer? = nil
    private var menuSignature: String? = nil

    init(
        displayName: String,
        assets: DesktopAssetLocator,
        getComputerUseState: @escaping () -> DesktopComputerUseState,
        buildMenuItems: @escaping () -> [DesktopTrayMenuItem]
    ) {
        self.displayName = displayName
        self.assets = assets
        self.getComputerUseState = getComputerUseState
        self.buildMenuItems = buildMenuItems
    }

    func install() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.toolTip = displayName
        statusItem = item
        let mode = iconMode(for: getComputerUseState())
        setIconFrame(mode == .running ? Self.runningFrame(at: 0) : Self.frame(for: mode))
        refresh()
    }

    func refresh() {
        guard let statusItem else { return }
        let state = getComputerUseState()
        refreshIcon(state)
        let items = buildMenuItems()
        let signature = JSONValue.array(items.map(\.signature)).serialized()
        if signature == menuSignature {
            return
        }
        menuSignature = signature
        statusItem.menu = Self.menu(from: items)
    }

    static func menu(from items: [DesktopTrayMenuItem]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items {
            menu.addItem(menuItem(from: item))
        }
        return menu
    }

    static func menuItem(from item: DesktopTrayMenuItem) -> NSMenuItem {
        if item.type == .separator {
            return NSMenuItem.separator()
        }
        let menuItem: NSMenuItem
        if let click = item.click {
            menuItem = ClosureMenuItem(title: item.label ?? "", handler: click)
        } else {
            menuItem = NSMenuItem(title: item.label ?? "", action: nil, keyEquivalent: "")
        }
        menuItem.isEnabled = item.enabled ?? true
        if item.type == .checkbox {
            menuItem.state = (item.checked ?? false) ? .on : .off
        }
        if let submenu = item.submenu {
            menuItem.submenu = menu(from: submenu)
        }
        return menuItem
    }

    private enum IconMode {
        case disabled
        case online
        case running
    }

    private static func frame(for mode: IconMode) -> DesktopTrayIconFrame {
        switch mode {
        case .disabled: return .disabled
        case .online: return .online
        case .running: return .running
        }
    }

    /// Cycle `disabled -> running -> online -> running`.
    static func runningFrame(at index: Int) -> DesktopTrayIconFrame {
        switch index % runningFrameCount {
        case 0: return .disabled
        case 1: return .running
        case 2: return .online
        default: return .running
        }
    }

    private func iconMode(for state: DesktopComputerUseState) -> IconMode {
        let nowMs = Date().timeIntervalSince1970 * 1000
        if state.host.status != .online {
            runningActivityUntilMs = nil
            return .disabled
        }
        if state.host.localCommandLog.contains(where: { $0.status == .running }) {
            runningActivityUntilMs = nowMs + Self.runningActivityLingerMs
            return .running
        }
        if let runningActivityUntilMs, nowMs < runningActivityUntilMs {
            return .running
        }
        runningActivityUntilMs = nil
        return .online
    }

    private func refreshIcon(_ state: DesktopComputerUseState) {
        let mode = iconMode(for: state)
        if mode == .running {
            startRunningAnimation()
            return
        }
        stopRunningAnimation()
        setIconFrame(Self.frame(for: mode))
    }

    private func startRunningAnimation() {
        guard runningTimer == nil else { return }
        runningFrameIndex = 0
        setIconFrame(Self.runningFrame(at: 0))
        runningTimer = Timer.scheduledTimer(withTimeInterval: Double(Self.runningFrameMs) / 1000, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.advanceRunningAnimation()
            }
        }
    }

    private func advanceRunningAnimation() {
        let mode = iconMode(for: getComputerUseState())
        if mode != .running {
            stopRunningAnimation()
            setIconFrame(Self.frame(for: mode))
            return
        }
        runningFrameIndex = (runningFrameIndex + 1) % Self.runningFrameCount
        setIconFrame(Self.runningFrame(at: runningFrameIndex))
    }

    private func stopRunningAnimation() {
        runningTimer?.invalidate()
        runningTimer = nil
    }

    private func setIconFrame(_ frame: DesktopTrayIconFrame) {
        if frame == iconFrame { return }
        iconFrame = frame
        guard let image = assets.trayIcon(frame: frame) else { return }
        // Only the online frame is a template image; disabled and running keep
        // their own colours.
        image.isTemplate = frame == .online
        statusItem?.button?.image = image
    }
}
#endif
