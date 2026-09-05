import Foundation

/// Both grants are required fields emitted by the bundled helper. An invalid
/// reply is a protocol failure, rather than evidence that the user denied TCC.
public struct DesktopPermissionState: Decodable, Sendable {
  public let accessibility: Bool
  public let screenRecording: Bool

  public static func validated(_ value: JSON) throws -> JSON {
    _ = try JSONDecoder().decode(Self.self, from: value.encoded())
    return value
  }
}
