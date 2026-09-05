#if canImport(AppKit)
import AppKit
import OkouDesktopKit
import SwiftUI

/// Electron reports display geometry in global points with a top-left
/// origin; AppKit uses a bottom-left origin on the primary screen. All
/// recorder geometry stays in the Electron space and converts at the edge.
enum ScreenGeometry {
    static var primaryScreen: NSScreen? {
        NSScreen.screens.first
    }

    static var primaryHeight: CGFloat {
        primaryScreen?.frame.height ?? 0
    }

    static func overlayRect(_ frame: NSRect) -> OverlayRect {
        OverlayRect(x: frame.minX, y: primaryHeight - frame.maxY, width: frame.width, height: frame.height)
    }

    static func appKitFrame(_ rect: OverlayRect) -> NSRect {
        NSRect(x: rect.x, y: primaryHeight - rect.y - rect.height, width: rect.width, height: rect.height)
    }

    static func displayId(_ screen: NSScreen) -> UInt32 {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    static func screen(displayId target: UInt32) -> NSScreen? {
        NSScreen.screens.first { Self.displayId($0) == target }
    }

    /// The screen with the largest intersection, like `screen.getDisplayMatching`.
    static func screen(matching rect: OverlayRect) -> NSScreen {
        let frame = appKitFrame(rect)
        var best: (NSScreen, CGFloat)? = nil
        for screen in NSScreen.screens {
            let intersection = screen.frame.intersection(frame)
            let area = intersection.isNull ? 0 : intersection.width * intersection.height
            if best == nil || area > best!.1 {
                best = (screen, area)
            }
        }
        return best?.0 ?? primaryScreen ?? NSScreen.main!
    }

    static func bounds(_ screen: NSScreen) -> OverlayRect {
        overlayRect(screen.frame)
    }

    static func workArea(_ screen: NSScreen) -> OverlayRect {
        overlayRect(screen.visibleFrame)
    }
}

/// Borderless always-on-top panel that can take keyboard focus for Escape.
final class RecorderOverlayPanel: NSPanel {
    var onEscape: (() -> Void)? = nil

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53, let onEscape {
            onEscape()
            return
        }
        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}

/// Port of `DesktopRecorderWindows`: the bar, one area selector per display,
/// the window picker and the controller shown while recording.
@MainActor
final class DesktopRecorderWindows {
    private let bridge: RecorderWindowBridge
    private var bar: RecorderOverlayPanel? = nil
    private var areaSelectors: [RecorderOverlayPanel] = []
    private var windowPicker: RecorderOverlayPanel? = nil
    private var controller: RecorderOverlayPanel? = nil
    private var pendingWindowChoice: CheckedContinuation<DesktopRecorderWindowChoice?, Never>? = nil

    init(bridge: RecorderWindowBridge) {
        self.bridge = bridge
    }

    func displaySourceId(_ displayId: UInt32) -> String {
        "display:\(displayId)"
    }

    /// The screen the bar is on, which is the one a display capture records.
    func barDisplayId() -> UInt32 {
        guard let bar, bar.isVisible else {
            return ScreenGeometry.displayId(ScreenGeometry.primaryScreen ?? NSScreen.main!)
        }
        return ScreenGeometry.displayId(ScreenGeometry.screen(matching: ScreenGeometry.overlayRect(bar.frame)))
    }

    func displayBounds(_ displayId: UInt32) -> OverlayRect? {
        ScreenGeometry.screen(displayId: displayId).map(ScreenGeometry.bounds)
    }

    /// Always a fresh bar so the previous session's choices cannot leak.
    func showBar() {
        closeBar()
        guard let screen = ScreenGeometry.primaryScreen else { return }
        let panel = makeOverlay(bounds: RecorderOverlayGeometry.recorderBarBounds(display: ScreenGeometry.workArea(screen)), movable: true)
        let model = RecorderBarModel(bridge: bridge)
        panel.contentView = NSHostingView(rootView: RecorderBarView(model: model).ignoresSafeArea())
        panel.onEscape = { [weak self] in self?.bridge.cancel() }
        bar = panel
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func hideBar() {
        closeBar()
    }

    func openAreaSelectors() {
        closeAreaSelectors()
        for screen in NSScreen.screens {
            let displayId = ScreenGeometry.displayId(screen)
            let panel = makeOverlay(bounds: ScreenGeometry.bounds(screen), movable: false)
            let model = RecorderAreaSelectorModel(displayId: displayId, bridge: bridge)
            panel.contentView = NSHostingView(rootView: RecorderAreaSelectorView(model: model).ignoresSafeArea())
            panel.onEscape = { [weak self] in self?.bridge.completeAreaSelection(nil) }
            areaSelectors.append(panel)
            panel.orderFrontRegardless()
        }
        areaSelectors.first?.makeKey()
        NSApp.activate()
    }

    func closeAreaSelectors() {
        let open = areaSelectors
        areaSelectors = []
        for panel in open {
            panel.orderOut(nil)
            panel.close()
        }
    }

    /// Resolves with the chosen window, or nil when the picker is dismissed.
    func selectWindow() async -> DesktopRecorderWindowChoice? {
        closeWindowPicker()
        guard let screen = ScreenGeometry.primaryScreen else { return nil }
        let origin = RecorderOverlayGeometry.centredBounds(display: ScreenGeometry.workArea(screen), size: RecorderOverlayGeometry.windowPickerSize)
        let panel = makeOverlay(
            bounds: OverlayRect(x: origin.x, y: origin.y, width: RecorderOverlayGeometry.windowPickerSize.width, height: RecorderOverlayGeometry.windowPickerSize.height),
            movable: true
        )
        let model = RecorderWindowPickerModel(bridge: bridge)
        panel.contentView = NSHostingView(rootView: RecorderWindowPickerView(model: model).ignoresSafeArea())
        panel.onEscape = { [weak self] in self?.bridge.completeWindowSelection(nil) }
        windowPicker = panel
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate()
        return await withCheckedContinuation { continuation in
            pendingWindowChoice = continuation
        }
    }

    func completeWindowSelection(_ choice: DesktopRecorderWindowChoice?) {
        settleWindowChoice(choice)
        closeWindowPicker()
    }

    /// The controller sits beside an area capture; a display capture keeps it in frame.
    func showController(captured: DesktopRecorderArea?) {
        closeController()
        let screen = captured.map { ScreenGeometry.screen(matching: OverlayRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height)) }
            ?? ScreenGeometry.primaryScreen ?? NSScreen.main!
        let position: OverlayPoint
        if let captured {
            position = RecorderOverlayGeometry.recorderControllerBounds(captured: captured, display: ScreenGeometry.bounds(screen))
        } else {
            position = RecorderOverlayGeometry.bottomCentredBounds(display: ScreenGeometry.workArea(screen), size: RecorderOverlayGeometry.controllerSize, margin: 24)
        }
        let panel = makeOverlay(
            bounds: OverlayRect(x: position.x, y: position.y, width: RecorderOverlayGeometry.controllerSize.width, height: RecorderOverlayGeometry.controllerSize.height),
            movable: true
        )
        panel.contentView = NSHostingView(rootView: RecorderControllerView(model: bridge.uiState, bridge: bridge).ignoresSafeArea())
        controller = panel
        panel.orderFrontRegardless()
    }

    func hideController() {
        closeController()
    }

    func closeAll() {
        closeController()
        closeAreaSelectors()
        closeWindowPicker()
        closeBar()
    }

    private func makeOverlay(bounds: OverlayRect, movable: Bool) -> RecorderOverlayPanel {
        let panel = RecorderOverlayPanel(
            contentRect: ScreenGeometry.appKitFrame(bounds),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = movable
        panel.isFloatingPanel = true
        return panel
    }

    private func settleWindowChoice(_ choice: DesktopRecorderWindowChoice?) {
        let continuation = pendingWindowChoice
        pendingWindowChoice = nil
        continuation?.resume(returning: choice)
    }

    private func closeBar() {
        let panel = bar
        bar = nil
        panel?.orderOut(nil)
        panel?.close()
    }

    private func closeWindowPicker() {
        let panel = windowPicker
        windowPicker = nil
        settleWindowChoice(nil)
        panel?.orderOut(nil)
        panel?.close()
    }

    private func closeController() {
        let panel = controller
        controller = nil
        panel?.orderOut(nil)
        panel?.close()
    }
}
#endif
