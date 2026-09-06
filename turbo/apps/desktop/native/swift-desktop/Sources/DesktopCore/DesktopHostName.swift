import Foundation

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

public enum DesktopHostName {
  public static func read(fallback: String) -> String {
    // ProcessInfo.hostName can synchronously resolve DNS through NSHost on macOS.
    // Read the kernel's hostname, matching Electron's os.hostname() instead.
    var system = utsname()
    guard uname(&system) == 0 else { return fallback }
    let name = withUnsafeBytes(of: &system.nodename) { bytes in
      String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
    }.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return name.isEmpty ? fallback : name
  }
}
