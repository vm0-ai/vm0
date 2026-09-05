import Foundation
import Testing

@testable import DesktopCore

@Suite struct FilesystemParityTests {
  @Test func preservesFilesystemServerMatchingAndEditing() throws {
    let fixture = try #require(
      Bundle.module.url(forResource: "filesystem", withExtension: "json", subdirectory: "Fixtures"))
    let cases = try JSON.decode(Data(contentsOf: fixture))
    for row in cases["globs"].array {
      let pattern = try row.requireString("pattern")
      let path = try row.requireString("path")
      #expect(
        FilesystemMatching.matches(pattern, path: path) == row["expected"].bool,
        "\(pattern) against \(path)")
    }
    for row in cases["edits"].array {
      let result = try FilesystemMatching.edit(
        row.requireString("original"), edits: row["edits"].array)
      #expect(result == row["expected"].string, "\(row["name"])")
    }
  }

  @Test func partialReadsSearchAndMetadataKeepTheirPublicBehavior() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let sub = root.appendingPathComponent("sub")
    try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("a.txt")
    try Data("hello".utf8).write(to: file)
    try Data("nested".utf8).write(to: sub.appendingPathComponent("b.txt"))
    let tools = FilesystemTools()
    func call(_ tool: String, _ args: [String: JSON]) async -> JSON {
      await tools.execute(
        .object(["tool": .string(tool), "arguments": .object(args)]),
        allowedDirectories: [root.path])
    }
    let partial = await call(
      "read_multiple_files",
      ["paths": .strings([file.path, root.appendingPathComponent("missing").path])])
    #expect(partial["status"].string == "succeeded")
    #expect(partial["result"]["content"].string?.contains("hello\n") == true)
    #expect(partial["result"]["content"].string?.contains("Error -") == true)
    let current = await call(
      "search_files", ["path": .string(root.path), "pattern": .string("*.txt")])
    #expect(
      URL(fileURLWithPath: try current["result"].requireString("content")).resolvingSymlinksInPath()
        == file.resolvingSymlinksInPath())
    let recursive = await call(
      "search_files", ["path": .string(root.path), "pattern": .string("**/*.txt")])
    #expect(recursive["result"]["content"].string?.components(separatedBy: "\n").count == 2)
    let excluded = await call(
      "search_files",
      [
        "path": .string(root.path), "pattern": .string("**/*.txt"),
        "excludePatterns": .strings(["sub"]),
      ])
    #expect(
      URL(fileURLWithPath: try excluded["result"].requireString("content"))
        .resolvingSymlinksInPath() == file.resolvingSymlinksInPath())
    let sizes = await call("list_directory_with_sizes", ["path": .string(root.path)])
    #expect(sizes["result"]["content"].string?.contains("Total: 1 files, 1 directories") == true)
    #expect(sizes["result"]["content"].string?.contains("Combined size: 5 B") == true)
    let large = root.appendingPathComponent("large.log")
    let handle = FileManager.default.createFile(atPath: large.path, contents: Data("first\n".utf8))
    #expect(handle)
    let output = try FileHandle(forWritingTo: large)
    try output.seek(toOffset: UInt64(PluginResult.maximumBytes + 1024))
    try output.write(contentsOf: Data("\nlast".utf8))
    try output.close()
    let head = await call("read_text_file", ["path": .string(large.path), "head": .number(1)])
    let tail = await call("read_text_file", ["path": .string(large.path), "tail": .number(1)])
    #expect(head["result"]["content"].string == "first")
    #expect(tail["result"]["content"].string == "last")
    let info = await call("get_file_info", ["path": .string(file.path)])
    #expect(info["result"]["content"].string?.contains("isFile: true") == true)
    #expect(info["result"]["content"].string?.contains("size: 5") == true)
  }
}
