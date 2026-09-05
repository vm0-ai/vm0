import Foundation

#if canImport(UniformTypeIdentifiers)
  import UniformTypeIdentifiers
#endif

/// File access is scoped to the directories explicitly selected in the native
/// settings window. Resolving links precedes every operation, including writes.
public actor FilesystemTools {
  public static let tools = [
    "list_allowed_directories", "read_text_file", "read_media_file", "read_multiple_files",
    "write_file", "edit_file", "create_directory", "list_directory", "list_directory_with_sizes",
    "directory_tree", "move_file", "search_files", "get_file_info",
  ]
  private let manager = FileManager.default

  public init() {}

  public func execute(_ payload: JSON, allowedDirectories: [String]) -> JSON {
    do {
      let tool = try payload.requireString("tool")
      guard Self.tools.contains(tool) else {
        throw DesktopFailure("unknown_tool", "Unknown filesystem tool: \(tool)")
      }
      let roots = allowedDirectories.map {
        URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath()
      }
      guard !roots.isEmpty else {
        throw DesktopFailure("plugin_disabled", "Choose at least one allowed directory")
      }
      let args = payload["arguments"]
      let context: JSON = .object(["plugin": .string("filesystem"), "tool": .string(tool)])
      if tool == "list_allowed_directories" {
        return try PluginResult.text(
          "Allowed directories:\n" + roots.map(\.path).joined(separator: "\n"), context: context)
      }
      if tool == "read_multiple_files" {
        let paths = args["paths"].array.compactMap(\.string)
        guard !paths.isEmpty, paths.count <= 100 else {
          throw DesktopFailure("invalid_arguments", "paths must contain 1 to 100 files")
        }
        let text = try paths.map { path in
          let url = try allowed(path, roots: roots)
          return path + ":\n" + (try readText(url))
        }.joined(separator: "\n---\n")
        return try PluginResult.text(text, context: context)
      }
      if tool == "move_file" {
        let source = try allowed(args.requireString("source"), roots: roots)
        let destination = try allowed(args.requireString("destination"), roots: roots)
        try manager.moveItem(at: source, to: destination)
        return try PluginResult.text(
          "Moved \(source.path) to \(destination.path)", context: context)
      }
      let path = try allowed(args.requireString("path"), roots: roots)
      let result: String
      switch tool {
      case "read_text_file":
        let text = try readText(path)
        let lines = text.components(separatedBy: "\n")
        if args["head"].number != nil && args["tail"].number != nil {
          throw DesktopFailure("invalid_arguments", "Use head or tail, not both")
        }
        if let head = args["head"].number {
          guard head > 0, head.rounded() == head else {
            throw DesktopFailure("invalid_arguments", "head must be a positive integer")
          }
          result = lines.prefix(Int(min(head, Double(lines.count)))).joined(separator: "\n")
        } else if let tail = args["tail"].number {
          guard tail > 0, tail.rounded() == tail else {
            throw DesktopFailure("invalid_arguments", "tail must be a positive integer")
          }
          result = lines.suffix(Int(min(tail, Double(lines.count)))).joined(separator: "\n")
        } else {
          result = text
        }
      case "read_media_file":
        let data = try readBounded(path)
        #if canImport(UniformTypeIdentifiers)
          let mime =
            UTType(filenameExtension: path.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        #else
          let mime = "application/octet-stream"
        #endif
        return try PluginResult.binary(
          data, mimeType: mime, fileName: path.lastPathComponent, context: context)
      case "write_file":
        guard let content = args["content"].string else {
          throw DesktopFailure("invalid_arguments", "content must be a string")
        }
        let data = Data(content.utf8)
        guard data.count <= PluginResult.maximumBytes else {
          throw DesktopFailure("input_too_large", "File content exceeds 10 MiB")
        }
        try data.write(to: path, options: .atomic)
        result = "Successfully wrote to \(path.path)"
      case "edit_file":
        let original = try readText(path)
        var edited = original
        let edits = args["edits"].array
        guard !edits.isEmpty, edits.count <= 1000 else {
          throw DesktopFailure("invalid_arguments", "edits must contain 1 to 1000 edits")
        }
        for edit in edits {
          let old = try edit.requireString("oldText")
          guard let replacement = edit["newText"].string else {
            throw DesktopFailure("invalid_arguments", "newText must be a string")
          }
          guard let range = edited.range(of: old) else {
            throw DesktopFailure("mcp_error", "Could not find oldText in \(path.path)")
          }
          edited.replaceSubrange(range, with: replacement)
        }
        guard edited.utf8.count <= PluginResult.maximumBytes else {
          throw DesktopFailure("input_too_large", "Edited content exceeds 10 MiB")
        }
        if !args["dryRun"].bool { try Data(edited.utf8).write(to: path, options: .atomic) }
        result =
          "--- \(path.path)\n+++ \(path.path)\n"
          + original.components(separatedBy: "\n").map { "-" + $0 }.joined(separator: "\n") + "\n"
          + edited.components(separatedBy: "\n").map { "+" + $0 }.joined(separator: "\n")
      case "create_directory":
        try manager.createDirectory(at: path, withIntermediateDirectories: true)
        result = "Successfully created directory \(path.path)"
      case "list_directory", "list_directory_with_sizes":
        let children = try manager.contentsOfDirectory(
          at: path, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey])
        var rows: [(name: String, size: Int, directory: Bool)] = []
        for child in children {
          let safe = try allowed(child.path, roots: roots)
          let values = try safe.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
          rows.append((child.lastPathComponent, values.fileSize ?? 0, values.isDirectory == true))
        }
        rows.sort {
          args["sortBy"].string == "size"
            ? $0.size > $1.size : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        result = rows.map {
          "[\($0.directory ? "DIR" : "FILE")] \($0.name)"
            + (tool == "list_directory_with_sizes" ? "  \($0.size) bytes" : "")
        }.joined(separator: "\n")
      case "directory_tree", "search_files":
        var visited = 0
        var matches: [String] = []
        let excludes = args["excludePatterns"].array.compactMap(\.string)
        let pattern = tool == "search_files" ? try args.requireString("pattern") : ""
        func visit(_ url: URL, depth: Int) throws -> JSON {
          visited += 1
          guard visited <= 10000, depth <= 64 else {
            throw DesktopFailure("result_too_large", "Directory traversal exceeds the result limit")
          }
          let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
          let directory = values.isDirectory == true && values.isSymbolicLink != true
          var entry: JSON = .object([
            "name": .string(url.lastPathComponent),
            "type": .string(directory ? "directory" : "file"),
          ])
          if directory {
            let children = try manager.contentsOfDirectory(
              at: url, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
            ).sorted { $0.path < $1.path }
            var entries: [JSON] = []
            for child in children {
              if excludes.contains(where: {
                glob($0, matches: child.lastPathComponent)
                  || glob($0, matches: String(child.path.dropFirst(path.path.count + 1)))
              }) {
                continue
              }
              // Never traverse a symlink: its target could leave the selected directory.
              let value = try child.resourceValues(forKeys: [.isSymbolicLinkKey])
              if value.isSymbolicLink == true { continue }
              _ = try allowed(child.path, roots: roots)
              if tool == "search_files",
                glob(pattern, matches: child.lastPathComponent)
                  || child.lastPathComponent.localizedCaseInsensitiveContains(pattern)
              {
                matches.append(child.path)
              }
              entries.append(try visit(child, depth: depth + 1))
            }
            entry["children"] = .array(entries)
          }
          return entry
        }
        let tree = try visit(path, depth: 0)
        result =
          tool == "search_files"
          ? matches.joined(separator: "\n")
          : try JSON.array(tree["children"].array).text(pretty: true)
      case "get_file_info":
        let attributes = try manager.attributesOfItem(atPath: path.path)
        result = attributes.map { "\($0.key.rawValue): \($0.value)" }.sorted().joined(
          separator: "\n")
      default: throw DesktopFailure("unknown_tool", "Unknown filesystem tool")
      }
      return try PluginResult.text(result, context: context)
    } catch let failure as DesktopFailure { return failure.response } catch {
      return DesktopFailure("mcp_error", error.localizedDescription).response
    }
  }

  private func allowed(_ path: String, roots: [URL]) throws -> URL {
    let expanded = NSString(string: path).expandingTildeInPath
    guard expanded.hasPrefix("/"), expanded.utf8.count <= 16384, !expanded.contains("\0") else {
      throw DesktopFailure("invalid_arguments", "File paths must be absolute")
    }
    var ancestor = URL(fileURLWithPath: expanded).standardizedFileURL
    var missing: [String] = []
    while !manager.fileExists(atPath: ancestor.path), ancestor.path != "/" {
      missing.insert(ancestor.lastPathComponent, at: 0)
      ancestor.deleteLastPathComponent()
    }
    var resolved = ancestor.resolvingSymlinksInPath()
    for component in missing { resolved.appendPathComponent(component) }
    guard
      roots.contains(where: {
        $0.path == "/" || resolved.path == $0.path || resolved.path.hasPrefix($0.path + "/")
      })
    else {
      throw DesktopFailure("path_denied", "Access denied: path is outside the allowed directories")
    }
    return resolved
  }

  private func readBounded(_ file: URL) throws -> Data {
    let attributes = try manager.attributesOfItem(atPath: file.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue <= PluginResult.maximumBytes
    else { throw DesktopFailure("result_too_large", "File exceeds 10 MiB") }
    let handle = try FileHandle(forReadingFrom: file)
    defer { handle.closeFile() }
    let data = try handle.read(upToCount: PluginResult.maximumBytes + 1) ?? Data()
    guard data.count <= PluginResult.maximumBytes else {
      throw DesktopFailure("result_too_large", "File exceeds 10 MiB")
    }
    return data
  }

  private func readText(_ file: URL) throws -> String {
    guard let text = String(data: try readBounded(file), encoding: .utf8) else {
      throw DesktopFailure("mcp_error", "File is not UTF-8 text")
    }
    return text
  }

  private func glob(_ pattern: String, matches name: String) -> Bool {
    let expression =
      "^"
      + NSRegularExpression.escapedPattern(for: pattern).replacingOccurrences(
        of: "\\*\\*", with: ".*"
      ).replacingOccurrences(of: "\\*", with: "[^/]*").replacingOccurrences(of: "\\?", with: ".")
      + "$"
    return name.range(of: expression, options: [.regularExpression, .caseInsensitive]) != nil
  }
}
