import Foundation

/// A JSON document model with a deterministic serializer.
///
/// Foundation's `JSONSerialization` bridges booleans and numbers differently
/// on Darwin and Linux and cannot format integral doubles without a trailing
/// `.0`. The desktop protocols (platform API bodies, native helper lines, MCP
/// messages, the preferences file) all originate from JavaScript, so this type
/// keeps `JSON.stringify` semantics: integral numbers print as integers,
/// non-finite numbers become `null`, and objects serialize with sorted keys.
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByStringLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var object: [String: JSONValue] = [:]
        for (key, value) in elements {
            object[key] = value
        }
        self = .object(object)
    }
}

extension JSONValue {
    public init(_ value: Int) { self = .number(Double(value)) }
    public init(_ value: Double) { self = .number(value) }
    public init(_ value: String) { self = .string(value) }
    public init(_ value: Bool) { self = .bool(value) }
    public init(_ values: [String]) { self = .array(values.map(JSONValue.string)) }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var doubleValue: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        guard case let .number(value) = self, value.isFinite,
            value == value.rounded(.towardZero),
            value >= Double(Int.min), value <= Double(Int.max)
        else {
            return nil
        }
        return Int(value)
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(value) = self { return value }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    public subscript(index: Int) -> JSONValue? {
        guard let array = arrayValue, index >= 0, index < array.count else { return nil }
        return array[index]
    }
}

// MARK: - Serialization

public struct JSONSerializationOptions: Sendable {
    /// Indent with two spaces per level, like `JSON.stringify(value, null, 2)`.
    public var pretty: Bool

    public init(pretty: Bool = false) {
        self.pretty = pretty
    }
}

extension JSONValue {
    public func serialized(options: JSONSerializationOptions = JSONSerializationOptions()) -> String {
        var output = ""
        JSONWriter.write(self, into: &output, pretty: options.pretty, depth: 0)
        return output
    }

    public func serializedData(options: JSONSerializationOptions = JSONSerializationOptions()) -> Data {
        Data(serialized(options: options).utf8)
    }
}

private enum JSONWriter {
    static func write(_ value: JSONValue, into output: inout String, pretty: Bool, depth: Int) {
        switch value {
        case .null:
            output += "null"
        case let .bool(bool):
            output += bool ? "true" : "false"
        case let .number(number):
            output += formatNumber(number)
        case let .string(string):
            writeString(string, into: &output)
        case let .array(array):
            if array.isEmpty {
                output += "[]"
                return
            }
            output += "["
            for (index, element) in array.enumerated() {
                if index > 0 { output += "," }
                if pretty {
                    output += "\n"
                    output += indent(depth + 1)
                }
                write(element, into: &output, pretty: pretty, depth: depth + 1)
            }
            if pretty {
                output += "\n"
                output += indent(depth)
            }
            output += "]"
        case let .object(object):
            if object.isEmpty {
                output += "{}"
                return
            }
            output += "{"
            for (index, key) in object.keys.sorted().enumerated() {
                if index > 0 { output += "," }
                if pretty {
                    output += "\n"
                    output += indent(depth + 1)
                }
                writeString(key, into: &output)
                output += pretty ? ": " : ":"
                write(object[key]!, into: &output, pretty: pretty, depth: depth + 1)
            }
            if pretty {
                output += "\n"
                output += indent(depth)
            }
            output += "}"
        }
    }

    static func indent(_ depth: Int) -> String {
        String(repeating: "  ", count: depth)
    }

    static func formatNumber(_ number: Double) -> String {
        guard number.isFinite else { return "null" }
        if number == number.rounded(.towardZero), abs(number) < 1e15 {
            return String(Int64(number))
        }
        return String(number)
    }

    static func writeString(_ string: String, into output: inout String) {
        output += "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            case "\u{08}": output += "\\b"
            case "\u{0C}": output += "\\f"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04x", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        output += "\""
    }
}

// MARK: - Parsing

public struct JSONParseError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public let offset: Int

    public var description: String {
        "\(message) at offset \(offset)"
    }
}

extension JSONValue {
    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    public static func parse(_ data: Data) throws -> JSONValue {
        var parser = JSONParser(bytes: [UInt8](data))
        parser.skipWhitespace()
        let value = try parser.parseValue()
        parser.skipWhitespace()
        if parser.index != parser.bytes.count {
            throw JSONParseError(message: "Unexpected trailing content", offset: parser.index)
        }
        return value
    }
}

private struct JSONParser {
    let bytes: [UInt8]
    var index = 0

    init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    mutating func skipWhitespace() {
        while index < bytes.count {
            switch bytes[index] {
            case 0x20, 0x09, 0x0A, 0x0D: index += 1
            default: return
            }
        }
    }

    mutating func parseValue() throws -> JSONValue {
        guard index < bytes.count else {
            throw JSONParseError(message: "Unexpected end of JSON input", offset: index)
        }
        switch bytes[index] {
        case UInt8(ascii: "{"): return try parseObject()
        case UInt8(ascii: "["): return try parseArray()
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expectLiteral("true"); return .bool(true)
        case UInt8(ascii: "f"): try expectLiteral("false"); return .bool(false)
        case UInt8(ascii: "n"): try expectLiteral("null"); return .null
        default: return try parseNumber()
        }
    }

    mutating func expectLiteral(_ literal: String) throws {
        let literalBytes = Array(literal.utf8)
        guard index + literalBytes.count <= bytes.count,
            Array(bytes[index..<(index + literalBytes.count)]) == literalBytes
        else {
            throw JSONParseError(message: "Unexpected token", offset: index)
        }
        index += literalBytes.count
    }

    mutating func parseObject() throws -> JSONValue {
        index += 1
        var object: [String: JSONValue] = [:]
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
            index += 1
            return .object(object)
        }
        while true {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else {
                throw JSONParseError(message: "Expected object key", offset: index)
            }
            let key = try parseString()
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else {
                throw JSONParseError(message: "Expected ':' after object key", offset: index)
            }
            index += 1
            skipWhitespace()
            object[key] = try parseValue()
            skipWhitespace()
            guard index < bytes.count else {
                throw JSONParseError(message: "Unterminated object", offset: index)
            }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
                continue
            }
            if bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(object)
            }
            throw JSONParseError(message: "Expected ',' or '}' in object", offset: index)
        }
    }

    mutating func parseArray() throws -> JSONValue {
        index += 1
        var array: [JSONValue] = []
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
            index += 1
            return .array(array)
        }
        while true {
            skipWhitespace()
            array.append(try parseValue())
            skipWhitespace()
            guard index < bytes.count else {
                throw JSONParseError(message: "Unterminated array", offset: index)
            }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
                continue
            }
            if bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(array)
            }
            throw JSONParseError(message: "Expected ',' or ']' in array", offset: index)
        }
    }

    mutating func parseString() throws -> String {
        index += 1
        var scalars = String.UnicodeScalarView()
        var chunkStart = index
        var buffer: [UInt8] = []

        func flushChunk(_ parser: JSONParser, _ buffer: inout [UInt8], _ chunkStart: Int) {
            if chunkStart < parser.index {
                buffer.append(contentsOf: parser.bytes[chunkStart..<parser.index])
            }
        }

        while index < bytes.count {
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") {
                flushChunk(self, &buffer, chunkStart)
                index += 1
                if !buffer.isEmpty {
                    guard let decoded = String(bytes: buffer, encoding: .utf8) else {
                        throw JSONParseError(message: "Invalid UTF-8 in string", offset: index)
                    }
                    scalars.append(contentsOf: decoded.unicodeScalars)
                }
                return String(scalars)
            }
            if byte == UInt8(ascii: "\\") {
                flushChunk(self, &buffer, chunkStart)
                if !buffer.isEmpty {
                    guard let decoded = String(bytes: buffer, encoding: .utf8) else {
                        throw JSONParseError(message: "Invalid UTF-8 in string", offset: index)
                    }
                    scalars.append(contentsOf: decoded.unicodeScalars)
                    buffer.removeAll(keepingCapacity: true)
                }
                index += 1
                guard index < bytes.count else {
                    throw JSONParseError(message: "Unterminated string escape", offset: index)
                }
                let escape = bytes[index]
                index += 1
                switch escape {
                case UInt8(ascii: "\""): scalars.append("\"")
                case UInt8(ascii: "\\"): scalars.append("\\")
                case UInt8(ascii: "/"): scalars.append("/")
                case UInt8(ascii: "b"): scalars.append("\u{08}")
                case UInt8(ascii: "f"): scalars.append("\u{0C}")
                case UInt8(ascii: "n"): scalars.append("\n")
                case UInt8(ascii: "r"): scalars.append("\r")
                case UInt8(ascii: "t"): scalars.append("\t")
                case UInt8(ascii: "u"):
                    var codeUnit = try parseHex4()
                    if codeUnit >= 0xD800, codeUnit <= 0xDBFF {
                        // Surrogate pair.
                        guard index + 1 < bytes.count, bytes[index] == UInt8(ascii: "\\"),
                            bytes[index + 1] == UInt8(ascii: "u")
                        else {
                            throw JSONParseError(message: "Unpaired surrogate", offset: index)
                        }
                        index += 2
                        let low = try parseHex4()
                        guard low >= 0xDC00, low <= 0xDFFF else {
                            throw JSONParseError(message: "Invalid low surrogate", offset: index)
                        }
                        codeUnit = 0x10000 + ((codeUnit - 0xD800) << 10) + (low - 0xDC00)
                    }
                    guard let scalar = Unicode.Scalar(codeUnit) else {
                        throw JSONParseError(message: "Invalid unicode escape", offset: index)
                    }
                    scalars.append(scalar)
                default:
                    throw JSONParseError(message: "Invalid escape sequence", offset: index)
                }
                chunkStart = index
                continue
            }
            if byte < 0x20 {
                throw JSONParseError(message: "Control character in string", offset: index)
            }
            index += 1
        }
        throw JSONParseError(message: "Unterminated string", offset: index)
    }

    mutating func parseHex4() throws -> UInt32 {
        guard index + 4 <= bytes.count else {
            throw JSONParseError(message: "Truncated unicode escape", offset: index)
        }
        var value: UInt32 = 0
        for _ in 0..<4 {
            let byte = bytes[index]
            index += 1
            value <<= 4
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): value |= UInt32(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"): value |= UInt32(byte - UInt8(ascii: "a") + 10)
            case UInt8(ascii: "A")...UInt8(ascii: "F"): value |= UInt32(byte - UInt8(ascii: "A") + 10)
            default:
                throw JSONParseError(message: "Invalid hex digit", offset: index - 1)
            }
        }
        return value
    }

    mutating func parseNumber() throws -> JSONValue {
        let start = index
        if index < bytes.count, bytes[index] == UInt8(ascii: "-") {
            index += 1
        }
        var sawDigit = false
        while index < bytes.count {
            let byte = bytes[index]
            if byte >= UInt8(ascii: "0"), byte <= UInt8(ascii: "9") {
                sawDigit = true
                index += 1
            } else if byte == UInt8(ascii: ".") || byte == UInt8(ascii: "e") || byte == UInt8(ascii: "E")
                || byte == UInt8(ascii: "+") || byte == UInt8(ascii: "-")
            {
                index += 1
            } else {
                break
            }
        }
        guard sawDigit, let text = String(bytes: bytes[start..<index], encoding: .utf8),
            let number = Double(text)
        else {
            throw JSONParseError(message: "Invalid number", offset: start)
        }
        return .number(number)
    }
}
