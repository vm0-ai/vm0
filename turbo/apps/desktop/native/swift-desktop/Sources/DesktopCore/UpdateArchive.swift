import Foundation

/// Inspect the ZIP central directory before invoking ditto. No archive entry
/// may leave the expected app bundle, and links may only point down within it.
public enum UpdateArchive {
  public static func validate(_ file: URL, appName: String) throws -> [String] {
    let handle = try FileHandle(forReadingFrom: file)
    defer { handle.closeFile() }
    let size = try handle.seekToEnd()
    let tailOffset = size > 65557 ? size - 65557 : 0
    try handle.seek(toOffset: tailOffset)
    let tail = try handle.readToEnd() ?? Data()
    guard
      let footer = tail.range(of: Data([0x50, 0x4b, 0x05, 0x06]), options: .backwards)?.lowerBound
    else { throw invalid() }
    func integer(_ bytes: Data, _ offset: Int, _ count: Int) throws -> Int {
      guard offset >= 0, offset + count <= bytes.count else { throw invalid() }
      return (0..<count).reduce(0) { $0 | Int(bytes[offset + $1]) << ($1 * 8) }
    }
    guard try integer(tail, footer + 4, 2) == 0, try integer(tail, footer + 6, 2) == 0 else {
      throw invalid()
    }
    let count = try integer(tail, footer + 10, 2)
    let directorySize = try integer(tail, footer + 12, 4)
    let directoryOffset = try integer(tail, footer + 16, 4)
    guard count < 65535, directorySize <= 16 * 1024 * 1024,
      UInt64(directoryOffset + directorySize) <= size
    else { throw invalid() }
    try handle.seek(toOffset: UInt64(directoryOffset))
    let directory = try handle.read(upToCount: directorySize) ?? Data()
    var offset = 0
    var links: [String] = []
    for _ in 0..<count {
      guard try integer(directory, offset, 4) == 0x0201_4b50 else { throw invalid() }
      let nameLength = try integer(directory, offset + 28, 2)
      let extraLength = try integer(directory, offset + 30, 2)
      let commentLength = try integer(directory, offset + 32, 2)
      let mode = try integer(directory, offset + 38, 4) >> 16
      let end = offset + 46 + nameLength
      guard end <= directory.count,
        let name = String(data: directory[(offset + 46)..<end], encoding: .utf8),
        !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0"),
        !name.split(separator: "/").contains(".."),
        name == appName || name.hasPrefix(appName + "/") || name.hasPrefix("__MACOSX/"),
        name.rangeOfCharacter(from: CharacterSet(charactersIn: "*?[]")) == nil
      else { throw invalid() }
      if mode & 0xf000 == 0xa000 { links.append(name) }
      offset = end + extraLength + commentLength
    }
    return links
  }

  public static func validateLink(_ target: String) throws {
    guard !target.isEmpty, !target.hasPrefix("/"), !target.contains("\\"), !target.contains("\0"),
      !target.split(separator: "/").contains("..")
    else { throw invalid() }
  }

  private static func invalid() -> DesktopFailure {
    DesktopFailure(
      "update_archive", "Update archive contains an invalid path or unsupported ZIP structure")
  }
}
