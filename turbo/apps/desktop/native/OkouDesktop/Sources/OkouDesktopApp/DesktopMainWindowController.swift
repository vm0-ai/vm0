#if canImport(AppKit)
import AppKit
import OkouDesktopKit
import SwiftUI

/// The single 1024x700 non-resizable main window. Closing hides it and drops
/// the Dock icon, like the Electron shell on macOS.
@MainActor
final class DesktopMainWindowController: NSObject, NSWindowDelegate {
    static let size = NSSize(width: 1024, height: 700)

    let window: NSWindow
    private unowned let runtime: DesktopAppRuntime

    init(runtime: DesktopAppRuntime) {
        self.runtime = runtime
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = runtime.config.identity.displayName
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(srgbRed: 0x19 / 255, green: 0x19 / 255, blue: 0x1b / 255, alpha: 1)
        window.contentMinSize = Self.size
        window.contentMaxSize = Self.size
        window.collectionBehavior = [.fullScreenNone]
        window.center()
        self.window = window
        super.init()
        window.delegate = self
        window.contentView = NSHostingView(rootView: DesktopShellView(state: runtime.shellState, runtime: runtime))
    }

    func showAndFocus() {
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        runtime.mainWindowDidHide()
        return false
    }
}
#endif
