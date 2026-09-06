import AppKit
import ComputerUseHelperCore
import Foundation
import Testing

struct WindowServerVisibilityTests {
    @Test
    func keepsOccludedWindowsButExcludesHiddenWindowsWithAVisiblePanel() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("window-visibility-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let appURL = directory.appendingPathComponent("Visibility Fixture.app")
        let contents = appURL.appendingPathComponent("Contents")
        let macOS = contents.appendingPathComponent("MacOS")
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        let bundleID = "ai.vm0.visibility-test.\(UUID().uuidString.lowercased())"
        let plist: [String: Any] = [
            "CFBundleIdentifier": bundleID, "CFBundleExecutable": "fixture",
            "CFBundleName": "Visibility Fixture", "CFBundlePackageType": "APPL",
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        let source = directory.appendingPathComponent("Fixture.swift")
        try """
        import AppKit
        final class Delegate: NSObject, NSApplicationDelegate {
            var main: NSWindow!
            var panel: NSPanel!
            var timer: Timer!
            let root = URL(fileURLWithPath: CommandLine.arguments.last!)
            func applicationDidFinishLaunching(_ notification: Notification) {
                let frame = NSRect(x: 100, y: 100, width: 300, height: 200)
                main = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
                panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                    backing: .buffered, defer: false)
                panel.level = .floating
                panel.hidesOnDeactivate = false
                main.orderFrontRegardless()
                panel.setFrame(main.frame, display: true)
                panel.orderFrontRegardless()
                let ids = ["pid": Int(getpid()), "main": main.windowNumber, "panel": panel.windowNumber]
                try! JSONSerialization.data(withJSONObject: ids).write(to: root.appendingPathComponent("ready"))
                timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [self] _ in
                    let file = root.appendingPathComponent("command")
                    guard let command = try? String(contentsOf: file, encoding: .utf8) else { return }
                    try? FileManager.default.removeItem(at: file)
                    switch command {
                    case "panel": main.orderOut(nil)
                    case "hidden": main.orderOut(nil); panel.orderOut(nil)
                    case "restore": main.orderFrontRegardless()
                    default: break
                    }
                }
            }
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = Delegate(); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
        """.write(to: source, atomically: true, encoding: .utf8)
        try run("/usr/bin/xcrun", ["swiftc", source.path, "-o", macOS.appendingPathComponent("fixture").path])
        try run("/usr/bin/open", ["-n", "-a", appURL.path, "--args", directory.path])
        defer {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleID) {
                if !app.isTerminated { app.forceTerminate() }
            }
        }
        let ready = directory.appendingPathComponent("ready")
        guard waitUntil({ FileManager.default.fileExists(atPath: ready.path) }) else {
            throw VisibilityFailure(message: "The fixture did not start")
        }
        let ids = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: Int])
        let pid = pid_t(try #require(ids["pid"]))
        let main = try #require(ids["main"])
        let panel = try #require(ids["panel"])
        let app = try #require(NSRunningApplication(processIdentifier: pid))
        #expect(app.bundleIdentifier == bundleID)

        func visible() -> Set<Int> {
            Set(windowServerWindows(ownerPID: pid, onScreenOnly: true)
                .compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue })
        }
        func send(_ value: String) throws {
            try value.write(to: directory.appendingPathComponent("command"), atomically: true, encoding: .utf8)
        }
        #expect(waitUntil { visible().isSuperset(of: [main, panel]) }, "An occluded main window remains capturable")
        try send("panel")
        #expect(waitUntil { visible().contains(panel) && !visible().contains(main) })
        #expect(windowServerWindows(ownerPID: -1, onScreenOnly: false).isEmpty)
        try send("hidden")
        #expect(waitUntil { visible().isDisjoint(with: [main, panel]) })
        try send("restore")
        #expect(waitUntil { visible().contains(main) && !visible().contains(panel) })
        #expect(app.terminate())
        #expect(waitUntil { kill(pid, 0) != 0 && errno == ESRCH })
    }

    private func waitUntil(_ condition: () -> Bool) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        repeat {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        } while ProcessInfo.processInfo.systemUptime < deadline
        return false
    }

    private func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
        guard ended.wait(timeout: .now() + 60) == .success else {
            process.terminate()
            throw VisibilityFailure(message: "Fixture command timed out")
        }
        guard process.terminationStatus == 0 else {
            throw VisibilityFailure(message: "Fixture command failed")
        }
    }
}

private struct VisibilityFailure: Error {
    let message: String
}
