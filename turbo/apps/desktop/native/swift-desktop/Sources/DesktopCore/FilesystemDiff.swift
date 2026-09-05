import Foundation

/// Ports the line diff and four-line patch context used by jsdiff 5.2.2.
/// Its BSD license is retained in Resources/jsdiff-LICENSE.txt.
enum FilesystemDiff {
  private enum Kind { case common, added, removed }
  private final class Component {
    let kind: Kind
    let count: Int
    let previous: Component?
    init(_ kind: Kind, _ count: Int, _ previous: Component?) {
      self.kind = kind
      self.count = count
      self.previous = previous
    }
  }
  private struct Path {
    var oldPosition: Int = -1
    var last: Component?
    func adding(_ kind: Kind) -> Path {
      let component: Component
      if let last, last.kind == kind {
        component = Component(kind, last.count + 1, last.previous)
      } else {
        component = Component(kind, 1, last)
      }
      return Path(oldPosition: oldPosition + (kind == .removed ? 1 : 0), last: component)
    }
    mutating func consumeCommon(_ before: [String], _ after: [String], diagonal: Int) -> Int {
      var newPosition = oldPosition - diagonal
      var count = 0
      while oldPosition + 1 < before.count, newPosition + 1 < after.count,
        before[oldPosition + 1] == after[newPosition + 1]
      {
        oldPosition += 1
        newPosition += 1
        count += 1
      }
      if count > 0 { last = Component(.common, count, last) }
      return newPosition
    }
  }
  private struct Chunk {
    let kind: Kind
    let lines: [String]
  }

  static func formatted(_ original: String, _ edited: String, path: String) -> String {
    let before = original.replacingOccurrences(of: "\r\n", with: "\n")
    let after = edited.replacingOccurrences(of: "\r\n", with: "\n")
    var chunks = changes(lines(before), lines(after))
    chunks.append(Chunk(kind: .common, lines: []))
    var patch = Patch(before: before, after: after)
    for index in chunks.indices {
      patch.consume(
        chunks[index], previous: index > 0 ? chunks[index - 1] : nil,
        index: index, total: chunks.count)
    }
    let diff =
      "Index: \(path)\n" + String(repeating: "=", count: 67)
      + "\n--- \(path)\toriginal\n+++ \(path)\tmodified\n" + patch.output
    var fence = "```"
    while diff.contains(fence) { fence += "`" }
    return fence + "diff\n" + diff + fence + "\n\n"
  }

  private static func lines(_ text: String) -> [String] {
    guard !text.isEmpty else { return [] }
    var parts = text.components(separatedBy: "\n")
    if text.hasSuffix("\n") {
      parts.removeLast()
      return parts.map { $0 + "\n" }
    }
    return parts.enumerated().map { $0.offset < parts.count - 1 ? $0.element + "\n" : $0.element }
  }

  private static func changes(_ before: [String], _ after: [String]) -> [Chunk] {
    var initial = Path()
    let newPosition = initial.consumeCommon(before, after, diagonal: 0)
    if initial.oldPosition + 1 >= before.count, newPosition + 1 >= after.count {
      return materialize(initial.last, before: before, after: after)
    }
    var best = [0: initial]
    var minimum = Int.min
    var maximum = Int.max
    for length in 1...(before.count + after.count) {
      var diagonal = max(minimum, -length)
      while diagonal <= min(maximum, length) {
        let removed = best.removeValue(forKey: diagonal - 1)
        let added = best[diagonal + 1]
        let canAdd =
          added.map { $0.oldPosition - diagonal >= 0 && $0.oldPosition - diagonal < after.count }
          == true
        let canRemove = removed.map { $0.oldPosition + 1 < before.count } == true
        if !canAdd && !canRemove {
          best.removeValue(forKey: diagonal)
          diagonal += 2
          continue
        }
        var next: Path
        if !canRemove || (canAdd && removed!.oldPosition + 1 < added!.oldPosition) {
          next = added!.adding(.added)
        } else {
          next = removed!.adding(.removed)
        }
        let newPosition = next.consumeCommon(before, after, diagonal: diagonal)
        if next.oldPosition + 1 >= before.count, newPosition + 1 >= after.count {
          return materialize(next.last, before: before, after: after)
        }
        best[diagonal] = next
        if next.oldPosition + 1 >= before.count { maximum = min(maximum, diagonal - 1) }
        if newPosition + 1 >= after.count { minimum = max(minimum, diagonal + 1) }
        diagonal += 2
      }
    }
    preconditionFailure("A finite line edit graph must have a complete path")
  }

  private static func materialize(_ last: Component?, before: [String], after: [String]) -> [Chunk]
  {
    var components: [Component] = []
    var current = last
    while let node = current {
      components.append(node)
      current = node.previous
    }
    var oldPosition = 0
    var newPosition = 0
    var chunks: [Chunk] = []
    for component in components.reversed() {
      let tokens: ArraySlice<String>
      if component.kind == .removed {
        tokens = before[oldPosition..<(oldPosition + component.count)]
        oldPosition += component.count
      } else {
        tokens = after[newPosition..<(newPosition + component.count)]
        newPosition += component.count
        if component.kind == .common { oldPosition += component.count }
      }
      let chunk = Chunk(
        kind: component.kind, lines: tokens.map { $0.hasSuffix("\n") ? String($0.dropLast()) : $0 })
      // jsdiff traverses insertions first, then presents removals first.
      if component.kind == .removed, chunks.last?.kind == .added {
        chunks.insert(chunk, at: chunks.count - 1)
      } else {
        chunks.append(chunk)
      }
    }
    return chunks
  }

  private struct Patch {
    let before: String
    let after: String
    var output = ""
    var oldLine = 1
    var newLine = 1
    var oldStart = 0
    var newStart = 0
    var range: [String] = []

    mutating func consume(_ chunk: Chunk, previous: Chunk?, index: Int, total: Int) {
      if chunk.kind != .common {
        if oldStart == 0 {
          range = previous.map { $0.lines.suffix(4).map { " " + $0 } } ?? []
          oldStart = oldLine - range.count
          newStart = newLine - range.count
        }
        range += chunk.lines.map { (chunk.kind == .added ? "+" : "-") + $0 }
        if chunk.kind == .added {
          newLine += chunk.lines.count
        } else {
          oldLine += chunk.lines.count
        }
        return
      }
      if oldStart != 0 {
        if chunk.lines.count <= 8 && index < total - 2 {
          range += chunk.lines.map { " " + $0 }
        } else {
          finish(chunk.lines, atEnd: index >= total - 2)
        }
      }
      oldLine += chunk.lines.count
      newLine += chunk.lines.count
    }

    mutating func finish(_ lines: [String], atEnd: Bool) {
      let context = min(4, lines.count)
      range += lines.prefix(context).map { " " + $0 }
      let oldCount = oldLine - oldStart + context
      let newCount = newLine - newStart + context
      if atEnd && lines.count <= 4 {
        let beforeAdds = lines.isEmpty && range.count > oldCount
        if !before.hasSuffix("\n") && beforeAdds && !before.isEmpty {
          range.insert("\\ No newline at end of file", at: oldCount)
        }
        if (!before.hasSuffix("\n") && !beforeAdds) || !after.hasSuffix("\n") {
          range.append("\\ No newline at end of file")
        }
      }
      output +=
        "@@ -\(oldStart - (oldCount == 0 ? 1 : 0)),\(oldCount) +\(newStart - (newCount == 0 ? 1 : 0)),\(newCount) @@\n"
      output += range.joined(separator: "\n") + "\n"
      oldStart = 0
      newStart = 0
      range = []
    }
  }
}
