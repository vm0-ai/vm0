import Foundation

/// Path-relative glob matching used by the filesystem server. Wildcards do not
/// cross a path separator, except a complete ** segment; dotfiles participate.
enum FilesystemMatching {
  static func matches(_ pattern: String, path: String) -> Bool {
    guard pattern.count <= 4096 else { return false }
    var pattern = pattern
    var negate = false
    while pattern.hasPrefix("!") {
      negate.toggle()
      pattern.removeFirst()
    }
    if pattern.hasPrefix("#") { return false }
    let expression = "^(?:" + regex(Array(pattern)) + ")$"
    let matched = path.range(of: expression, options: .regularExpression) != nil
    return negate ? !matched : matched
  }

  private static func regex(_ chars: [Character]) -> String {
    var output = ""
    var index = 0
    while index < chars.count {
      let char = chars[index]
      if char == "\\", index + 1 < chars.count {
        index += 1
        output += NSRegularExpression.escapedPattern(for: String(chars[index]))
      } else if char == "{", let close = matchingClose(chars, at: index, open: "{", close: "}") {
        let body = Array(chars[(index + 1)..<close])
        let alternatives = split(body, on: ",")
        if index > 0, chars[index - 1] == "$" {
          output += NSRegularExpression.escapedPattern(for: "{" + String(body) + "}")
        } else if let values = sequence(body) {
          output +=
            "(?:"
            + values.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|")
            + ")"
        } else if alternatives.count > 1 {
          output += "(?:" + alternatives.map(regex).joined(separator: "|") + ")"
        } else {
          output += "\\{" + regex(body) + "\\}"
        }
        index = close
      } else if ["@", "+", "?", "*", "!"].contains(char), index + 1 < chars.count,
        chars[index + 1] == "(",
        let close = matchingClose(chars, at: index + 1, open: "(", close: ")")
      {
        let body = split(Array(chars[(index + 2)..<close]), on: "|").map(regex).joined(
          separator: "|")
        if char == "!" {
          let end = chars[(close + 1)...].firstIndex(of: "/") ?? chars.count
          let suffix = regex(Array(chars[(close + 1)..<end]))
          output += "(?!(?:" + body + ")" + suffix + "(?:/|$))[^/]*"
        } else {
          output += "(?:" + body + ")" + (char == "@" ? "" : String(char))
        }
        index = close
      } else if char == "*" {
        if index + 1 < chars.count, chars[index + 1] == "*",
          index == 0 || chars[index - 1] == "/",
          index + 2 == chars.count || chars[index + 2] == "/"
        {
          if index + 2 < chars.count {
            output += "(?:[^/]+/)*"
            index += 2
          } else {
            output += ".*"
            index += 1
          }
        } else {
          output += "[^/]*"
        }
      } else if char == "?" {
        output += "[^/]"
      } else if char == "[", let close = chars[(index + 1)...].firstIndex(of: "]") {
        var body = String(chars[(index + 1)..<close])
        if body.hasPrefix("!") { body = "^" + body.dropFirst() }
        output += "[" + body + "]"
        index = close
      } else {
        output += NSRegularExpression.escapedPattern(for: String(char))
      }
      index += 1
    }
    return output
  }

  /// Numeric/alphabetic range behavior follows brace-expansion, including
  /// zero padding, descending/zero steps, and its bounded expansion budget.
  private static func sequence(_ body: [Character]) -> [String]? {
    let text = String(body)
    let numeric =
      text.range(of: "^-?[0-9]+\\.\\.-?[0-9]+(?:\\.\\.-?[0-9]+)?$", options: .regularExpression)
      != nil
    let alpha =
      text.range(of: "^[a-zA-Z]\\.\\.[a-zA-Z](?:\\.\\.-?[0-9]+)?$", options: .regularExpression)
      != nil
    guard numeric || alpha else { return nil }
    let parts = text.components(separatedBy: "..")
    guard
      let first = numeric ? Int(parts[0]) : parts[0].unicodeScalars.first.map({ Int($0.value) }),
      let last = numeric ? Int(parts[1]) : parts[1].unicodeScalars.first.map({ Int($0.value) })
    else { return nil }
    let amount: Int
    if parts.count == 3 {
      guard let step = Int(parts[2]) else { return nil }
      amount = max(1, Int(min(step.magnitude, UInt(Int.max))))
    } else {
      amount = 1
    }
    let step = first <= last ? amount : -amount
    let padded = parts.contains { $0.range(of: "^-?0[0-9]", options: .regularExpression) != nil }
    let width = max(parts[0].count, parts[1].count)
    var values: [String] = []
    var characters = 0
    var current = first
    while first <= last ? current <= last : current >= last {
      var value = numeric ? String(current) : String(UnicodeScalar(current)!)
      if alpha && value == "\\" { value = "" }
      if numeric && padded && value.count < width {
        let zeroes = String(repeating: "0", count: width - value.count)
        value = current < 0 ? "-" + zeroes + value.dropFirst() : zeroes + value
      }
      guard values.count < 100_000, characters + value.count <= 4_000_000 else { break }
      values.append(value)
      characters += value.count
      let (next, overflow) = current.addingReportingOverflow(step)
      if overflow { break }
      current = next
    }
    return values
  }

  private static func matchingClose(
    _ chars: [Character], at start: Int, open: Character, close: Character
  ) -> Int? {
    var depth = 0
    var escaped = false
    for index in start..<chars.count {
      if escaped {
        escaped = false
        continue
      }
      if chars[index] == "\\" {
        escaped = true
        continue
      }
      if chars[index] == open { depth += 1 }
      if chars[index] == close { depth -= 1 }
      if depth == 0 { return index }
    }
    return nil
  }

  private static func split(_ chars: [Character], on separator: Character) -> [[Character]] {
    var result: [[Character]] = [[]]
    var depth = 0
    var escaped = false
    for char in chars {
      if escaped {
        result[result.count - 1].append(char)
        escaped = false
        continue
      }
      if char == "\\" {
        result[result.count - 1].append(char)
        escaped = true
        continue
      }
      if ["{", "("].contains(char) { depth += 1 }
      if ["}", ")"].contains(char) { depth -= 1 }
      if char == separator && depth == 0 {
        result.append([])
      } else {
        result[result.count - 1].append(char)
      }
    }
    return result
  }

  static func edit(_ original: String, edits: [JSON]) throws -> String {
    var content = original.replacingOccurrences(of: "\r\n", with: "\n")
    for edit in edits {
      guard let old = edit["oldText"].string, let new = edit["newText"].string else {
        throw DesktopFailure("invalid_arguments", "Each edit needs oldText and newText strings")
      }
      let oldText = old.replacingOccurrences(of: "\r\n", with: "\n")
      let newText = new.replacingOccurrences(of: "\r\n", with: "\n")
      if oldText.isEmpty {
        content = newText + content
        continue
      }
      if let range = content.range(of: oldText) {
        content.replaceSubrange(range, with: newText)
        continue
      }
      let oldLines = oldText.components(separatedBy: "\n")
      var lines = content.components(separatedBy: "\n")
      let index =
        lines.count < oldLines.count
        ? nil
        : (0...(lines.count - oldLines.count)).first { offset in
          oldLines.indices.allSatisfy {
            oldLines[$0].trimmingCharacters(in: .whitespacesAndNewlines)
              == lines[offset + $0].trimmingCharacters(in: .whitespacesAndNewlines)
          }
        }
      guard let index else {
        throw DesktopFailure("mcp_error", "Could not find exact match for edit:\n" + old)
      }
      let indent = String(lines[index].prefix(while: \.isWhitespace))
      let replacement = newText.components(separatedBy: "\n").enumerated().map { offset, line in
        let trimmed = String(line.drop(while: \.isWhitespace))
        if offset == 0 { return indent + trimmed }
        let oldIndent =
          oldLines.indices.contains(offset)
          ? oldLines[offset].prefix(while: \.isWhitespace).count : 0
        let newIndent = line.prefix(while: \.isWhitespace).count
        return oldIndent > 0 && newIndent > 0
          ? indent + String(repeating: " ", count: max(0, newIndent - oldIndent)) + trimmed : line
      }
      lines.replaceSubrange(index..<(index + oldLines.count), with: replacement)
      content = lines.joined(separator: "\n")
    }
    return content
  }
}
