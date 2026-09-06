import Foundation

/// Preserve the desktop's semantic AX compaction and textual command result.
/// Index assignment happens after compaction; helper element IDs stay opaque.
public enum AccessibilitySnapshot {
  private static let labels = [
    "name", "value", "description", "help", "placeholderValue", "visibleText", "text",
    "titleElementText",
  ]
  private static let wrappers = ["AXGroup", "AXUnknown"]
  private static let coveredRoles = [
    "AXButton", "AXGroup", "AXHeading", "AXImage", "AXLink", "AXStaticText", "AXUnknown",
  ]
  private static let primaryClickRoles = [
    "AXButton", "AXCheckBox", "AXDisclosureTriangle", "AXMenuBarItem", "AXMenuItem",
    "AXPopUpButton", "AXRadioButton",
  ]
  private static let menuRoles = ["AXMenu", "AXMenuBar", "AXMenuBarItem", "AXMenuItem"]
  private static let roles = [
    "AXButton": "button", "AXCheckBox": "checkbox", "AXComboBox": "combo box",
    "AXDisclosureTriangle": "disclosure triangle",
    "AXGroup": "container", "AXHeading": "heading", "AXImage": "image", "AXLink": "link",
    "AXList": "list",
    "AXMenu": "menu", "AXMenuBar": "menu bar", "AXMenuBarItem": "menu bar item",
    "AXMenuItem": "menu item",
    "AXOutline": "outline", "AXPopUpButton": "pop up button", "AXRadioButton": "radio button",
    "AXScrollArea": "scroll area",
    "AXSlider": "slider", "AXStaticText": "text", "AXTabGroup": "tab group", "AXTable": "table",
    "AXTextArea": "text entry area",
    "AXTextField": "text field", "AXToolbar": "toolbar", "AXUnknown": "container",
  ]
  private static let actionLabels = [
    "AXCancel": "Cancel", "AXConfirm": "Confirm", "AXDecrement": "Decrement", "AXDelete": "Delete",
    "AXIncrement": "Increment", "AXPick": "Pick", "AXRaise": "Raise", "AXShowMenu": "Show Menu",
  ]

  public static func transform(_ input: JSON) -> JSON {
    var count = 0
    var reasons: [String] = []
    func reason(_ value: String) { if !reasons.contains(value) { reasons.append(value) } }
    func normalize(_ node: JSON, depth: Int) -> [JSON] {
      if depth > 32 {
        reason("max_depth")
        return []
      }
      if depth > 0 && node["hidden"].bool && !node["focused"].bool && !node["selected"].bool {
        return []
      }
      let rawChildren: [JSON]
      if node["role"].string == "AXMenuBar" {
        rawChildren = node["children"].array.map { child in
          var fields = child.object ?? [:]
          fields.removeValue(forKey: "actions")
          fields.removeValue(forKey: "children")
          return .object(fields)
        }
      } else {
        rawChildren = node["children"].array.filter { !compact(parent: node, child: $0) }
      }
      if rawChildren.count > 120 { reason("max_children_per_node") }
      let elide = wrappers.contains(node["role"].string ?? "") && !meaningful(node)
      if !elide {
        if count >= 1200 {
          reason("max_nodes")
          return []
        }
        count += 1
      }
      var children: [JSON] = []
      for child in rawChildren.prefix(120) {
        if count >= 1200 {
          reason("max_nodes")
          break
        }
        children += normalize(child, depth: depth + 1)
      }
      if elide { return children }
      children = children.filter { !compact(parent: node, child: $0) }
      var fields = node.object ?? [:]
      fields.removeValue(forKey: "children")
      if !children.isEmpty { fields["children"] = .array(children) }
      return [.object(fields)]
    }
    var snapshot = input
    let normalized = input["elements"].array.flatMap { normalize($0, depth: 0) }
    var ids: [String] = []
    var focused: Int?
    func index(_ node: JSON) -> JSON {
      let position = ids.count
      let old = node["index"].number.map(Int.init)
      let originalIDs = input["elementIdsByIndex"].array
      let originalID = old.flatMap {
        originalIDs.indices.contains($0) ? originalIDs[$0].string : nil
      }
      ids.append(node["id"].string ?? originalID ?? "")
      if focused == nil && node["focused"].bool { focused = position }
      var node = node
      node["index"] = .number(Double(position))
      if !node["children"].array.isEmpty {
        node["children"] = .array(node["children"].array.map(index))
      }
      return node
    }
    snapshot["elements"] = .array(normalized.map(index))
    snapshot["elementIdsByIndex"] = .strings(ids)
    if let focused { snapshot["focusedElementIndex"] = .number(Double(focused)) }
    snapshot["nodeCount"] = .number(Double(count))
    var combined = input["truncationReasons"].array.compactMap(\.string)
    for entry in reasons where !combined.contains(entry) { combined.append(entry) }
    if input["truncated"].bool || !combined.isEmpty || input["nodeCount"].number != nil {
      snapshot["truncated"] = .bool(input["truncated"].bool || !combined.isEmpty)
    }
    if !combined.isEmpty { snapshot["truncationReasons"] = .strings(combined) }
    snapshot["appState"] = .string(render(snapshot))
    return snapshot
  }

  private static func display(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(
      of: "\\s+", with: " ", options: .regularExpression)
  }
  private static func coverage(_ value: String) -> String {
    display(value.replacingOccurrences(of: "[•·]", with: " ", options: .regularExpression))
      .lowercased()
  }
  private static func texts(_ node: JSON, coverageMode: Bool = false, identifiers: Bool = false)
    -> [String]
  {
    let keys = labels + (identifiers ? ["identifier", "url"] : [])
    return (keys.compactMap { node[$0].string } + node["columnTitles"].array.compactMap(\.string))
      .map { coverageMode ? coverage($0) : display($0) }.filter { !$0.isEmpty }
  }
  private static func subtreeTexts(_ node: JSON) -> [String] {
    texts(node, coverageMode: true) + node["children"].array.flatMap(subtreeTexts)
  }
  private static func secondary(_ node: JSON) -> Bool {
    node["actions"].array.compactMap(\.string).contains {
      !["AXShowMenu", "AXScrollToVisible", "AXPress"].contains($0)
        && !($0 == "AXPick" && node["clickableKind"].string == "pick")
    }
  }
  private static func independent(_ node: JSON, settable: Bool = true) -> Bool {
    ["focused", "selected", "expanded", "pickable", "selectable"].contains { node[$0].bool }
      || node["enabled"] == .bool(false) || (settable && node["valueSettable"].bool)
      || ["pick", "select"].contains(node["clickableKind"].string ?? "") || secondary(node)
  }
  private static func meaningful(_ node: JSON) -> Bool {
    !texts(node, identifiers: true).isEmpty || independent(node, settable: false)
      || node["pressable"].bool || node["clickableKind"].string == "press"
  }
  private static func presses(_ node: JSON) -> Bool {
    node["pressable"].bool || node["clickableKind"].string == "press"
      || node["actions"].array.contains(.string("AXPress"))
  }
  private static func independentSemantics(_ parent: JSON, _ child: JSON) -> Bool {
    guard let role = child["role"].string, coveredRoles.contains(role) else { return true }
    if independent(child) { return true }
    if ["AXLink", "AXButton"].contains(role), child["role"] != parent["role"] { return true }
    if role == "AXLink", parent["role"].string == "AXLink", child["url"].string != nil,
      parent["url"].string != nil, child["url"] != parent["url"]
    {
      return true
    }
    return child["children"].array.contains { independentSemantics(parent, $0) }
  }
  private static func compact(parent: JSON, child: JSON) -> Bool {
    let childTexts = Set(texts(child, identifiers: true))
    if child["role"].string == "AXStaticText", child["children"].array.isEmpty, childTexts.isEmpty,
      !independent(child)
    {
      return true
    }
    if ["AXImage", "AXStaticText"].contains(child["role"].string ?? ""),
      child["children"].array.isEmpty,
      !Set(texts(parent, identifiers: true)).intersection(childTexts).isEmpty,
      !independent(child, settable: false), !presses(child) || presses(parent)
    {
      return true
    }
    if ["AXButton", "AXHeading", "AXLink"].contains(parent["role"].string ?? ""),
      !independentSemantics(parent, child)
    {
      let childLabels = subtreeTexts(child)
      let parentLabels = texts(parent, coverageMode: true)
      return !childLabels.isEmpty
        && childLabels.allSatisfy { childText in
          parentLabels.contains { $0 == childText || $0.contains(childText) }
        }
    }
    return false
  }

  private static func formatted(_ value: String?, limit: Int = 180) -> String? {
    guard let value else { return nil }
    let text = display(value)
    guard !text.isEmpty else { return nil }
    return text.utf16.count <= limit ? text : String(text.prefix(limit - 3)) + "..."
  }
  private static func role(_ node: JSON) -> String {
    let raw = node["role"].string
    if raw == "AXWindow" {
      return node["subrole"].string == "AXDialog" ? "dialog" : "standard window"
    }
    if raw == "AXWebArea" {
      return formatted(node["roleDescription"].string, limit: 80) ?? "HTML content"
    }
    if let raw, let label = roles[raw] { return label }
    if let description = node["roleDescription"].string {
      return formatted(description, limit: 80) ?? "element"
    }
    guard let raw else { return "element" }
    return (raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw).replacingOccurrences(
      of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression
    ).lowercased()
  }
  private static func line(_ node: JSON, depth: Int) -> String {
    let primary = [
      "name", "value", "visibleText", "text", "titleElementText", "description", "placeholderValue",
      "identifier", "url",
    ].compactMap { formatted(node[$0].string, limit: $0 == "url" ? 240 : 180) }.first
    var annotations: [String] = []
    if node["valueSettable"].bool {
      annotations.append(node["valueType"].string.map { "settable, " + $0 } ?? "settable")
    }
    if node["enabled"] == .bool(false) { annotations.append("disabled") }
    if node["selected"].bool {
      annotations.append("selected")
    } else if node["selectable"].bool {
      annotations.append("selectable")
    }
    if node["expanded"].bool { annotations.append("expanded") }
    let roleName = node["role"].string ?? ""
    if node["pressable"].bool && node["clickableKind"].string == "press"
      && !primaryClickRoles.contains(roleName)
    {
      annotations.append("pressable")
    }
    if node["pickable"].bool && node["clickableKind"].string == "pick" {
      annotations.append("pickable")
    }
    if node["mouseClickable"].bool && node["clickableKind"].string == "mouse"
      && !node["selectable"].bool && !primaryClickRoles.contains(roleName)
      && roleName != "AXStaticText" && !wrappers.contains(roleName)
    {
      annotations.append("clickable")
    }
    var details: [String] = []
    let fields = [
      ("description", "Description"), ("value", "Value"), ("visibleText", "Visible Text"),
      ("text", "Text"), ("titleElementText", "Title Element"), ("placeholderValue", "Placeholder"),
      ("columnTitles", "Columns"), ("identifier", "Identifier"), ("url", "URL"), ("help", "Help"),
    ]
    for (key, label) in fields {
      let raw =
        key == "columnTitles"
        ? node[key].array.compactMap(\.string).joined(separator: ", ") : node[key].string
      if let text = formatted(raw, limit: key == "identifier" ? 120 : key == "url" ? 240 : 180),
        text != primary
      {
        details.append(label + ": " + text)
      }
    }
    let actions = node["actions"].array.compactMap(\.string).filter {
      if $0 == "AXPick" && node["clickableKind"].string == "pick" { return false }
      if menuRoles.contains(roleName) && ["AXCancel", "AXPick"].contains($0) { return false }
      return !["AXPress", "AXShowMenu", "AXScrollToVisible"].contains($0)
    }.map { actionLabels[$0] ?? ($0.hasPrefix("AX") ? String($0.dropFirst(2)) : $0) }
    if !actions.isEmpty { details.append("Secondary Actions: " + actions.joined(separator: ", ")) }
    var result =
      String(repeating: "\t", count: depth) + "\(Int(node["index"].number ?? 0)) " + role(node)
    if !annotations.isEmpty { result += " (" + annotations.joined(separator: ", ") + ")" }
    if let primary { result += " " + primary }
    if !details.isEmpty {
      result += (primary == nil ? " " : ", ") + details.joined(separator: ", ")
    }
    return result
  }
  private static func render(_ snapshot: JSON) -> String {
    let app = snapshot["appDisplayName"].string ?? snapshot["app"].string ?? ""
    let identity = snapshot["appPath"].string ?? app
    var details: [String] = []
    if let bundle = snapshot["bundleId"].string { details.append("bundleID " + bundle) }
    if let pid = snapshot["pid"].number { details.append("pid \(Int(pid))") }
    var lines = [
      "Computer Use state", "<app_state>",
      "App=" + identity + (details.isEmpty ? "" : " (" + details.joined(separator: ", ") + ")"),
    ]
    if let title = formatted(snapshot["windowTitle"].string)
      ?? formatted(snapshot["elements"].array.first?["name"].string)
    {
      lines.append("Window: \"\(title)\", App: \(app).")
    }
    if snapshot["windowOnCurrentSpace"] == .bool(false) {
      let current = snapshot["currentSpaceId"].number.map { String(Int($0)) } ?? "unknown"
      let spaces = snapshot["windowSpaceIds"].array.compactMap(\.number).map { String(Int($0)) }
      lines.append(
        "Window is on another macOS Space (current Space \(current), window Spaces \(spaces.isEmpty ? "unknown" : spaces.joined(separator: ", "))). Screenshot capture can still work, but macOS may expose only a reduced Accessibility tree until the window is moved to the current Space."
      )
    }
    var focus: String?
    func visit(_ node: JSON, depth: Int) {
      lines.append(line(node, depth: depth))
      if node["index"] == snapshot["focusedElementIndex"] { focus = line(node, depth: 0) }
      for child in node["children"].array { visit(child, depth: depth + 1) }
    }
    for node in snapshot["elements"].array { visit(node, depth: 0) }
    if let index = snapshot["focusedElementIndex"].number {
      lines += ["", "The focused UI element is \(focus ?? String(Int(index)))."]
    }
    lines.append("</app_state>")
    return lines.joined(separator: "\n")
  }
}
