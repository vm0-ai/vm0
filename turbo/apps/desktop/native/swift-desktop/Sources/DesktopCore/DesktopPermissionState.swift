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

  public static var defaultAutomation: JSON {
    let untested: JSON = .object([
      "status": .string("unknown"), "updatedAt": .null, "reason": .null,
    ])
    return .object(["chrome": untested, "safari": untested])
  }

  private struct AutomationResult: Decodable {
    enum Status: String, Decodable {
      case unknown, granted, denied
      case notInstalled = "not_installed"
      case notRunning = "not_running"
    }
    let status: Status
    let reason: String?
  }

  public static func automationObservation(_ value: JSON) throws -> JSON {
    let result = try JSONDecoder().decode(AutomationResult.self, from: value.encoded())
    return .object([
      "status": .string(result.status.rawValue),
      "reason": result.reason.map(JSON.string) ?? .null,
      "updatedAt": .string(ISO8601DateFormatter().string(from: Date())),
    ])
  }

  public static func automationTarget(app: String?) -> String? {
    switch app?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "com.apple.safari", "safari": return "safari"
    case "com.google.chrome", "google chrome", "chrome": return "chrome"
    default: return nil
    }
  }
}
