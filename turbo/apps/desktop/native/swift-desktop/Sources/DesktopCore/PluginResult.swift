import Foundation

public enum PluginResult {
  public static let maximumBytes = 10 * 1024 * 1024

  public static func text(_ text: String, context: JSON) throws -> JSON {
    let data = Data(text.utf8)
    if data.count > 64 * 1024 {
      return try binary(
        data, mimeType: "text/plain; charset=utf-8",
        fileName: (context["tool"].string ?? "plugin-result") + ".txt", context: context)
    }
    var result = context
    result["content"] = .string(text)
    result["sizeBytes"] = .number(Double(data.count))
    result["truncated"] = .bool(false)
    return .success(result)
  }

  public static func binary(_ data: Data, mimeType: String, fileName: String, context: JSON) throws
    -> JSON
  {
    guard data.count <= maximumBytes else {
      throw DesktopFailure("result_too_large", "Plugin result exceeds 10 MiB")
    }
    var result = context
    result["sizeBytes"] = .number(Double(data.count))
    result["offloaded"] = .bool(true)
    result["pluginContent"] = .object([
      "dataBase64": .string(data.base64EncodedString()), "mimeType": .string(mimeType),
      "fileName": .string(fileName),
    ])
    return .success(result)
  }

  public static func normalize(_ value: JSON, context: JSON) throws -> JSON {
    let content = value["content"].array
    let text = content.filter { $0["type"].string == "text" }.compactMap { $0["text"].string }
      .joined(separator: "\n")
    if value["isError"].bool {
      throw DesktopFailure("mcp_error", text.isEmpty ? "MCP tool failed" : text)
    }
    if content.allSatisfy({ $0["type"].string == "text" }) {
      return try self.text(text, context: context)
    }
    if let binary = content.first(where: { ["image", "audio"].contains($0["type"].string) }),
      let encoded = binary["data"].string, let bytes = Data(base64Encoded: encoded)
    {
      return try self.binary(
        bytes, mimeType: binary["mimeType"].string ?? "application/octet-stream",
        fileName: "plugin-result.txt", context: context)
    }
    if let resource = content.first(where: { $0["type"].string == "resource" })?["resource"] {
      let bytes: Data
      if let text = resource["text"].string {
        bytes = Data(text.utf8)
      } else if let blob = resource["blob"].string, let data = Data(base64Encoded: blob) {
        bytes = data
      } else {
        throw DesktopFailure("mcp_error", "Invalid MCP resource content")
      }
      return try binary(
        bytes, mimeType: resource["mimeType"].string ?? "application/octet-stream",
        fileName: URL(string: resource["uri"].string ?? "")?.lastPathComponent
          ?? "plugin-result.txt", context: context)
    }
    return try self.text(JSON.array(content).text(pretty: true), context: context)
  }
}
