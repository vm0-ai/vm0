import Foundation

@MainActor
public final class ComputerCommands {
  public static let capabilities = [
    "apps.list", "app.state", "app.open", "element.click", "element.scroll", "element.set_value",
    "element.perform_action", "keyboard.type_text", "keyboard.press_key",
  ]
  private let helper: HelperProcess
  private var snapshots: [String: JSON] = [:]
  private var latestByApp: [String: String] = [:]
  private var snapshotOrder: [String] = []
  private var helperGeneration = 0

  public init(helper: HelperProcess) { self.helper = helper }

  public func execute(_ command: JSON, permissions: JSON) async -> JSON {
    do {
      guard permissions["accessibility"].bool else {
        throw DesktopFailure(
          "permission_denied", "Grant Accessibility permission in System Settings")
      }
      let kind = try command.requireString("kind")
      guard Self.capabilities.contains(kind) else {
        throw DesktopFailure("unsupported_command", "Unsupported Computer Use command: \(kind)")
      }
      if helper.generation != helperGeneration {
        snapshots.removeAll()
        latestByApp.removeAll()
        snapshotOrder.removeAll()
        helperGeneration = helper.generation
      }
      if kind == "apps.list" { return .success(try await helper.request(kind)) }
      guard permissions["screenRecording"].bool else {
        throw DesktopFailure(
          "screen_recording_unavailable", "macOS Screen Recording permission is required")
      }
      var payload = command["payload"]
      for key in [
        "app", "elementId", "snapshotId", "foregroundRecovery", "text", "key", "value", "action",
        "direction",
      ] {
        if let raw = payload[key].string {
          payload[key] = .string(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        }
      }
      let app = try payload.requireString("app")
      if payload["elementIndex"] != .null {
        guard let index = payload["elementIndex"].number, index >= 0, index.rounded() == index
        else {
          throw DesktopFailure("unsupported_command", "elementIndex must be a non-negative integer")
        }
      }
      let requiredFields = [
        "keyboard.type_text": "text", "keyboard.press_key": "key", "element.set_value": "value",
        "element.perform_action": "action", "element.scroll": "direction",
      ]
      if let field = requiredFields[kind] { _ = try payload.requireString(field) }
      if kind == "element.scroll", payload["pages"].number == nil { payload["pages"] = .number(1) }
      if kind == "app.state" { return .success(try await appState(app)) }
      if kind == "element.click" || kind == "element.scroll" || kind == "element.set_value"
        || kind == "element.perform_action"
      {
        if payload["elementId"].string == nil && payload["elementIndex"].number != nil {
          let snapshot = try snapshot(app: app, id: payload["snapshotId"].string)
          guard let number = payload["elementIndex"].number, number >= 0,
            number.rounded() == number,
            number < Double(snapshot["elementIdsByIndex"].array.count)
          else {
            throw DesktopFailure(
              "unsupported_command", "Element index is not in the selected snapshot")
          }
          payload["elementId"] = snapshot["elementIdsByIndex"].array[Int(number)]
          payload["snapshotId"] = snapshot["snapshotId"]
        }
        if kind == "element.click", payload["elementId"].string == nil {
          guard let x = payload["x"].number, let y = payload["y"].number, x.isFinite, y.isFinite
          else {
            throw DesktopFailure(
              "invalid_arguments", "element.click requires an element or coordinates")
          }
          if payload["snapshotId"].string == nil && latestByApp[app.lowercased()] == nil {
            _ = try await appState(app)
          }
          let snapshot = try snapshot(app: app, id: payload["snapshotId"].string)
          for key in [
            "snapshotId", "screenshotSource", "screenshotWidth", "screenshotHeight", "windowId",
            "windowFrame",
          ] { payload[key] = snapshot[key] }
          payload["sourceBounds"] = snapshot["screenshotSourceBounds"]
        }
        if kind != "element.click", payload["elementId"].string == nil {
          throw DesktopFailure("unsupported_command", "\(kind) requires elementId or elementIndex")
        }
      }
      if ["element.click", "keyboard.type_text", "keyboard.press_key"].contains(kind),
        payload["foregroundRecovery"].string == nil
      {
        payload["foregroundRecovery"] = .string("on-window-unavailable")
      }
      if kind == "element.click" {
        if !["right", "middle"].contains(payload["button"].string ?? "") {
          payload["button"] = .string("left")
        }
        if let count = payload["clickCount"].number, count.rounded() == count,
          (1...3).contains(count)
        {
        } else {
          payload["clickCount"] = .number(1)
        }
        if payload["elementId"].string != nil, payload["button"].string != "left" {
          throw DesktopFailure(
            "unsupported_command",
            "Element targets support only left clicks; use coordinates for other buttons")
        }
      }
      if let recovery = payload["foregroundRecovery"].string,
        !["never", "on-window-unavailable", "always"].contains(recovery)
      {
        throw DesktopFailure(
          "unsupported_command",
          "foregroundRecovery must be never, on-window-unavailable, or always")
      }
      var action = try await helper.request(kind, fields: payload)
      action["app"] = .string(app)
      if payload["elementIndex"].number != nil {
        action["elementIndex"] = payload["elementIndex"]
        action["snapshotId"] = payload["snapshotId"]
      } else if payload["elementId"].string != nil {
        action["elementId"] = payload["elementId"]
      }
      let targetText =
        payload["elementIndex"].number.map { "elementIndex=\(Int($0))" } ?? payload["elementId"]
        .string ?? "element"
      switch kind {
      case "app.open": action["summary"] = .string("Opened \(app)")
      case "keyboard.type_text": action["summary"] = .string("Typed text")
      case "keyboard.press_key":
        action["key"] = action["normalizedKey"]
        action["summary"] = .string("Pressed \(action["key"].string ?? "")")
      case "element.click":
        action["button"] = payload["button"]
        action["clickCount"] = payload["clickCount"]
        if let x = payload["x"].number, let y = payload["y"].number,
          payload["elementId"].string == nil
        {
          action["x"] = .number(x)
          action["y"] = .number(y)
          action["snapshotId"] = payload["snapshotId"]
          action["summary"] = .string("Clicked \(x),\(y)")
        } else {
          action["summary"] = .string("Clicked " + targetText)
        }
      case "element.scroll":
        action["direction"] = payload["direction"]
        action["pages"] = payload["pages"]
        action["summary"] = .string("Scrolled " + targetText)
      case "element.set_value": action["summary"] = .string("Set " + targetText)
      case "element.perform_action":
        action["action"] = payload["action"]
        action["summary"] = .string("Performed " + (payload["action"].string ?? ""))
      default: break
      }
      var result = try await appState(app, settle: true)
      result["action"] = action
      return .success(result)
    } catch let failure as DesktopFailure { return failure.response } catch {
      return DesktopFailure("accessibility_unavailable", error.localizedDescription).response
    }
  }

  private func snapshot(app: String, id: String?) throws -> JSON {
    let appKey = app.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let key = id.map { appKey + "\0" + $0 } ?? latestByApp[appKey]
    guard let key, let snapshot = snapshots[key] else {
      throw DesktopFailure(
        "unsupported_command", "Snapshot not found for \(app); request app.state again")
    }
    return snapshot
  }

  private func appState(_ app: String, settle: Bool = false) async throws -> JSON {
    let start = Date()
    var snapshot = try await helper.request(
      "app.state",
      fields: .object([
        "app": .string(app), "snapshotId": .string(UUID().uuidString), "settle": .bool(settle),
      ]))
    guard snapshot["screenshotSource"].string == "window",
      snapshot["screenshot"].string?.isEmpty == false,
      (snapshot["screenshotWidth"].number ?? 0) > 0, (snapshot["screenshotHeight"].number ?? 0) > 0,
      snapshot["screenshotSourceBounds"].object != nil
    else {
      throw DesktopFailure(
        "screen_recording_unavailable",
        "app.state must return a target-window screenshot with bounds")
    }
    func nodeCount(_ elements: [JSON]) -> Int {
      elements.reduce(0) { $0 + 1 + nodeCount($1["children"].array) }
    }
    let rawCount = nodeCount(snapshot["elements"].array)
    snapshot = AccessibilitySnapshot.transform(snapshot)
    snapshot["metrics"] = .object([
      "helperDurationMs": .number(Date().timeIntervalSince(start) * 1000), "settle": .bool(settle),
      "rawNodeCount": .number(Double(rawCount)),
      "nodeCount": .number(Double(nodeCount(snapshot["elements"].array))),
      "appStateChars": .number(Double(snapshot["appState"].string?.utf16.count ?? 0)),
    ])
    var fields = snapshot.object!
    fields.removeValue(forKey: "elements")
    snapshot = .object(fields)
    let appKey = app.lowercased()
    let key = appKey + "\0" + (snapshot["snapshotId"].string ?? "")
    var metadata = fields
    for field in ["screenshot", "appState", "metrics"] { metadata.removeValue(forKey: field) }
    snapshots[key] = .object(metadata)
    snapshotOrder.removeAll { $0 == key }
    snapshotOrder.append(key)
    latestByApp[appKey] = key
    while snapshotOrder.count > 50 {
      let oldest = snapshotOrder.removeFirst()
      snapshots.removeValue(forKey: oldest)
      latestByApp = latestByApp.filter { $0.value != oldest }
    }
    helperGeneration = helper.generation
    return snapshot
  }
}
