import Foundation

/// The wire format shared by the desktop API, native helpers, and MCP servers.
/// Values crossing an asynchronous boundary remain typed and Sendable.
public enum JSON: Codable, Sendable, Equatable {
  case object([String: JSON])
  case array([JSON])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSON].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSON].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  public subscript(_ key: String) -> JSON {
    get { object?[key] ?? .null }
    set {
      var fields = object ?? [:]
      fields[key] = newValue
      self = .object(fields)
    }
  }
  public var object: [String: JSON]? { if case .object(let v) = self { v } else { nil } }
  public var array: [JSON] { if case .array(let v) = self { v } else { [] } }
  public var string: String? { if case .string(let v) = self { v } else { nil } }
  public var number: Double? { if case .number(let v) = self { v } else { nil } }
  public var bool: Bool { if case .bool(let v) = self { v } else { false } }

  public func requireString(_ key: String) throws -> String {
    guard let value = self[key].string, !value.isEmpty else {
      throw DesktopFailure("invalid_arguments", "Missing or invalid \(key)")
    }
    return value
  }

  public func encoded(pretty: Bool = false) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting =
      pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
    return try encoder.encode(self)
  }

  public func text(pretty: Bool = false) throws -> String {
    String(decoding: try encoded(pretty: pretty), as: UTF8.self)
  }

  public static func decode(_ data: Data) throws -> JSON {
    try JSONDecoder().decode(JSON.self, from: data)
  }
  public static func strings(_ values: [String]) -> JSON { .array(values.map(JSON.string)) }
  public static func success(_ result: JSON) -> JSON {
    .object(["status": .string("succeeded"), "result": result])
  }
}

public struct DesktopFailure: Error, LocalizedError, Sendable {
  public let code: String
  public let message: String
  public init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
  public var errorDescription: String? { message }
  public var response: JSON {
    .object([
      "status": .string("failed"),
      "error": .object(["code": .string(code), "message": .string(message)]),
    ])
  }
}
