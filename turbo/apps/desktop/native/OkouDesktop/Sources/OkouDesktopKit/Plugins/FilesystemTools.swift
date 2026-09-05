import Foundation

public struct FilesystemToolError: Error, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

/// Native port of `@modelcontextprotocol/server-filesystem` 2026.1.14: the
/// thirteen tools the desktop advertises, with the same allowed-directory
/// enforcement, symlink checks and text output shapes.
public struct FilesystemTools: Sendable {
    public static let toolNames: [String] = [
        "list_allowed_directories", "read_text_file", "read_media_file", "read_multiple_files", "write_file",
        "edit_file", "create_directory", "list_directory", "list_directory_with_sizes", "directory_tree",
        "move_file", "search_files", "get_file_info",
    ]
    public static let version = "2026.1.14"

    public let allowedDirectories: [String]
    private let fileManager = FileManager.default

    public init(allowedDirectories: [String]) {
        self.allowedDirectories = allowedDirectories.map(FilesystemTools.normalize)
    }

    // MARK: Paths

    static func expandHome(_ path: String) -> String {
        if path == "~" || path.hasPrefix("~/") {
            return NSHomeDirectory() + String(path.dropFirst())
        }
        return path
    }

    /// `path.resolve` + `normalizePath`: absolute, `.`/`..` collapsed, no trailing slash.
    static func normalize(_ path: String) -> String {
        let absolute = path.hasPrefix("/") ? path : FileManager.default.currentDirectoryPath + "/" + path
        var parts: [String] = []
        for component in absolute.split(separator: "/", omittingEmptySubsequences: true) {
            if component == "." { continue }
            if component == ".." {
                _ = parts.popLast()
                continue
            }
            parts.append(String(component))
        }
        return "/" + parts.joined(separator: "/")
    }

    static func isWithin(_ path: String, _ directory: String) -> Bool {
        path == directory || path.hasPrefix(directory == "/" ? "/" : directory + "/")
    }

    func isWithinAllowed(_ path: String) -> Bool {
        allowedDirectories.contains { Self.isWithin(path, $0) }
    }

    private func realpath(_ path: String) throws -> String {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory) || (try? fileManager.attributesOfItem(atPath: path)) != nil else {
            throw FilesystemToolError("ENOENT: no such file or directory, \(path)")
        }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    private func resolveRelative(_ relative: String) -> String {
        for directory in allowedDirectories {
            let candidate = Self.normalize(directory + "/" + relative)
            if isWithinAllowed(candidate) {
                return candidate
            }
        }
        return Self.normalize((allowedDirectories.first ?? fileManager.currentDirectoryPath) + "/" + relative)
    }

    private func accessDenied(_ path: String) -> FilesystemToolError {
        FilesystemToolError("Access denied - path outside allowed directories: \(path) not in \(allowedDirectories.joined(separator: ", "))")
    }

    /// Port of `validatePath`: allowed-directory and symlink-target checks,
    /// with missing tails resolved against their deepest existing parent.
    public func validatePath(_ requested: String) throws -> String {
        let expanded = Self.expandHome(requested)
        if expanded.firstMatch(of: #/^(?:[A-Za-z]:)(?:[\\/]|$)/#) != nil {
            throw FilesystemToolError("Access denied - Windows-style path received on a POSIX host: \(requested)")
        }
        let absolute = expanded.hasPrefix("/") ? Self.normalize(expanded) : resolveRelative(expanded)
        guard isWithinAllowed(absolute) else {
            throw accessDenied(absolute)
        }
        if fileManager.fileExists(atPath: absolute) || (try? fileManager.attributesOfItem(atPath: absolute)) != nil {
            let real = try realpath(absolute)
            guard isWithinAllowed(Self.normalize(real)) else {
                throw FilesystemToolError("Access denied - symlink target outside allowed directories: \(real) not in \(allowedDirectories.joined(separator: ", "))")
            }
            return real
        }
        // Walk the existing ancestors so a symlinked parent cannot escape.
        guard let allowed = allowedDirectories.sorted(by: { $0.count > $1.count }).first(where: { Self.isWithin(absolute, $0) }) else {
            return absolute
        }
        guard fileManager.fileExists(atPath: allowed) else {
            throw FilesystemToolError("Parent directory does not exist: \((absolute as NSString).deletingLastPathComponent)")
        }
        var current = try realpath(allowed)
        let relativeParts = String(absolute.dropFirst(allowed.count)).split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        for (index, part) in relativeParts.enumerated() {
            let entries = (try? fileManager.contentsOfDirectory(atPath: current)) ?? []
            let matches = entries.contains(part) ? [part] : entries.filter { $0.precomposedStringWithCanonicalMapping == part.precomposedStringWithCanonicalMapping }
            if matches.count > 1 {
                throw FilesystemToolError("Ambiguous Unicode path component: \(part)")
            }
            guard let match = matches.first else {
                return ([current] + relativeParts[index...]).joined(separator: "/")
            }
            current = try realpath(current + "/" + match)
            guard isWithinAllowed(Self.normalize(current)) else {
                throw FilesystemToolError("Access denied - symlink target outside allowed directories: \(current) not in \(allowedDirectories.joined(separator: ", "))")
            }
        }
        return current
    }

    // MARK: Helpers

    public static func formatSize(_ bytes: Int) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        if bytes <= 0 { return "0 B" }
        let exponent = Int((log(Double(bytes)) / log(1024)).rounded(.down))
        if exponent <= 0 { return "\(bytes) \(units[0])" }
        let index = min(exponent, units.count - 1)
        return String(format: "%.2f %@", Double(bytes) / pow(1024, Double(index)), units[index])
    }

    static func normalizeLineEndings(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n")
    }

    private func isDirectory(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private func readText(_ path: String) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return String(decoding: data, as: UTF8.self)
    }

    private func writeAtomically(_ path: String, _ content: String) throws {
        let temporary = path + "." + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() + ".tmp"
        let attributes = try? fileManager.attributesOfItem(atPath: path)
        do {
            try Data(content.utf8).write(to: URL(fileURLWithPath: temporary))
            _ = try fileManager.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: temporary))
        } catch {
            try? fileManager.removeItem(atPath: temporary)
            throw error
        }
        if let permissions = attributes?[.posixPermissions] {
            try? fileManager.setAttributes([.posixPermissions: permissions], ofItemAtPath: path)
        }
    }

    private func writeFileContent(_ path: String, _ content: String) throws {
        if fileManager.fileExists(atPath: path) {
            try writeAtomically(path, content)
        } else {
            try Data(content.utf8).write(to: URL(fileURLWithPath: path), options: .withoutOverwriting)
        }
    }

    // MARK: Tools

    public func listAllowedDirectories() -> String {
        "Allowed directories:\n" + allowedDirectories.joined(separator: "\n")
    }

    public func readTextFile(path: String, head: Int?, tail: Int?) throws -> String {
        let valid = try validatePath(path)
        if head != nil, tail != nil {
            throw FilesystemToolError("Cannot specify both head and tail parameters simultaneously")
        }
        let content = try readText(valid)
        if let tail, tail > 0 {
            let lines = Self.normalizeLineEndings(content).components(separatedBy: "\n")
            return lines.suffix(tail).joined(separator: "\n")
        }
        if let head, head > 0 {
            let lines = content.components(separatedBy: "\n")
            return lines.prefix(head).joined(separator: "\n")
        }
        return content
    }

    static let mediaMimeTypes: [String: String] = [
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
        ".bmp": "image/bmp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    ]

    public func readMediaFile(path: String) throws -> McpContentEntry {
        let valid = try validatePath(path)
        let extensionName = "." + (valid as NSString).pathExtension.lowercased()
        let mimeType = Self.mediaMimeTypes[extensionName] ?? "application/octet-stream"
        let data = try Data(contentsOf: URL(fileURLWithPath: valid)).base64EncodedString()
        if mimeType.hasPrefix("image/") {
            return .image(data: data, mimeType: mimeType)
        }
        if mimeType.hasPrefix("audio/") {
            return .audio(data: data, mimeType: mimeType)
        }
        return .resource(uri: URL(fileURLWithPath: valid).absoluteString, mimeType: mimeType, text: nil, blob: data)
    }

    public func readMultipleFiles(paths: [String]) -> String {
        paths.map { path -> String in
            do {
                let valid = try validatePath(path)
                return "\(path):\n\(try readText(valid))\n"
            } catch {
                return "\(path): Error - \(String(describing: error))"
            }
        }.joined(separator: "\n---\n")
    }

    public func writeFile(path: String, content: String) throws -> String {
        let valid = try validatePath(path)
        try writeFileContent(valid, content)
        return "Successfully wrote to \(path)"
    }

    public struct Edit: Equatable, Sendable {
        public var oldText: String
        public var newText: String

        public init(oldText: String, newText: String) {
            self.oldText = oldText
            self.newText = newText
        }
    }

    static func leadingWhitespace(_ line: String) -> String {
        String(line.prefix { $0 == " " || $0 == "\t" })
    }

    public func editFile(path: String, edits: [Edit], dryRun: Bool) throws -> String {
        let valid = try validatePath(path)
        let content = Self.normalizeLineEndings(try readText(valid))
        var modified = content
        for edit in edits {
            let oldText = Self.normalizeLineEndings(edit.oldText)
            let newText = Self.normalizeLineEndings(edit.newText)
            if let range = modified.range(of: oldText) {
                modified.replaceSubrange(range, with: newText)
                continue
            }
            let oldLines = oldText.components(separatedBy: "\n")
            var contentLines = modified.components(separatedBy: "\n")
            var matched = false
            if contentLines.count >= oldLines.count {
                for start in 0...(contentLines.count - oldLines.count) {
                    let window = contentLines[start..<(start + oldLines.count)]
                    let isMatch = zip(oldLines, window).allSatisfy {
                        $0.trimmingCharacters(in: .whitespaces) == $1.trimmingCharacters(in: .whitespaces)
                    }
                    guard isMatch else { continue }
                    let originalIndent = Self.leadingWhitespace(contentLines[start])
                    let newLines = newText.components(separatedBy: "\n").enumerated().map { index, line -> String in
                        let trimmed = String(line.drop { $0 == " " || $0 == "\t" })
                        if index == 0 { return originalIndent + trimmed }
                        let oldIndent = index < oldLines.count ? Self.leadingWhitespace(oldLines[index]) : ""
                        let newIndent = Self.leadingWhitespace(line)
                        if !oldIndent.isEmpty, !newIndent.isEmpty {
                            return originalIndent + String(repeating: " ", count: max(0, newIndent.count - oldIndent.count)) + trimmed
                        }
                        return line
                    }
                    contentLines.replaceSubrange(start..<(start + oldLines.count), with: newLines)
                    modified = contentLines.joined(separator: "\n")
                    matched = true
                    break
                }
            }
            if !matched {
                throw FilesystemToolError("Could not find exact match for edit:\n\(edit.oldText)")
            }
        }
        let diff = UnifiedDiff.patch(original: content, modified: modified, path: valid)
        var backticks = 3
        while diff.contains(String(repeating: "`", count: backticks)) {
            backticks += 1
        }
        let fence = String(repeating: "`", count: backticks)
        let formatted = "\(fence)diff\n\(diff)\(fence)\n\n"
        if !dryRun {
            try writeAtomically(valid, modified)
        }
        return formatted
    }

    public func createDirectory(path: String) throws -> String {
        let valid = try validatePath(path)
        try fileManager.createDirectory(atPath: valid, withIntermediateDirectories: true)
        return "Successfully created directory \(path)"
    }

    private func directoryEntries(_ path: String) throws -> [(name: String, isDirectory: Bool)] {
        try fileManager.contentsOfDirectory(atPath: path).map { ($0, isDirectory(path + "/" + $0)) }
    }

    public func listDirectory(path: String) throws -> String {
        let valid = try validatePath(path)
        return try directoryEntries(valid).map { "\($0.isDirectory ? "[DIR]" : "[FILE]") \($0.name)" }.joined(separator: "\n")
    }

    public func listDirectoryWithSizes(path: String, sortBy: String?) throws -> String {
        let valid = try validatePath(path)
        let entries = try directoryEntries(valid).map { entry -> (name: String, isDirectory: Bool, size: Int) in
            let size = (try? fileManager.attributesOfItem(atPath: valid + "/" + entry.name))?[.size] as? Int ?? 0
            return (entry.name, entry.isDirectory, size)
        }
        let sorted = entries.sorted { left, right in
            if sortBy == "size" {
                return left.size > right.size
            }
            return left.name.localizedCompare(right.name) == .orderedAscending
        }
        let lines = sorted.map { entry -> String in
            let name = entry.name.padding(toLength: max(30, entry.name.count), withPad: " ", startingAt: 0)
            let size = entry.isDirectory ? "" : Self.padStart(Self.formatSize(entry.size), 10)
            return "\(entry.isDirectory ? "[DIR]" : "[FILE]") \(name) \(size)"
        }
        let files = entries.filter { !$0.isDirectory }
        let totalSize = files.reduce(0) { $0 + $1.size }
        let summary = ["", "Total: \(files.count) files, \(entries.count - files.count) directories", "Combined size: \(Self.formatSize(totalSize))"]
        return (lines + summary).joined(separator: "\n")
    }

    static func padStart(_ value: String, _ length: Int) -> String {
        value.count >= length ? value : String(repeating: " ", count: length - value.count) + value
    }

    public func directoryTree(path: String, excludePatterns: [String]) throws -> String {
        func build(_ current: String) throws -> JSONValue {
            let valid = try validatePath(current)
            var result: [JSONValue] = []
            for entry in try directoryEntries(valid) {
                let relative = Glob.relativePath(from: path, to: current + "/" + entry.name)
                let excluded = excludePatterns.contains { pattern in
                    if pattern.contains("*") {
                        return Glob.matches(relative, pattern)
                    }
                    return Glob.matches(relative, pattern) || Glob.matches(relative, "**/\(pattern)") || Glob.matches(relative, "**/\(pattern)/**")
                }
                if excluded { continue }
                var object: [String: JSONValue] = ["name": .string(entry.name), "type": .string(entry.isDirectory ? "directory" : "file")]
                if entry.isDirectory {
                    object["children"] = try build(current + "/" + entry.name)
                }
                result.append(.object(object))
            }
            return .array(result)
        }
        return try build(path).serialized(options: JSONSerializationOptions(pretty: true))
    }

    public func moveFile(source: String, destination: String) throws -> String {
        let validSource = try validatePath(source)
        let validDestination = try validatePath(destination)
        if (try? fileManager.attributesOfItem(atPath: validDestination)) != nil {
            throw FilesystemToolError("Destination already exists: \(validDestination)")
        }
        try fileManager.moveItem(atPath: validSource, toPath: validDestination)
        return "Successfully moved \(source) to \(destination)"
    }

    public func searchFiles(path: String, pattern: String, excludePatterns: [String]) throws -> String {
        let root = try validatePath(path)
        var results: [String] = []
        func search(_ current: String) {
            guard let entries = try? directoryEntries(current) else { return }
            for entry in entries {
                let full = current + "/" + entry.name
                guard (try? validatePath(full)) != nil else { continue }
                let relative = Glob.relativePath(from: root, to: full)
                if excludePatterns.contains(where: { Glob.matches(relative, $0) }) { continue }
                if Glob.matches(relative, pattern) {
                    results.append(full)
                }
                if entry.isDirectory {
                    search(full)
                }
            }
        }
        search(root)
        return results.isEmpty ? "No matches found" : results.joined(separator: "\n")
    }

    static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE MMM dd yyyy HH:mm:ss 'GMT'xx (zzzz)"
        return formatter
    }()

    public func getFileInfo(path: String) throws -> String {
        let valid = try validatePath(path)
        let attributes = try fileManager.attributesOfItem(atPath: valid)
        let type = attributes[.type] as? FileAttributeType
        let mode = (attributes[.posixPermissions] as? Int) ?? 0
        let created = attributes[.creationDate] as? Date ?? Date(timeIntervalSince1970: 0)
        let modified = attributes[.modificationDate] as? Date ?? Date(timeIntervalSince1970: 0)
        let permissions = String(String(mode, radix: 8).suffix(3))
        return [
            "size: \(attributes[.size] as? Int ?? 0)",
            "created: \(Self.dateFormatter.string(from: created))",
            "modified: \(Self.dateFormatter.string(from: modified))",
            "accessed: \(Self.dateFormatter.string(from: modified))",
            "isDirectory: \(type == .typeDirectory)",
            "isFile: \(type == .typeRegular)",
            "permissions: \(permissions)",
        ].joined(separator: "\n")
    }

    // MARK: Dispatch

    /// Runs one tool with already-validated arguments and returns the MCP
    /// content the upstream server would have produced.
    public func call(tool: String, arguments: [String: JSONValue]) throws -> McpCallToolResult {
        func string(_ key: String) -> String { arguments[key]?.stringValue ?? "" }
        func strings(_ key: String) -> [String] { arguments[key]?.arrayValue?.compactMap(\.stringValue) ?? [] }
        let text: String
        switch tool {
        case "list_allowed_directories":
            text = listAllowedDirectories()
        case "read_text_file":
            text = try readTextFile(path: string("path"), head: arguments["head"]?.intValue, tail: arguments["tail"]?.intValue)
        case "read_media_file":
            return McpCallToolResult(content: [try readMediaFile(path: string("path"))], isError: false)
        case "read_multiple_files":
            text = readMultipleFiles(paths: strings("paths"))
        case "write_file":
            text = try writeFile(path: string("path"), content: string("content"))
        case "edit_file":
            let edits = (arguments["edits"]?.arrayValue ?? []).map {
                Edit(oldText: $0["oldText"]?.stringValue ?? "", newText: $0["newText"]?.stringValue ?? "")
            }
            text = try editFile(path: string("path"), edits: edits, dryRun: arguments["dryRun"]?.boolValue ?? false)
        case "create_directory":
            text = try createDirectory(path: string("path"))
        case "list_directory":
            text = try listDirectory(path: string("path"))
        case "list_directory_with_sizes":
            text = try listDirectoryWithSizes(path: string("path"), sortBy: arguments["sortBy"]?.stringValue)
        case "directory_tree":
            text = try directoryTree(path: string("path"), excludePatterns: strings("excludePatterns"))
        case "move_file":
            text = try moveFile(source: string("source"), destination: string("destination"))
        case "search_files":
            text = try searchFiles(path: string("path"), pattern: string("pattern"), excludePatterns: strings("excludePatterns"))
        case "get_file_info":
            text = try getFileInfo(path: string("path"))
        default:
            throw FilesystemToolError("Unknown tool: \(tool)")
        }
        return McpCallToolResult(content: [.text(text)], isError: false)
    }
}

/// Minimal `minimatch` with `dot: true`: `*`, `?`, `**`, `[...]` classes.
public enum Glob {
    public static func relativePath(from root: String, to path: String) -> String {
        let rootParts = root.split(separator: "/", omittingEmptySubsequences: true)
        let pathParts = path.split(separator: "/", omittingEmptySubsequences: true)
        var common = 0
        while common < rootParts.count, common < pathParts.count, rootParts[common] == pathParts[common] {
            common += 1
        }
        let ups = Array(repeating: "..", count: rootParts.count - common)
        return (ups + pathParts[common...].map(String.init)).joined(separator: "/")
    }

    public static func matches(_ path: String, _ pattern: String) -> Bool {
        let pathSegments = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        let patternSegments = pattern.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        return matchSegments(pathSegments[...], patternSegments[...])
    }

    private static func matchSegments(_ path: ArraySlice<String>, _ pattern: ArraySlice<String>) -> Bool {
        guard let first = pattern.first else { return path.isEmpty }
        if first == "**" {
            let rest = pattern.dropFirst()
            if rest.isEmpty { return true }
            var index = path.startIndex
            while index <= path.endIndex {
                if matchSegments(path[index...], rest) { return true }
                if index == path.endIndex { break }
                index += 1
            }
            return false
        }
        guard let segment = path.first, matchSegment(Array(segment), Array(first)) else { return false }
        return matchSegments(path.dropFirst(), pattern.dropFirst())
    }

    private static func matchSegment(_ text: [Character], _ pattern: [Character]) -> Bool {
        var textIndex = 0
        var patternIndex = 0
        var starText = -1
        var starPattern = -1
        while textIndex < text.count {
            if patternIndex < pattern.count, pattern[patternIndex] == "*" {
                starPattern = patternIndex
                starText = textIndex
                patternIndex += 1
                continue
            }
            if patternIndex < pattern.count, let consumed = matchSingle(text[textIndex], pattern, &patternIndex) {
                if consumed {
                    textIndex += 1
                    continue
                }
            }
            if starPattern >= 0 {
                patternIndex = starPattern + 1
                starText += 1
                textIndex = starText
                continue
            }
            return false
        }
        while patternIndex < pattern.count, pattern[patternIndex] == "*" {
            patternIndex += 1
        }
        return patternIndex == pattern.count
    }

    /// Matches one character against `?`, a literal, or a `[...]` class,
    /// advancing `index` past the consumed pattern. Returns nil when the
    /// pattern element cannot match.
    private static func matchSingle(_ character: Character, _ pattern: [Character], _ index: inout Int) -> Bool? {
        let element = pattern[index]
        if element == "?" {
            index += 1
            return true
        }
        if element == "[" , let close = pattern[(index + 1)...].firstIndex(of: "]") {
            var members = Array(pattern[(index + 1)..<close])
            var negate = false
            if members.first == "!" || members.first == "^" {
                negate = true
                members.removeFirst()
            }
            var matched = false
            var position = 0
            while position < members.count {
                if position + 2 < members.count, members[position + 1] == "-" {
                    if members[position] <= character, character <= members[position + 2] { matched = true }
                    position += 3
                } else {
                    if members[position] == character { matched = true }
                    position += 1
                }
            }
            index = close + 1
            return matched != negate ? true : nil
        }
        index += 1
        return element == character ? true : nil
    }
}

/// Unified diff in the `createTwoFilesPatch` shape used by `edit_file`.
public enum UnifiedDiff {
    enum Line: Equatable {
        case context(String)
        case removed(String)
        case added(String)
    }

    static func diffLines(_ original: [String], _ modified: [String]) -> [Line] {
        let n = original.count
        let m = modified.count
        var table = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
        if n > 0, m > 0 {
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    table[i][j] = original[i] == modified[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
                }
            }
        }
        var lines: [Line] = []
        var i = 0
        var j = 0
        while i < n, j < m {
            if original[i] == modified[j] {
                lines.append(.context(original[i]))
                i += 1
                j += 1
            } else if table[i + 1][j] >= table[i][j + 1] {
                lines.append(.removed(original[i]))
                i += 1
            } else {
                lines.append(.added(modified[j]))
                j += 1
            }
        }
        while i < n { lines.append(.removed(original[i])); i += 1 }
        while j < m { lines.append(.added(modified[j])); j += 1 }
        return lines
    }

    public static func patch(original: String, modified: String, path: String, context: Int = 3) -> String {
        let originalLines = original.components(separatedBy: "\n")
        let modifiedLines = modified.components(separatedBy: "\n")
        let lines = diffLines(originalLines, modifiedLines)
        var output = "===================================================================\n--- \(path)\toriginal\n+++ \(path)\tmodified\n"
        var index = 0
        var oldLine = 1
        var newLine = 1
        while index < lines.count {
            guard case .context = lines[index] else {
                let start = max(0, index - context)
                var end = index
                var lastChange = index
                while end < lines.count, end - lastChange <= context {
                    if case .context = lines[end] {} else { lastChange = end }
                    end += 1
                }
                end = min(lines.count, lastChange + context + 1)
                var oldStart = oldLine
                var newStart = newLine
                for k in stride(from: index - 1, through: start, by: -1) {
                    if case .context = lines[k] {
                        oldStart -= 1
                        newStart -= 1
                    }
                }
                var oldCount = 0
                var newCount = 0
                var body = ""
                for k in start..<end {
                    switch lines[k] {
                    case let .context(text):
                        body += " \(text)\n"
                        oldCount += 1
                        newCount += 1
                    case let .removed(text):
                        body += "-\(text)\n"
                        oldCount += 1
                    case let .added(text):
                        body += "+\(text)\n"
                        newCount += 1
                    }
                }
                output += "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@\n" + body
                for k in index..<end {
                    switch lines[k] {
                    case .context: oldLine += 1; newLine += 1
                    case .removed: oldLine += 1
                    case .added: newLine += 1
                    }
                }
                index = end
                continue
            }
            oldLine += 1
            newLine += 1
            index += 1
        }
        return output
    }
}
