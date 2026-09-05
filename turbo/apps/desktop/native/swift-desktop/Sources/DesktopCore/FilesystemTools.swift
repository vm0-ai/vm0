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
      let text: String
      switch tool {
      case "list_allowed_directories":
        text = "Allowed directories:\n" + roots.map(\.path).joined(separator: "\n")
      case "read_multiple_files": text = try readMultiple(args, roots: roots)
      case "move_file":
        let source = try allowed(args.requireString("source"), roots: roots)
        let destination = try allowed(args.requireString("destination"), roots: roots)
        try manager.moveItem(at: source, to: destination)
        text = "Successfully moved \(source.path) to \(destination.path)"
      case "read_media_file":
        return try readMedia(
          at: allowed(args.requireString("path"), roots: roots), context: context)
      default:
        text = try perform(
          tool, args: args, at: allowed(args.requireString("path"), roots: roots), roots: roots)
      }
      return try PluginResult.text(text, context: context)
    } catch let failure as DesktopFailure { return failure.response } catch {
      return DesktopFailure("mcp_error", error.localizedDescription).response
    }
  }

  private func perform(_ tool: String, args: JSON, at path: URL, roots: [URL]) throws -> String {
    switch tool {
    case "read_text_file": return try readTextFile(args, at: path)
    case "write_file": return try writeFile(args, at: path)
    case "edit_file": return try editFile(args, at: path)
    case "create_directory":
      try manager.createDirectory(at: path, withIntermediateDirectories: true)
      return "Successfully created directory \(path.path)"
    case "list_directory", "list_directory_with_sizes":
      return try listDirectory(tool, args: args, at: path)
    case "directory_tree", "search_files":
      return try traverse(tool, args: args, at: path, roots: roots)
    case "get_file_info": return try fileInfo(path)
    default: throw DesktopFailure("unknown_tool", "Unknown filesystem tool")
    }
  }

  private func readMultiple(_ args: JSON, roots: [URL]) throws -> String {
    let paths = args["paths"].array.compactMap(\.string)
    guard !paths.isEmpty, paths.count <= 100 else {
      throw DesktopFailure("invalid_arguments", "paths must contain 1 to 100 files")
    }
    let text = paths.map { path in
      do {
        let url = try allowed(path, roots: roots)
        return path + ":\n" + (try readText(url)) + "\n"
      } catch { return path + ": Error - " + error.localizedDescription }
    }.joined(separator: "\n---\n")
    return text
  }

  private func readTextFile(_ args: JSON, at path: URL) throws -> String {
    var result: String
    if args["head"].number != nil && args["tail"].number != nil {
      throw DesktopFailure("invalid_arguments", "Use head or tail, not both")
    }
    if let count = args["head"].number ?? args["tail"].number {
      guard count > 0, count.rounded() == count else {
        throw DesktopFailure("invalid_arguments", "Line count must be a positive integer")
      }
      result = try readLines(
        path, count: Int(min(count, Double(Int32.max))), tail: args["tail"].number != nil)
    } else {
      result = try readText(path)
    }
    return result
  }

  private func writeFile(_ args: JSON, at path: URL) throws -> String {
    guard let content = args["content"].string else {
      throw DesktopFailure("invalid_arguments", "content must be a string")
    }
    let data = Data(content.utf8)
    guard data.count <= PluginResult.maximumBytes else {
      throw DesktopFailure("input_too_large", "File content exceeds 10 MiB")
    }
    try data.write(to: path, options: .atomic)
    return "Successfully wrote to \(path.path)"
  }

  private func editFile(_ args: JSON, at path: URL) throws -> String {
    let original = try readText(path)
    let edits = args["edits"].array
    guard !edits.isEmpty, edits.count <= 1000 else {
      throw DesktopFailure("invalid_arguments", "edits must contain 1 to 1000 edits")
    }
    let edited = try FilesystemMatching.edit(original, edits: edits)
    guard edited.utf8.count <= PluginResult.maximumBytes else {
      throw DesktopFailure("input_too_large", "Edited content exceeds 10 MiB")
    }
    if !args["dryRun"].bool { try Data(edited.utf8).write(to: path, options: .atomic) }
    return FilesystemDiff.formatted(original, edited, path: path.path)
  }

  private func listDirectory(_ tool: String, args: JSON, at path: URL) throws -> String {
    var result: String
    let children = try manager.contentsOfDirectory(
      at: path, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey])
    var rows: [(name: String, size: Int, directory: Bool)] = []
    for child in children {
      let values = try child.resourceValues(forKeys: [
        .isDirectoryKey, .fileSizeKey, .isSymbolicLinkKey,
      ])
      rows.append(
        (
          child.lastPathComponent, values.fileSize ?? 0,
          values.isDirectory == true && values.isSymbolicLink != true
        ))
    }
    rows.sort {
      args["sortBy"].string == "size"
        ? $0.size > $1.size : $0.name.localizedStandardCompare($1.name) == .orderedAscending
    }
    result = rows.map {
      let prefix = "[\($0.directory ? "DIR" : "FILE")] "
      if tool == "list_directory" { return prefix + $0.name }
      let name = $0.name.padding(toLength: max(30, $0.name.count), withPad: " ", startingAt: 0)
      let size = $0.directory ? "" : formatSize($0.size)
      return prefix + name + " "
        + String(repeating: " ", count: $0.directory ? 0 : max(0, 10 - size.count)) + size
    }.joined(separator: "\n")
    if tool == "list_directory_with_sizes" {
      let files = rows.filter { !$0.directory }
      result +=
        "\n\nTotal: \(files.count) files, \(rows.count - files.count) directories\nCombined size: \(formatSize(files.reduce(0) { $0 + $1.size }))"
    }
    return result
  }

  private func traverse(_ tool: String, args: JSON, at path: URL, roots: [URL]) throws -> String {
    var visited = 0
    var matches: [String] = []
    let excludes = args["excludePatterns"].array.compactMap(\.string)
    let pattern = tool == "search_files" ? try args.requireString("pattern") : ""
    func visit(_ url: URL, depth: Int, relativePath: String) throws -> JSON {
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
          let relative =
            relativePath.isEmpty
            ? child.lastPathComponent : relativePath + "/" + child.lastPathComponent
          if excludes.contains(where: { pattern in
            FilesystemMatching.matches(pattern, path: relative)
              || (tool == "directory_tree" && !pattern.contains("*")
                && (FilesystemMatching.matches("**/" + pattern, path: relative)
                  || FilesystemMatching.matches("**/" + pattern + "/**", path: relative)))
          }) {
            continue
          }
          let value = try child.resourceValues(forKeys: [.isSymbolicLinkKey])
          if value.isSymbolicLink == true {
            if tool == "directory_tree" {
              entries.append(
                .object(["name": .string(child.lastPathComponent), "type": .string("file")]))
            } else if (try? allowed(child.path, roots: roots)) != nil,
              FilesystemMatching.matches(pattern, path: relative)
            {
              matches.append(child.path)
            }
            continue
          }
          _ = try allowed(child.path, roots: roots)
          if tool == "search_files", FilesystemMatching.matches(pattern, path: relative) {
            matches.append(child.path)
          }
          entries.append(try visit(child, depth: depth + 1, relativePath: relative))
        }
        entry["children"] = .array(entries)
      }
      return entry
    }
    let tree = try visit(path, depth: 0, relativePath: "")
    return
      tool == "search_files"
      ? (matches.isEmpty ? "No matches found" : matches.joined(separator: "\n"))
      : try JSON.array(tree["children"].array).text(pretty: true)
  }

  private func fileInfo(_ path: URL) throws -> String {
    let attributes = try manager.attributesOfItem(atPath: path.path)
    let values = try path.resourceValues(forKeys: [.contentAccessDateKey])
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "EEE MMM dd yyyy HH:mm:ss 'GMT'Z (zzzz)"
    func date(_ value: Any?) -> String { (value as? Date).map(formatter.string) ?? "unknown" }
    let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
    return [
      "size: \(attributes[.size] ?? 0)", "created: " + date(attributes[.creationDate]),
      "modified: " + date(attributes[.modificationDate]),
      "accessed: " + date(values.contentAccessDate),
      "isDirectory: \(attributes[.type] as? FileAttributeType == .typeDirectory)",
      "isFile: \(attributes[.type] as? FileAttributeType == .typeRegular)",
      "permissions: " + String(format: "%03o", permissions & 0o777),
    ].joined(separator: "\n")
  }

  private func readMedia(at path: URL, context: JSON) throws -> JSON {
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
    String(decoding: try readBounded(file), as: UTF8.self)
  }

  private func readLines(_ file: URL, count: Int, tail: Bool) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    defer { handle.closeFile() }
    var data = Data()
    var position = tail ? try handle.seekToEnd() : 0
    while true {
      if tail {
        if position == 0 { break }
        let length = min(position, 65536)
        position -= length
        try handle.seek(toOffset: position)
        let chunk = try handle.read(upToCount: Int(length)) ?? Data()
        data.insert(contentsOf: chunk, at: data.startIndex)
      } else {
        let chunk = try handle.read(upToCount: 65536) ?? Data()
        if chunk.isEmpty { break }
        data.append(chunk)
      }
      if data.lazy.filter({ $0 == 10 }).prefix(count).count >= count { break }
      guard data.count <= PluginResult.maximumBytes else {
        throw DesktopFailure("result_too_large", "Requested lines exceed 10 MiB")
      }
    }
    var text = String(decoding: data, as: UTF8.self)
    if tail { text = text.replacingOccurrences(of: "\r\n", with: "\n") }
    var lines = text.components(separatedBy: "\n")
    if !tail && lines.last == "" { lines.removeLast() }
    let selected = tail ? Array(lines.suffix(count)) : Array(lines.prefix(count))
    return selected.joined(separator: "\n")
  }

  private func formatSize(_ bytes: Int) -> String {
    guard bytes > 0 else { return "0 B" }
    let units = ["B", "KB", "MB", "GB", "TB"]
    let index = min(4, Int(log(Double(bytes)) / log(1024)))
    return index == 0
      ? "\(bytes) B"
      : String(format: "%.2f %@", Double(bytes) / pow(1024, Double(index)), units[index])
  }

}
