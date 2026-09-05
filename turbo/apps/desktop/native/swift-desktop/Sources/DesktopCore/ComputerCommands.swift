import Foundation

@MainActor
public final class ComputerCommands {
  public static let capabilities = [
    "apps.list", "app.state", "app.open", "element.click", "element.scroll", "element.set_value",
    "element.perform_action", "keyboard.type_text", "keyboard.press_key",
  ]
  private let helper: HelperProcess
  private var snapshots: [String: JSON] = [:]
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
        helperGeneration = helper.generation
      }
      if kind == "apps.list" { return .success(try await helper.request(kind)) }
      guard permissions["screenRecording"].bool else {
        throw DesktopFailure(
          "permission_denied", "Grant Screen Recording permission in System Settings")
      }
      var payload = command["payload"]
      let app = try payload.requireString("app")
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
          if payload["snapshotId"].string == nil && snapshots[app.lowercased()] == nil {
            _ = try await appState(app)
          }
          let snapshot = try snapshot(app: app, id: payload["snapshotId"].string)
          for key in [
            "snapshotId", "screenshotSource", "screenshotWidth", "screenshotHeight", "windowId",
            "windowFrame",
          ] { payload[key] = snapshot[key] }
          payload["sourceBounds"] = snapshot["screenshotSourceBounds"]
        }
      }
      if ["element.click", "keyboard.type_text", "keyboard.press_key"].contains(kind),
        payload["foregroundRecovery"].string == nil
      {
        payload["foregroundRecovery"] = .string("on-window-unavailable")
      }
      if kind == "element.click" {
        if payload["button"].string == nil { payload["button"] = .string("left") }
        if payload["clickCount"].number == nil { payload["clickCount"] = .number(1) }
        if payload["elementId"].string != nil, payload["button"].string != "left" {
          throw DesktopFailure(
            "unsupported_command",
            "Element targets support only left clicks; use coordinates for other buttons")
        }
      }
      let action = try await helper.request(kind, fields: payload)
      var result = try await appState(app, settle: true)
      result["action"] = action
      return .success(result)
    } catch let failure as DesktopFailure { return failure.response } catch {
      return DesktopFailure("accessibility_unavailable", error.localizedDescription).response
    }
  }

  private func snapshot(app: String, id: String?) throws -> JSON {
    guard let snapshot = snapshots[app.lowercased()],
      id == nil || snapshot["snapshotId"].string == id
    else {
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
    var ids: [String] = []
    var lines: [String] = []
    var reasons = snapshot["truncationReasons"].array.compactMap(\.string)
    var focused: Int?
    func visit(_ node: JSON, depth: Int) {
      if depth > 32 {
        reasons.append("max_depth")
        return
      }
      if ids.count >= 1200 {
        reasons.append("max_nodes")
        return
      }
      if depth > 0, node["hidden"].bool, !node["focused"].bool, !node["selected"].bool { return }
      let index = ids.count
      ids.append(node["id"].string ?? "")
      if focused == nil && node["focused"].bool { focused = index }
      let role = node["roleDescription"].string ?? node["role"].string ?? "element"
      let labels = [
        "name", "value", "description", "visibleText", "placeholderValue", "titleElementText",
      ].compactMap { node[$0].string }.filter { !$0.isEmpty }
      let text = Array(NSOrderedSet(array: labels)).compactMap { $0 as? String }.joined(
        separator: " | ")
      let states = [
        "focused", "selected", "expanded", "valueSettable", "pressable", "pickable", "selectable",
      ].filter { node[$0].bool }
      let actions = node["actions"].array.compactMap(\.string)
      let suffix = (states + actions).joined(separator: ", ")
      lines.append(
        String(repeating: "  ", count: depth) + "[\(index)] \(role) \(String(text.prefix(1000)))"
          + (suffix.isEmpty ? "" : " (\(suffix))"))
      let children = node["children"].array
      if children.count > 120 { reasons.append("max_children_per_node") }
      for child in children.prefix(120) { visit(child, depth: depth + 1) }
    }
    for element in snapshot["elements"].array { visit(element, depth: 0) }
    snapshot["elementIdsByIndex"] = .strings(ids)
    if let focused { snapshot["focusedElementIndex"] = .number(Double(focused)) }
    snapshot["nodeCount"] = .number(Double(ids.count))
    snapshot["truncated"] = .bool(snapshot["truncated"].bool || !reasons.isEmpty)
    snapshot["truncationReasons"] = .strings(Array(Set(reasons)).sorted())
    var heading = "Computer Use state\n<app_state>\nApp=\(snapshot["appPath"].string ?? app)"
    if let title = snapshot["windowTitle"].string { heading += "\nWindow: \(title)" }
    snapshot["appState"] = .string(
      heading + "\n" + lines.joined(separator: "\n") + "\n</app_state>")
    snapshot["metrics"] = .object([
      "helperDurationMs": .number(Date().timeIntervalSince(start) * 1000), "settle": .bool(settle),
      "nodeCount": .number(Double(ids.count)),
    ])
    var fields = snapshot.object!
    fields.removeValue(forKey: "elements")
    snapshot = .object(fields)
    snapshots[app.lowercased()] = snapshot
    helperGeneration = helper.generation
    return snapshot
  }
}
