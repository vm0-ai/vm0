import Foundation

/// One entry of an MCP `CallToolResult.content` array.
public enum McpContentEntry: Equatable, Sendable {
    case text(String)
    case image(data: String, mimeType: String)
    case audio(data: String, mimeType: String)
    case resource(uri: String, mimeType: String?, text: String?, blob: String?)
    case other(JSONValue)

    public static func parse(_ value: JSONValue) -> McpContentEntry {
        switch value["type"]?.stringValue {
        case "text":
            return .text(value["text"]?.stringValue ?? "")
        case "image":
            return .image(data: value["data"]?.stringValue ?? "", mimeType: value["mimeType"]?.stringValue ?? "application/octet-stream")
        case "audio":
            return .audio(data: value["data"]?.stringValue ?? "", mimeType: value["mimeType"]?.stringValue ?? "application/octet-stream")
        case "resource":
            let resource = value["resource"]
            return .resource(
                uri: resource?["uri"]?.stringValue ?? "", mimeType: resource?["mimeType"]?.stringValue,
                text: resource?["text"]?.stringValue, blob: resource?["blob"]?.stringValue
            )
        default:
            return .other(value)
        }
    }

    var json: JSONValue {
        switch self {
        case let .text(text): return .object(["type": "text", "text": .string(text)])
        case let .image(data, mimeType): return .object(["type": "image", "data": .string(data), "mimeType": .string(mimeType)])
        case let .audio(data, mimeType): return .object(["type": "audio", "data": .string(data), "mimeType": .string(mimeType)])
        case let .resource(uri, mimeType, text, blob):
            var resource: [String: JSONValue] = ["uri": .string(uri)]
            if let mimeType { resource["mimeType"] = .string(mimeType) }
            if let text { resource["text"] = .string(text) }
            if let blob { resource["blob"] = .string(blob) }
            return .object(["type": "resource", "resource": .object(resource)])
        case let .other(value): return value
        }
    }
}

public struct McpCallToolResult: Equatable, Sendable {
    public var content: [McpContentEntry]
    public var isError: Bool

    public init(content: [McpContentEntry], isError: Bool) {
        self.content = content
        self.isError = isError
    }

    public static func parse(_ value: JSONValue) -> McpCallToolResult? {
        guard let content = value["content"]?.arrayValue else { return nil }
        return McpCallToolResult(content: content.map(McpContentEntry.parse), isError: value["isError"]?.boolValue == true)
    }
}

public struct PluginToolResultContext: Sendable {
    public var plugin: String
    public var tool: String
    public var server: String?
    public var mapErrorCode: (@Sendable (String) -> ComputerUseErrorCode)?

    public init(plugin: String, tool: String, server: String? = nil, mapErrorCode: (@Sendable (String) -> ComputerUseErrorCode)? = nil) {
        self.plugin = plugin
        self.tool = tool
        self.server = server
        self.mapErrorCode = mapErrorCode
    }
}

/// Port of `desktop-plugin-tool-result.ts`: inline text up to 64 KiB,
/// offloaded content up to 10 MiB, everything else as pretty JSON.
public enum PluginToolResults {
    public static let inlineTextMaxBytes = 64 * 1024
    public static let inlineJsonMaxBytes = 256 * 1024
    public static let blobMaxBytes = 10 * 1024 * 1024
    public static let textMimeType = "text/plain; charset=utf-8"
    public static let defaultFilename = "plugin-result.txt"

    static func base(_ context: PluginToolResultContext) -> [String: JSONValue] {
        var result: [String: JSONValue] = ["plugin": .string(context.plugin), "tool": .string(context.tool)]
        if let server = context.server {
            result["server"] = .string(server)
        }
        return result
    }

    static func filenameForTool(_ context: PluginToolResultContext) -> String {
        let safe = context.tool.map { character -> Character in
            character.isASCII && (character.isLetter || character.isNumber || character == "_" || character == "-") ? character : "_"
        }
        return String(safe) + ".txt"
    }

    static func base64Length(_ base64: String) -> Int {
        Data(base64Encoded: base64)?.count ?? 0
    }

    public static func contentResult(
        _ context: PluginToolResultContext, text: String? = nil, dataBase64: String? = nil, mimeType: String, fileName: String, sizeBytes: Int
    ) -> ComputerUseCommandExecutionResult {
        if sizeBytes > blobMaxBytes {
            return .failure(.resultTooLarge, "Plugin result is \(sizeBytes) bytes and exceeds the \(blobMaxBytes) byte limit.")
        }
        var result = base(context)
        result["sizeBytes"] = .number(Double(sizeBytes))
        result["offloaded"] = .bool(true)
        if let text, !text.isEmpty {
            result["summary"] = .string("Saved \(sizeBytes) bytes")
        }
        result["pluginContent"] = .object([
            "dataBase64": .string(dataBase64 ?? Data((text ?? "").utf8).base64EncodedString()),
            "mimeType": .string(mimeType),
            "fileName": .string(fileName),
        ])
        return .succeeded(result)
    }

    public static func textResult(_ context: PluginToolResultContext, text: String) -> ComputerUseCommandExecutionResult {
        let sizeBytes = text.utf8.count
        if sizeBytes <= inlineTextMaxBytes {
            var result = base(context)
            result["content"] = .string(text)
            result["sizeBytes"] = .number(Double(sizeBytes))
            result["truncated"] = .bool(false)
            return .succeeded(result)
        }
        return contentResult(context, text: text, mimeType: textMimeType, fileName: filenameForTool(context), sizeBytes: sizeBytes)
    }

    public static func jsonResult(_ context: PluginToolResultContext, value: JSONValue) -> ComputerUseCommandExecutionResult {
        textResult(context, text: value.serialized(options: JSONSerializationOptions(pretty: true)) + "\n")
    }

    public static func normalize(_ context: PluginToolResultContext, result: McpCallToolResult) -> ComputerUseCommandExecutionResult {
        if result.isError {
            let message = result.content.compactMap { entry -> String? in
                if case let .text(text) = entry, !text.isEmpty { return text }
                return nil
            }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            let code = context.mapErrorCode?(message) ?? .mcpError
            return .failure(code, message.isEmpty ? "Plugin tool \(context.tool) failed" : message)
        }
        let texts = result.content.compactMap { entry -> String? in
            if case let .text(text) = entry { return text }
            return nil
        }
        if texts.count == result.content.count {
            return textResult(context, text: texts.joined(separator: "\n"))
        }
        for entry in result.content {
            switch entry {
            case let .image(data, mimeType), let .audio(data, mimeType):
                return contentResult(context, dataBase64: data, mimeType: mimeType, fileName: defaultFilename, sizeBytes: base64Length(data))
            default:
                continue
            }
        }
        for entry in result.content {
            if case let .resource(uri, mimeType, text, blob) = entry {
                let baseName = (uri as NSString).lastPathComponent
                let fileName = baseName.isEmpty ? defaultFilename : baseName
                if let text {
                    return contentResult(context, text: text, mimeType: mimeType ?? textMimeType, fileName: fileName, sizeBytes: text.utf8.count)
                }
                let blob = blob ?? ""
                return contentResult(
                    context, dataBase64: blob, mimeType: mimeType ?? "application/octet-stream", fileName: fileName,
                    sizeBytes: base64Length(blob)
                )
            }
        }
        return jsonResult(context, value: .array(result.content.map(\.json)))
    }
}
