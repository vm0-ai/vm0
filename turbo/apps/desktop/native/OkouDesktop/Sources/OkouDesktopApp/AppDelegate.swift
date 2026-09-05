#if canImport(AppKit)
import AppKit
import OkouDesktopKit

@MainActor
final class OkouAppDelegate: NSObject, NSApplicationDelegate {
    private var runtime: DesktopAppRuntime?
    private var pendingOpenURLs: [String] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Register before launch finishes so a cold-start URL is delivered.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
        // Launch as a menu-bar app; the Dock icon appears with the main window.
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let runtime = try DesktopAppRuntime.bootstrap()
            self.runtime = runtime
            if runtime.terminateBecauseAnotherInstanceIsRunning() {
                NSApp.terminate(nil)
                return
            }
            runtime.start(launchArguments: CommandLine.arguments + pendingOpenURLs)
            pendingOpenURLs.removeAll()
        } catch {
            DesktopDegradedMode.report(error: error)
            NSApp.terminate(nil)
        }
    }

    @objc private func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else {
            return
        }
        if let runtime {
            runtime.handleOpenURL(urlString)
        } else {
            pendingOpenURLs.append(urlString)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        runtime?.showMainWindow()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let runtime else {
            return .terminateNow
        }
        return runtime.applicationShouldTerminate()
    }
}
#endif
