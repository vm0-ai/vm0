import XCTest

@testable import OkouDesktopKit

final class FilesystemPluginTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("okou-fs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("docs"), withIntermediateDirectories: true)
        try "hello\nworld\n".write(to: root.appendingPathComponent("docs/a.txt"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("b.md"), atomically: true, encoding: .utf8)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var tools: FilesystemTools {
        FilesystemTools(allowedDirectories: [root.path])
    }

    func testPathValidationAndSymlinks() throws {
        let tools = self.tools
        XCTAssertEqual(try tools.validatePath("docs/a.txt"), URL(fileURLWithPath: root.path + "/docs/a.txt").resolvingSymlinksInPath().path)
        XCTAssertThrowsError(try tools.validatePath("/etc/passwd")) { error in
            XCTAssertTrue(String(describing: error).hasPrefix("Access denied - path outside allowed directories"))
        }
        XCTAssertThrowsError(try tools.validatePath(root.path + "/../escape")) { error in
            XCTAssertTrue(String(describing: error).contains("outside allowed directories"))
        }
        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: URL(fileURLWithPath: "/tmp"))
        XCTAssertThrowsError(try tools.validatePath("link/x")) { error in
            XCTAssertTrue(String(describing: error).contains("symlink target outside allowed directories"))
        }
        // A missing tail resolves against the existing parent for create_directory.
        XCTAssertTrue(try tools.validatePath("docs/new/deeper").hasSuffix("/docs/new/deeper"))
        XCTAssertThrowsError(try tools.validatePath("C:\\Users\\x"))
    }

    func testToolsProduceUpstreamShapes() throws {
        let tools = self.tools
        XCTAssertEqual(try tools.readTextFile(path: "docs/a.txt", head: nil, tail: nil), "hello\nworld\n")
        XCTAssertEqual(try tools.readTextFile(path: "docs/a.txt", head: 1, tail: nil), "hello")
        XCTAssertEqual(try tools.readTextFile(path: "docs/a.txt", head: nil, tail: 2), "world\n")
        XCTAssertEqual(try tools.writeFile(path: "docs/c.txt", content: "new"), "Successfully wrote to docs/c.txt")
        XCTAssertEqual(try tools.readTextFile(path: "docs/c.txt", head: nil, tail: nil), "new")
        XCTAssertEqual(try tools.writeFile(path: "docs/c.txt", content: "replaced"), "Successfully wrote to docs/c.txt")
        XCTAssertEqual(try tools.readTextFile(path: "docs/c.txt", head: nil, tail: nil), "replaced")
        XCTAssertEqual(try tools.listDirectory(path: "docs").split(separator: "\n").sorted(), ["[FILE] a.txt", "[FILE] c.txt"])
        XCTAssertEqual(try tools.createDirectory(path: "docs/sub/inner"), "Successfully created directory docs/sub/inner")
        XCTAssertEqual(try tools.moveFile(source: "docs/c.txt", destination: "docs/sub/c.txt"), "Successfully moved docs/c.txt to docs/sub/c.txt")
        XCTAssertThrowsError(try tools.moveFile(source: "docs/a.txt", destination: "docs/sub/c.txt")) { error in
            XCTAssertTrue(String(describing: error).hasPrefix("Destination already exists"))
        }
        let search = try tools.searchFiles(path: ".", pattern: "**/*.txt", excludePatterns: ["**/sub/**"])
        XCTAssertEqual(search, URL(fileURLWithPath: root.path).resolvingSymlinksInPath().path + "/docs/a.txt")
        XCTAssertEqual(try tools.searchFiles(path: ".", pattern: "*.zip", excludePatterns: []), "No matches found")
        let tree = try JSONValue.parse(try tools.directoryTree(path: root.path, excludePatterns: ["sub"]))
        let names = tree.arrayValue?.compactMap { $0["name"]?.stringValue }.sorted()
        XCTAssertEqual(names, ["b.md", "docs"])
        let docs = tree.arrayValue?.first { $0["name"]?.stringValue == "docs" }
        XCTAssertEqual(docs?["children"]?.arrayValue?.compactMap { $0["name"]?.stringValue }, ["a.txt"])
        let info = try tools.getFileInfo(path: "b.md")
        XCTAssertTrue(info.contains("size: 1\n"))
        XCTAssertTrue(info.contains("isFile: true"))
        XCTAssertTrue(info.contains("permissions: "))
        let sizes = try tools.listDirectoryWithSizes(path: ".", sortBy: "size")
        XCTAssertTrue(sizes.contains("Total: 1 files, 2 directories"))
        XCTAssertTrue(sizes.contains("[FILE] b.md"))
        XCTAssertEqual(FilesystemTools.formatSize(1536), "1.50 KB")
        XCTAssertEqual(tools.listAllowedDirectories(), "Allowed directories:\n\(root.path)")
        XCTAssertTrue(tools.readMultipleFiles(paths: ["b.md", "missing.txt"]).contains("missing.txt: Error - "))
        if case let .image(_, mimeType) = try tools.readMediaFile(path: "b.md") { XCTFail("unexpected image \(mimeType)") }
    }

    func testEditFileProducesDiff() throws {
        let tools = self.tools
        let diff = try tools.editFile(path: "docs/a.txt", edits: [FilesystemTools.Edit(oldText: "world", newText: "there")], dryRun: true)
        XCTAssertTrue(diff.hasPrefix("```diff\n"))
        XCTAssertTrue(diff.contains("-world\n+there\n"))
        XCTAssertEqual(try tools.readTextFile(path: "docs/a.txt", head: nil, tail: nil), "hello\nworld\n")
        _ = try tools.editFile(path: "docs/a.txt", edits: [FilesystemTools.Edit(oldText: "  hello", newText: "  hi")], dryRun: false)
        XCTAssertEqual(try tools.readTextFile(path: "docs/a.txt", head: nil, tail: nil), "hi\nworld\n")
        XCTAssertThrowsError(try tools.editFile(path: "docs/a.txt", edits: [FilesystemTools.Edit(oldText: "nope", newText: "x")], dryRun: true)) { error in
            XCTAssertTrue(String(describing: error).hasPrefix("Could not find exact match for edit:"))
        }
    }

    func testGlobMatching() {
        XCTAssertTrue(Glob.matches("docs/a.txt", "**/*.txt"))
        XCTAssertTrue(Glob.matches("a.txt", "*.txt"))
        XCTAssertFalse(Glob.matches("docs/a.txt", "*.txt"))
        XCTAssertTrue(Glob.matches(".hidden/x", "**/x"))
        XCTAssertTrue(Glob.matches("node_modules/pkg/index.js", "**/node_modules/**"))
        XCTAssertTrue(Glob.matches("file1.log", "file[0-9].log"))
        XCTAssertFalse(Glob.matches("fileA.log", "file[0-9].log"))
        XCTAssertTrue(Glob.matches("a/b", "a/?"))
        XCTAssertEqual(Glob.relativePath(from: "/r", to: "/r/x/y"), "x/y")
    }

    @MainActor
    func testManagerFailureLadderAndCapabilities() async throws {
        let store = DesktopPreferencesStore(fileURL: root.appendingPathComponent("prefs.json"))
        var changes = 0
        let manager = DesktopFilesystemPluginManager(store: store) { changes += 1 }
        manager.load()
        let call = ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "filesystem", "tool": "list_allowed_directories", "arguments": [:]])
        let featureDisabled = await manager.execute(call)
        XCTAssertEqual(featureDisabled.failure?.code, .featureDisabled)
        manager.setFeatureEnabled(true)
        let pluginDisabled = await manager.execute(call)
        XCTAssertEqual(pluginDisabled.failure?.code, .pluginDisabled)
        try manager.setEnabled(true)
        let noDirectories = await manager.execute(call)
        XCTAssertEqual(noDirectories.failure?.message, "Filesystem plugin has no allowed directories.")
        try manager.addAllowedDirectory(root.path)
        let offline = await manager.execute(call)
        XCTAssertEqual(offline.failure?.code, .pluginUnavailable)
        manager.setHostRuntimeOnline(true)
        XCTAssertEqual(manager.state.status, .running)
        XCTAssertTrue(manager.capabilities.contains("plugin.filesystem.read_text_file"))
        XCTAssertEqual(manager.capabilities.count, 2 + FilesystemTools.toolNames.count)
        let listed = await manager.execute(call)
        XCTAssertEqual(listed.result?["content"]?.stringValue, "Allowed directories:\n\(root.path)")
        let read = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "filesystem", "tool": "read_text_file", "arguments": ["path": "docs/a.txt"]]))
        XCTAssertEqual(read.result?["content"]?.stringValue, "hello\nworld\n")
        let denied = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "filesystem", "tool": "read_text_file", "arguments": ["path": "/etc/hosts"]]))
        XCTAssertEqual(denied.failure?.code, .pathDenied)
        let invalid = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "filesystem", "tool": "read_text_file", "arguments": ["path": "a", "head": 1, "tail": 1]]))
        XCTAssertEqual(invalid.failure, ComputerUseCommandFailure(code: .invalidArguments, message: "read_text_file accepts either head or tail, not both"))
        let unknown = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "filesystem", "tool": "rm_rf", "arguments": [:]]))
        XCTAssertEqual(unknown.failure?.code, .unknownTool)
        XCTAssertTrue(changes >= 4)
        XCTAssertEqual(try store.read()["computerUsePlugins"]?["filesystem"]?["allowedDirectories"], .array([.string(root.path)]))
    }
}
