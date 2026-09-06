import Foundation

/// Port of `DesktopFilesystemPluginManager` over the native tools: the
/// preference-backed allowed directories, the feature and host gates, and
/// the failure ladder for `plugin.call` commands.
@MainActor
public final class DesktopFilesystemPluginManager {
    public static let pluginName = "filesystem"
    public static let preferencesKey = "computerUsePlugins"
    public static let filesystemKey = "filesystem"

    private let store: DesktopPreferencesStore
    private let onChange: () -> Void
    private var enabled = false
    private var allowedDirectories: [String] = []
    private var featureEnabled = false
    private var hostRuntimeOnline = false
    private var lastError: String? = nil

    public init(store: DesktopPreferencesStore, onChange: @escaping () -> Void) {
        self.store = store
        self.onChange = onChange
    }

    public func load() {
        let record = (try? store.read()) ?? [:]
        let filesystem = record[Self.preferencesKey]?[Self.filesystemKey]
        enabled = filesystem?["enabled"]?.boolValue == true
        allowedDirectories = Self.normalizeDirectories(filesystem?["allowedDirectories"]?.arrayValue ?? [])
    }

    nonisolated static func normalizeDirectories(_ values: [JSONValue]) -> [String] {
        var seen = Set<String>()
        var directories: [String] = []
        for value in values {
            guard let directory = value.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !directory.isEmpty,
                !seen.contains(directory)
            else { continue }
            seen.insert(directory)
            directories.append(directory)
        }
        return directories
    }

    private var shouldRun: Bool {
        featureEnabled && hostRuntimeOnline && enabled && !allowedDirectories.isEmpty
    }

    public var status: DesktopComputerUsePluginStatus {
        shouldRun ? .running : .disabled
    }

    public var state: DesktopComputerUseFilesystemPluginState {
        DesktopComputerUseFilesystemPluginState(
            featureEnabled: featureEnabled, enabled: enabled, allowedDirectories: allowedDirectories, status: status,
            lastError: lastError, version: FilesystemTools.version, capabilities: capabilities
        )
    }

    public var capabilities: [String] {
        guard status == .running else { return [] }
        var result = [ComputerUseCapabilities.pluginCallKind, "plugin.\(Self.pluginName)"]
        result.append(contentsOf: FilesystemTools.toolNames.map { "plugin.\(Self.pluginName).\($0)" })
        return result
    }

    public func setFeatureEnabled(_ value: Bool) {
        guard featureEnabled != value else { return }
        featureEnabled = value
        onChange()
    }

    public func setHostRuntimeOnline(_ value: Bool) {
        guard hostRuntimeOnline != value else { return }
        hostRuntimeOnline = value
        onChange()
    }

    public func setEnabled(_ value: Bool) throws {
        guard enabled != value else { return }
        enabled = value
        try save()
        onChange()
    }

    public func addAllowedDirectory(_ directory: String) throws {
        let trimmed = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !allowedDirectories.contains(trimmed) else { return }
        allowedDirectories.append(trimmed)
        try save()
        onChange()
    }

    public func removeAllowedDirectory(_ directory: String) throws {
        let remaining = allowedDirectories.filter { $0 != directory }
        guard remaining.count != allowedDirectories.count else { return }
        allowedDirectories = remaining
        try save()
        onChange()
    }

    private func save() throws {
        try store.update { record in
            var plugins = record[Self.preferencesKey]?.objectValue ?? [:]
            plugins[Self.filesystemKey] = .object([
                "enabled": .bool(enabled),
                "allowedDirectories": .array(allowedDirectories.map(JSONValue.string)),
            ])
            record[Self.preferencesKey] = .object(plugins)
        }
    }

    nonisolated public static func isFilesystemCallPayload(_ payload: [String: JSONValue]) -> Bool {
        payload["plugin"]?.stringValue == pluginName && payload["tool"]?.stringValue != nil
            && (payload["arguments"] == nil || payload["arguments"]?.objectValue != nil)
    }

    nonisolated public static func failureCode(for message: String) -> ComputerUseErrorCode {
        let normalized = message.lowercased()
        if normalized.contains("allowed directory") || normalized.contains("access denied") || normalized.contains("permission denied")
            || normalized.contains("outside")
        {
            return .pathDenied
        }
        return .mcpError
    }

    public func execute(_ command: ComputerUseCommand) async -> ComputerUseCommandExecutionResult {
        let payload = command.payload
        guard command.kind == ComputerUseCapabilities.pluginCallKind, let tool = payload["tool"]?.stringValue,
            payload["arguments"] == nil || payload["arguments"]?.objectValue != nil
        else {
            return .failure(.invalidArguments, "Filesystem plugin command payload is invalid.")
        }
        guard payload["plugin"]?.stringValue == Self.pluginName else {
            return .failure(.unknownPlugin, "Unknown Computer Use plugin: \(payload["plugin"]?.stringValue ?? "")")
        }
        guard FilesystemTools.toolNames.contains(tool) else {
            return .failure(.unknownTool, "Unknown filesystem plugin tool: \(tool)")
        }
        guard featureEnabled else {
            return .failure(.featureDisabled, "Computer Use Desktop plugins are disabled.")
        }
        guard enabled else {
            return .failure(.pluginDisabled, "Filesystem plugin is disabled.")
        }
        guard !allowedDirectories.isEmpty else {
            return .failure(.pluginDisabled, "Filesystem plugin has no allowed directories.")
        }
        guard status == .running else {
            return .failure(.pluginUnavailable, "Filesystem plugin is unavailable.")
        }
        let arguments = payload["arguments"]?.objectValue ?? [:]
        if let validationError = FilesystemToolArguments.validate(tool: tool, arguments: arguments) {
            return .failure(.invalidArguments, validationError)
        }
        let tools = FilesystemTools(allowedDirectories: allowedDirectories)
        let context = PluginToolResultContext(plugin: Self.pluginName, tool: tool, mapErrorCode: { Self.failureCode(for: $0) })
        do {
            let result = try await Task.detached(priority: .userInitiated) { try tools.call(tool: tool, arguments: arguments) }.value
            return PluginToolResults.normalize(context, result: result)
        } catch {
            let message = String(describing: error)
            return .failure(Self.failureCode(for: message), message)
        }
    }
}

/// Port of the contract's argument schemas for the filesystem tools.
public enum FilesystemToolArguments {
    static func pathValue(_ arguments: [String: JSONValue], _ key: String) -> String? {
        guard let value = arguments[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
            value.count <= 16_384
        else { return nil }
        return value
    }

    static func unexpectedKeys(_ arguments: [String: JSONValue], allowed: Set<String>) -> String? {
        let extra = arguments.keys.filter { !allowed.contains($0) }.sorted()
        return extra.isEmpty ? nil : "Unrecognized key(s) in object: \(extra.map { "'\($0)'" }.joined(separator: ", "))"
    }

    static func positiveInt(_ value: JSONValue?, _ key: String) -> String? {
        guard let value else { return nil }
        guard let number = value.intValue, number > 0 else {
            return "\(key) must be a positive integer"
        }
        return nil
    }

    static func patterns(_ value: JSONValue?, _ key: String) -> String? {
        guard let value else { return nil }
        guard let array = value.arrayValue, array.count <= 512 else { return "\(key) must be an array of at most 512 patterns" }
        for entry in array {
            guard let text = entry.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return "\(key) entries must be non-empty strings"
            }
        }
        return nil
    }

    /// Returns a validation message, or nil when the arguments are valid.
    public static func validate(tool: String, arguments: [String: JSONValue]) -> String? {
        switch tool {
        case "list_allowed_directories":
            return unexpectedKeys(arguments, allowed: [])
        case "read_text_file":
            if let extra = unexpectedKeys(arguments, allowed: ["path", "tail", "head"]) { return extra }
            guard pathValue(arguments, "path") != nil else { return "path is required" }
            if let error = positiveInt(arguments["tail"], "tail") ?? positiveInt(arguments["head"], "head") { return error }
            if arguments["head"] != nil, arguments["tail"] != nil { return "read_text_file accepts either head or tail, not both" }
            return nil
        case "read_media_file", "create_directory", "list_directory", "get_file_info":
            if let extra = unexpectedKeys(arguments, allowed: ["path"]) { return extra }
            return pathValue(arguments, "path") == nil ? "path is required" : nil
        case "read_multiple_files":
            if let extra = unexpectedKeys(arguments, allowed: ["paths"]) { return extra }
            guard let paths = arguments["paths"]?.arrayValue, !paths.isEmpty, paths.count <= 100 else { return "paths must contain 1 to 100 entries" }
            return paths.allSatisfy { pathValue(["path": $0], "path") != nil } ? nil : "paths entries must be non-empty strings"
        case "write_file":
            if let extra = unexpectedKeys(arguments, allowed: ["path", "content"]) { return extra }
            guard pathValue(arguments, "path") != nil else { return "path is required" }
            guard let content = arguments["content"]?.stringValue, content.utf8.count <= PluginToolResults.blobMaxBytes else { return "content must be a string" }
            return nil
        case "edit_file":
            if let extra = unexpectedKeys(arguments, allowed: ["path", "edits", "dryRun"]) { return extra }
            guard pathValue(arguments, "path") != nil else { return "path is required" }
            guard let edits = arguments["edits"]?.arrayValue, !edits.isEmpty, edits.count <= 1_000 else { return "edits must contain 1 to 1000 entries" }
            for edit in edits {
                guard let object = edit.objectValue, object["oldText"]?.stringValue != nil, object["newText"]?.stringValue != nil,
                    object.keys.allSatisfy({ $0 == "oldText" || $0 == "newText" })
                else { return "edits entries must contain oldText and newText" }
            }
            if let dryRun = arguments["dryRun"], dryRun.boolValue == nil { return "dryRun must be a boolean" }
            return nil
        case "list_directory_with_sizes":
            if let extra = unexpectedKeys(arguments, allowed: ["path", "sortBy"]) { return extra }
            guard pathValue(arguments, "path") != nil else { return "path is required" }
            if let sortBy = arguments["sortBy"], sortBy.stringValue != "name", sortBy.stringValue != "size" { return "sortBy must be name or size" }
            return nil
        case "directory_tree":
            if let extra = unexpectedKeys(arguments, allowed: ["path", "excludePatterns"]) { return extra }
            guard pathValue(arguments, "path") != nil else { return "path is required" }
            return patterns(arguments["excludePatterns"], "excludePatterns")
        case "move_file":
            if let extra = unexpectedKeys(arguments, allowed: ["source", "destination"]) { return extra }
            guard pathValue(arguments, "source") != nil, pathValue(arguments, "destination") != nil else { return "source and destination are required" }
            return nil
        case "search_files":
            if let extra = unexpectedKeys(arguments, allowed: ["path", "pattern", "excludePatterns"]) { return extra }
            guard pathValue(arguments, "path") != nil else { return "path is required" }
            guard let pattern = arguments["pattern"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !pattern.isEmpty, pattern.count <= 4_096 else {
                return "pattern is required"
            }
            return patterns(arguments["excludePatterns"], "excludePatterns")
        default:
            return "Unknown filesystem plugin tool: \(tool)"
        }
    }
}
