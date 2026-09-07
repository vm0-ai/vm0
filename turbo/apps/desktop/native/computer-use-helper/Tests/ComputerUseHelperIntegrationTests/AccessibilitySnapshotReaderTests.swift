import Foundation
import Testing

struct AccessibilitySnapshotReaderTests {
    @Test
    func readsNativeAttributesAndRefreshesValuesForTheNextSnapshot() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("snapshot-reader-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let reader = package.appendingPathComponent("Sources/ComputerUseHelperCore/AccessibilitySnapshotReader.swift")
        let source = directory.appendingPathComponent("main.swift")
        try """
        import AppKit
        import ApplicationServices
        import Foundation

        final class Columns: NSObject, NSBrowserDelegate {
            func browser(_ sender: NSBrowser, numberOfRowsInColumn column: Int) -> Int { 80 }
            func browser(_ sender: NSBrowser, willDisplayCell cell: Any, atRow row: Int, column: Int) {
                let item = cell as! NSBrowserCell
                item.stringValue = "Owned Row \\(row)"
                item.isLeaf = true
            }
        }
        let columns = Columns()
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 280, height: 120),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Snapshot Before"
        let field = NSTextField(string: "Before 👩‍💻 é")
        field.frame = NSRect(x: 10, y: 25, width: 250, height: 30)
        window.contentView!.addSubview(field)
        window.orderFrontRegardless()
        let pid = getpid()
        RunLoop.main.perform {
            DispatchQueue.global().async {
                var failures: [String] = []
                func check(_ condition: Bool, _ message: String) {
                    if !condition { failures.append(message) }
                }
                func single(_ element: AXUIElement, _ name: CFString) -> Any? {
                    var value: CFTypeRef?
                    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
                }
                let root = AXUIElementCreateApplication(pid)
                let windows = single(root, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
                check(windows.count == 1, "The native fixture must expose its own window")
                if let target = windows.first {
                    var errors: [AXError] = []
                    func fresh() -> AccessibilitySnapshotReader {
                        AccessibilitySnapshotReader(timeoutSeconds: 1) { error, _ in errors.append(error) }
                    }
                    let first = fresh()
                    check(first.value(target, kAXTitleAttribute as CFString) as? String == "Snapshot Before", "Window title")
                    first.prefetch(target, [kAXChildrenAttribute as CFString, "AXMissingSnapshotAttribute" as CFString])
                    let children = first.value(target, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
                    check(!children.isEmpty, "Batch attributes must retain AX element arrays")
                    check(first.value(target, "AXMissingSnapshotAttribute" as CFString) == nil, "An unsupported attribute is absent")
                    let fields = children.filter { single($0, kAXRoleAttribute as CFString) as? String == "AXTextField" }
                    check(fields.count == 1, "The native text field must be exposed")
                    if let text = fields.first {
                        check(first.value(text, kAXValueAttribute as CFString) as? String == "Before 👩‍💻 é", "Unicode value")
                        check(first.value(text, kAXEnabledAttribute as CFString) as? Bool == true, "Boolean metadata")
                        if let point = first.value(text, kAXPositionAttribute as CFString) {
                            check(CFGetTypeID(point as CFTypeRef) == AXValueGetTypeID(), "Geometry must remain an AXValue")
                        } else { failures.append("Missing native geometry") }
                        DispatchQueue.main.sync { window.title = "Snapshot After"; field.stringValue = "After ✅" }
                        check(single(target, kAXTitleAttribute as CFString) as? String == "Snapshot After", "Independent native title changed")
                        check(single(text, kAXValueAttribute as CFString) as? String == "After ✅", "Independent native value changed")
                        check(first.value(target, kAXTitleAttribute as CFString) as? String == "Snapshot Before", "A capture retains its observed title")
                        check(first.value(text, kAXValueAttribute as CFString) as? String == "Before 👩‍💻 é", "A capture retains its observed value")
                        let next = fresh()
                        check(next.value(target, kAXTitleAttribute as CFString) as? String == "Snapshot After", "The next capture refreshes title")
                        check(next.value(text, kAXValueAttribute as CFString) as? String == "After ✅", "The next capture refreshes value")
                        DispatchQueue.main.sync {
                            let browser = NSBrowser(frame: NSRect(x: 10, y: 65, width: 250, height: 45))
                            browser.delegate = columns
                            browser.minColumnWidth = 240
                            window.contentView!.addSubview(browser)
                            browser.loadColumnZero()
                        }
                        let collection = fresh()
                        var pending = collection.value(target, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
                        var visited: Set<AXUIElement> = []
                        var inspectedList = false
                        while let item = pending.popLast() {
                            if !visited.insert(item).inserted { continue }
                            if collection.value(item, kAXRoleAttribute as CFString) as? String == "AXList" {
                                let all = collection.value(item, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
                                let visible = collection.value(item, "AXVisibleChildren" as CFString) as? [AXUIElement]
                                check(all.count == 80, "The native browser exposes all rows")
                                check(visible != nil && visible!.count < all.count, "Visible rows must remain distinct from every row")
                                inspectedList = true
                                break
                            }
                            pending += collection.value(item, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
                        }
                        check(inspectedList, "The native column browser must expose its list")
                    }
                    check(errors.contains(.attributeUnsupported), "Batch attribute errors must be decoded")
                    check(!errors.contains(.cannotComplete), "A responding provider must not be reported as timed out")
                }
                let response = ["failures": failures]
                let data = try! JSONSerialization.data(withJSONObject: response)
                FileHandle.standardOutput.write(data)
                let failed = !failures.isEmpty
                RunLoop.main.perform { window.close(); exit(failed ? 1 : 0) }
            }
        }
        app.run()
        """.write(to: source, atomically: true, encoding: .utf8)
        let executable = directory.appendingPathComponent("fixture")
        _ = try run("/usr/bin/xcrun", ["swiftc", reader.path, source.path, "-o", executable.path])
        let result = try run(executable.path, [])
        let data = try #require(result.data(using: .utf8))
        let response = try #require(JSONSerialization.jsonObject(with: data) as? [String: [String]])
        #expect(response["failures"] == [])
    }

    private func run(_ executable: String, _ arguments: [String]) throws -> String {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errors
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
        guard ended.wait(timeout: .now() + 60) == .success else {
            process.terminate()
            throw SnapshotReaderFailure(message: "The native snapshot fixture timed out")
        }
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let errorText = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard process.terminationStatus == 0 else { throw SnapshotReaderFailure(message: text + errorText) }
        return text
    }
}

private struct SnapshotReaderFailure: Error {
    let message: String
}
