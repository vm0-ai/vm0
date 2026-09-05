import AppKit
import Foundation
import Testing

private final class DiscoveryTestBundle: NSObject {}

private struct DiscoveryFailure: Error {
    let message: String
}

/// Exercises the real JSONL helper while another process launches and exits.
struct AppDiscoveryTests {
    @Test
    func observesExternalLaunchExitAndRelaunch() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("app-discovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let bundleID = "ai.vm0.discovery-test.\(UUID().uuidString.lowercased())"
        let appURL = try buildFixture(in: directory, bundleID: bundleID)
        let ready = directory.appendingPathComponent("ready")
        let client = try DiscoveryClient(directory: directory)
        defer { client.stop() }
        #expect(try listedPID(client, bundleID: bundleID) == nil)

        var ownedApp: NSRunningApplication?
        defer { if let ownedApp, !ownedApp.isTerminated { ownedApp.forceTerminate() } }
        var previousPID: pid_t?
        for _ in 0..<2 {
            if FileManager.default.fileExists(atPath: ready.path) {
                try FileManager.default.removeItem(at: ready)
            }
            try runProcess("/usr/bin/open", ["-n", "-a", appURL.path, "--args", ready.path])
            let pid = try waitForReady(ready)
            #expect(pid != previousPID)
            ownedApp = NSRunningApplication(processIdentifier: pid)
            #expect(ownedApp?.bundleIdentifier == bundleID)
            let discovered = try waitForListing(client, bundleID: bundleID, expected: pid)
            #expect(discovered, "A persistent helper must discover an externally launched app")
            guard discovered else { return }

            #expect(ownedApp?.terminate() == true)
            let exited = waitUntil { kill(pid, 0) != 0 && errno == ESRCH }
            #expect(exited, "The owned fixture must exit before checking removal")
            guard exited else { return }
            #expect(try waitForListing(client, bundleID: bundleID, expected: nil))
            previousPID = pid
            ownedApp = nil
        }
        try client.finish()
    }

    private func buildFixture(in directory: URL, bundleID: String) throws -> URL {
        let appURL = directory.appendingPathComponent("Discovery Fixture.app")
        let contents = appURL.appendingPathComponent("Contents")
        let macOS = contents.appendingPathComponent("MacOS")
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": bundleID, "CFBundleExecutable": "discovery-fixture",
            "CFBundleName": "Discovery Fixture", "CFBundlePackageType": "APPL",
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        let source = directory.appendingPathComponent("Fixture.swift")
        try """
        import AppKit
        final class Delegate: NSObject, NSApplicationDelegate {
            var window: NSWindow!
            func applicationDidFinishLaunching(_ notification: Notification) {
                window = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 240, height: 100),
                    styleMask: [.titled, .closable], backing: .buffered, defer: false)
                window.title = "Owned discovery fixture"
                window.orderFrontRegardless()
                RunLoop.main.perform {
                    try! String(ProcessInfo.processInfo.processIdentifier).write(
                        toFile: CommandLine.arguments.last!, atomically: true, encoding: .utf8)
                }
            }
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = Delegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
        """.write(to: source, atomically: true, encoding: .utf8)
        try runProcess("/usr/bin/xcrun", [
            "swiftc", source.path, "-o", macOS.appendingPathComponent("discovery-fixture").path,
        ])
        return appURL
    }

    private func runProcess(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
        guard ended.wait(timeout: .now() + 60) == .success else {
            process.terminate()
            throw DiscoveryFailure(message: "Timed out: \(executable)")
        }
        guard process.terminationStatus == 0 else {
            throw DiscoveryFailure(message: "Failed: \(executable)")
        }
    }

    private func waitUntil(_ condition: () throws -> Bool) rethrows -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        repeat {
            if try condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        } while ProcessInfo.processInfo.systemUptime < deadline
        return false
    }

    private func waitForReady(_ ready: URL) throws -> pid_t {
        guard waitUntil({ FileManager.default.fileExists(atPath: ready.path) }),
              let pid = pid_t(try String(contentsOf: ready, encoding: .utf8)) else {
            throw DiscoveryFailure(message: "The owned app did not become ready")
        }
        return pid
    }

    private func listedPID(_ client: DiscoveryClient, bundleID: String) throws -> pid_t? {
        let response = try client.request(["kind": "apps.list"])
        let result = try #require(response["result"] as? [String: Any])
        let apps = try #require(result["apps"] as? [[String: Any]])
        return apps.first { $0["bundleId"] as? String == bundleID && $0["running"] as? Bool == true }
            .flatMap { ($0["pid"] as? Int).map(pid_t.init) }
    }

    private func waitForListing(_ client: DiscoveryClient, bundleID: String, expected: pid_t?) throws -> Bool {
        try waitUntil { try listedPID(client, bundleID: bundleID) == expected }
    }
}

private final class DiscoveryClient {
    private let process = Process()
    private let input = Pipe()
    private let output: FileHandle
    private let ended = DispatchSemaphore(value: 0)
    private var pending = Data()

    init(directory: URL) throws {
        let executable = Bundle(for: DiscoveryTestBundle.self).bundleURL
            .deletingLastPathComponent().appendingPathComponent("computer-use-helper")
        let path = directory.appendingPathComponent("responses.jsonl")
        FileManager.default.createFile(atPath: path.path, contents: Data())
        output = try FileHandle(forReadingFrom: path)
        process.executableURL = executable
        process.arguments = ["--stdio"]
        process.standardInput = input
        process.standardOutput = try FileHandle(forWritingTo: path)
        process.standardError = FileHandle.nullDevice
        let ended = ended
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
    }

    func request(_ fields: [String: Any]) throws -> [String: Any] {
        let id = UUID().uuidString
        var data = try JSONSerialization.data(withJSONObject: fields.merging(["id": id]) { _, new in new })
        data.append(10)
        try input.fileHandleForWriting.write(contentsOf: data)
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        repeat {
            pending.append(try output.readToEnd() ?? Data())
            if let newline = pending.firstIndex(of: 10) {
                let line = pending.prefix(upTo: newline)
                let response = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
                pending.removeSubrange(...newline)
                #expect(response["id"] as? String == id)
                #expect(response["status"] as? String == "succeeded")
                return response
            }
            Thread.sleep(forTimeInterval: 0.01)
        } while ProcessInfo.processInfo.systemUptime < deadline
        throw DiscoveryFailure(message: "The helper did not reply")
    }

    func finish() throws {
        try input.fileHandleForWriting.close()
        #expect(ended.wait(timeout: .now() + 5) == .success)
        #expect(!process.isRunning)
        if !process.isRunning { #expect(process.terminationStatus == 0) }
    }

    func stop() {
        if process.isRunning { process.terminate() }
        try? input.fileHandleForWriting.close()
        try? output.close()
    }
}
