import Foundation

public struct AccessibilitySnapshotOutputLimits: Sendable {
    public var maxDepth: Int
    public var maxNodes: Int
    public var maxChildrenPerNode: Int

    public init(maxDepth: Int, maxNodes: Int, maxChildrenPerNode: Int) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
        self.maxChildrenPerNode = maxChildrenPerNode
    }

    /// Tighter than the helper's capture limits so the rendered tree stays readable.
    public static let output = AccessibilitySnapshotOutputLimits(maxDepth: 32, maxNodes: 1_200, maxChildrenPerNode: 120)
}

/// Port of the JavaScript accessibility shaping: generic wrapper elision,
/// hidden pruning, redundant label removal, parent-text coverage, menu bar
/// flattening, stable indexing and the textual `appState` rendering.
public enum AccessibilityShaping {
    static let genericWrapperRoles: Set<String> = ["AXGroup", "AXUnknown"]
    static let redundantLabelChildRoles: Set<String> = ["AXImage", "AXStaticText"]
    static let parentTextCoveredRoles: Set<String> = [
        "AXButton", "AXGroup", "AXHeading", "AXImage", "AXLink", "AXStaticText", "AXUnknown",
    ]
    static let textCoveringParentRoles: Set<String> = ["AXButton", "AXHeading", "AXLink"]

    // MARK: Text helpers

    static func stringHasValue(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// `value.trim().replaceAll(/\s+/g, " ")`.
    static func normalizeDisplayText(_ value: String) -> String {
        value.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    }

    static func normalizeCoverageText(_ value: String) -> String {
        let withoutBullets = normalizeDisplayText(value).replacingOccurrences(of: "•", with: " ")
            .replacingOccurrences(of: "·", with: " ")
        return normalizeDisplayText(withoutBullets).lowercased()
    }

    static func stringArrayHasValue(_ value: [String]?) -> Bool {
        value?.contains(where: { !normalizeDisplayText($0).isEmpty }) ?? false
    }

    // MARK: Element predicates

    static func hasMeaningfulSecondaryAction(_ element: AccessibilityElement) -> Bool {
        (element.actions ?? []).contains { action in
            action != "AXShowMenu" && action != "AXScrollToVisible" && action != "AXPress"
                && !(action == "AXPick" && element.clickableKind == "pick")
        }
    }

    static func elementHasMeaningfulContent(_ element: AccessibilityElement) -> Bool {
        stringHasValue(element.name) || stringHasValue(element.value) || stringHasValue(element.description)
            || stringHasValue(element.help) || stringHasValue(element.placeholderValue)
            || stringHasValue(element.visibleText) || stringHasValue(element.text)
            || stringHasValue(element.titleElementText) || stringArrayHasValue(element.columnTitles)
            || stringHasValue(element.identifier) || stringHasValue(element.url)
            || element.focused == true || element.enabled == false || element.selected == true
            || element.expanded == true || element.pressable == true || element.pickable == true
            || element.selectable == true || element.clickableKind == "press" || element.clickableKind == "pick"
            || element.clickableKind == "select" || hasMeaningfulSecondaryAction(element)
    }

    static func shouldElideElement(_ element: AccessibilityElement) -> Bool {
        guard let role = element.role, genericWrapperRoles.contains(role) else { return false }
        return !elementHasMeaningfulContent(element)
    }

    static func elementHasDefaultPress(_ element: AccessibilityElement) -> Bool {
        element.pressable == true || element.clickableKind == "press" || (element.actions ?? []).contains("AXPress")
    }

    static func elementHasIndependentStateOrAction(_ element: AccessibilityElement) -> Bool {
        element.focused == true || element.selected == true || element.enabled == false || element.expanded == true
            || element.valueSettable == true || element.pickable == true || element.selectable == true
            || element.clickableKind == "pick" || element.clickableKind == "select"
            || hasMeaningfulSecondaryAction(element)
    }

    static func labelSourceValues(_ element: AccessibilityElement) -> [String] {
        var values: [String?] = [
            element.name, element.value, element.description, element.help, element.placeholderValue,
            element.visibleText, element.text, element.titleElementText,
        ]
        values.append(contentsOf: (element.columnTitles ?? []).map { Optional($0) })
        return values.compactMap { $0 }
    }

    static func normalizedElementLabelValues(_ element: AccessibilityElement) -> [String] {
        labelSourceValues(element).map(normalizeCoverageText).filter { !$0.isEmpty }
    }

    static func normalizedElementTextValues(_ element: AccessibilityElement) -> Set<String> {
        var sources = labelSourceValues(element)
        if let identifier = element.identifier { sources.append(identifier) }
        if let url = element.url { sources.append(url) }
        return Set(sources.map(normalizeDisplayText).filter { !$0.isEmpty })
    }

    static func normalizedSubtreeLabelValues(_ element: AccessibilityElement) -> [String] {
        var values = normalizedElementLabelValues(element)
        for child in element.children {
            values.append(contentsOf: normalizedSubtreeLabelValues(child))
        }
        return values
    }

    static func textValuesCover(parentTexts: [String], childTexts: [String]) -> Bool {
        let meaningful = childTexts.filter { !$0.isEmpty }
        return !meaningful.isEmpty
            && meaningful.allSatisfy { childText in
                parentTexts.contains { $0 == childText || $0.contains(childText) }
            }
    }

    static func childHasIndependentSemantics(parent: AccessibilityElement, child: AccessibilityElement) -> Bool {
        guard let childRole = child.role, parentTextCoveredRoles.contains(childRole) else { return true }
        if elementHasIndependentStateOrAction(child) { return true }
        if (childRole == "AXLink" || childRole == "AXButton") && childRole != parent.role { return true }
        if childRole == "AXLink", parent.role == "AXLink", let childUrl = child.url, let parentUrl = parent.url,
            childUrl != parentUrl
        {
            return true
        }
        return child.children.contains { childHasIndependentSemantics(parent: parent, child: $0) }
    }

    static func childIsCoveredByParentText(parent: AccessibilityElement, child: AccessibilityElement) -> Bool {
        guard let parentRole = parent.role, textCoveringParentRoles.contains(parentRole) else { return false }
        if childHasIndependentSemantics(parent: parent, child: child) { return false }
        return textValuesCover(
            parentTexts: normalizedElementLabelValues(parent),
            childTexts: normalizedSubtreeLabelValues(child)
        )
    }

    static func childIsRedundantLabel(parent: AccessibilityElement, child: AccessibilityElement) -> Bool {
        if child.role == "AXStaticText", child.children.isEmpty, normalizedElementTextValues(child).isEmpty,
            !elementHasIndependentStateOrAction(child)
        {
            return true
        }
        guard let childRole = child.role, redundantLabelChildRoles.contains(childRole) else { return false }
        if !child.children.isEmpty { return false }
        let parentTexts = normalizedElementTextValues(parent)
        if parentTexts.isEmpty { return false }
        let duplicatesParentText = normalizedElementTextValues(child).contains { parentTexts.contains($0) }
        if !duplicatesParentText { return false }
        if child.focused == true || child.selected == true || child.enabled == false || child.expanded == true
            || child.pickable == true || child.selectable == true || child.clickableKind == "pick"
            || child.clickableKind == "select" || hasMeaningfulSecondaryAction(child)
        {
            return false
        }
        if elementHasDefaultPress(child), !elementHasDefaultPress(parent) { return false }
        return true
    }

    static func shouldCompactChild(parent: AccessibilityElement, child: AccessibilityElement) -> Bool {
        childIsRedundantLabel(parent: parent, child: child) || childIsCoveredByParentText(parent: parent, child: child)
    }

    static func shallowMenuBarChild(_ element: AccessibilityElement) -> AccessibilityElement {
        var raw = element.raw
        raw.removeValue(forKey: "actions")
        return AccessibilityElement(raw: raw, children: [], index: element.index)
    }

    static func compactRawChildren(_ element: AccessibilityElement) -> [AccessibilityElement] {
        if element.role == "AXMenuBar" {
            return element.children.map(shallowMenuBarChild)
        }
        return element.children.filter { !shouldCompactChild(parent: element, child: $0) }
    }

    // MARK: Normalization

    public static func normalize(
        _ snapshot: AccessibilityAppStateSnapshot,
        limits: AccessibilitySnapshotOutputLimits = .output
    ) -> AccessibilityAppStateSnapshot {
        var nodeCount = 0
        var truncationReasons: [String] = []

        func pushReason(_ reason: String) {
            if !truncationReasons.contains(reason) {
                truncationReasons.append(reason)
            }
        }

        func normalizeElement(_ element: AccessibilityElement, depth: Int) -> [AccessibilityElement] {
            if depth > limits.maxDepth {
                pushReason("max_depth")
                return []
            }
            if depth > 0, element.hidden == true, element.focused != true, element.selected != true {
                return []
            }

            let semanticChildren = compactRawChildren(element)
            let childEntries = Array(semanticChildren.prefix(limits.maxChildrenPerNode))
            if semanticChildren.count > childEntries.count {
                pushReason("max_children_per_node")
            }

            let elide = shouldElideElement(element)
            if !elide {
                if nodeCount >= limits.maxNodes {
                    pushReason("max_nodes")
                    return []
                }
                nodeCount += 1
            }

            var children: [AccessibilityElement] = []
            for child in childEntries {
                if nodeCount >= limits.maxNodes {
                    pushReason("max_nodes")
                    break
                }
                children.append(contentsOf: normalizeElement(child, depth: depth + 1))
            }

            if elide {
                return children
            }

            let compacted = children.filter { !shouldCompactChild(parent: element, child: $0) }
            return [AccessibilityElement(raw: element.raw, children: compacted, index: element.index)]
        }

        let elements = snapshot.elements.flatMap { normalizeElement($0, depth: 0) }
        let combinedReasons = (snapshot.truncationReasons ?? []) + truncationReasons

        var normalized = AccessibilityAppStateSnapshot(raw: snapshot.raw, elements: elements)
        normalized.nodeCount = nodeCount
        if snapshot.truncated == true || !combinedReasons.isEmpty || snapshot.nodeCount != nil {
            normalized.truncated = snapshot.truncated == true || !combinedReasons.isEmpty
        } else {
            normalized.truncated = nil
        }
        if !combinedReasons.isEmpty {
            var unique: [String] = []
            for reason in combinedReasons where !unique.contains(reason) {
                unique.append(reason)
            }
            normalized.truncationReasons = unique
        }
        return normalized
    }

    // MARK: Indexing

    public struct Indexed: Equatable, Sendable {
        public var snapshot: AccessibilityAppStateSnapshot
        public var elementIdsByIndex: [String]
        public var focusedElementIndex: Int?
    }

    /// Assigns pre-order indices over the normalized tree; these are the
    /// indices the agent addresses, so they must be computed after shaping.
    public static func index(_ snapshot: AccessibilityAppStateSnapshot) -> Indexed {
        var nextIndex = 0
        var elementIdsByIndex: [String] = []
        var focusedElementIndex: Int? = nil
        let sourceIds = snapshot.elementIdsByIndex

        func indexElement(_ element: AccessibilityElement) -> AccessibilityElement {
            let index = nextIndex
            nextIndex += 1
            var elementId = element.id
            if elementId == nil, let sourceIndex = element.index, let sourceIds, sourceIndex >= 0,
                sourceIndex < sourceIds.count
            {
                elementId = sourceIds[sourceIndex]
            }
            elementIdsByIndex.append(elementId ?? "")
            if focusedElementIndex == nil, element.focused == true {
                focusedElementIndex = index
            }
            let children = element.children.map(indexElement)
            var raw = element.raw
            raw["index"] = .number(Double(index))
            return AccessibilityElement(raw: raw, children: children, index: index)
        }

        let elements = snapshot.elements.map(indexElement)
        var indexed = AccessibilityAppStateSnapshot(raw: snapshot.raw, elements: elements)
        indexed.elementIdsByIndex = elementIdsByIndex
        if let focusedElementIndex {
            indexed.focusedElementIndex = focusedElementIndex
        }
        return Indexed(snapshot: indexed, elementIdsByIndex: elementIdsByIndex, focusedElementIndex: focusedElementIndex)
    }

    // MARK: Rendering

    static let roleLabels: [String: String] = [
        "AXButton": "button", "AXCheckBox": "checkbox", "AXComboBox": "combo box",
        "AXDisclosureTriangle": "disclosure triangle", "AXGroup": "container", "AXHeading": "heading",
        "AXImage": "image", "AXLink": "link", "AXList": "list", "AXMenu": "menu", "AXMenuBar": "menu bar",
        "AXMenuBarItem": "menu bar item", "AXMenuItem": "menu item", "AXOutline": "outline",
        "AXPopUpButton": "pop up button", "AXRadioButton": "radio button", "AXScrollArea": "scroll area",
        "AXSlider": "slider", "AXStaticText": "text", "AXTabGroup": "tab group", "AXTable": "table",
        "AXTextArea": "text entry area", "AXTextField": "text field", "AXToolbar": "toolbar",
        "AXUnknown": "container",
    ]
    static let defaultActionNames: Set<String> = ["AXPress"]
    static let genericWebActionNames: Set<String> = ["AXShowMenu", "AXScrollToVisible"]
    static let menuActionNoiseNames: Set<String> = ["AXCancel", "AXPick"]
    static let menuRoleNames: Set<String> = ["AXMenu", "AXMenuBar", "AXMenuBarItem", "AXMenuItem"]
    static let primaryClickRoleNames: Set<String> = [
        "AXButton", "AXCheckBox", "AXDisclosureTriangle", "AXMenuBarItem", "AXMenuItem", "AXPopUpButton",
        "AXRadioButton",
    ]
    static let actionLabels: [String: String] = [
        "AXCancel": "Cancel", "AXConfirm": "Confirm", "AXDecrement": "Decrement", "AXDelete": "Delete",
        "AXIncrement": "Increment", "AXPick": "Pick", "AXRaise": "Raise", "AXShowMenu": "Show Menu",
    ]

    static func normalizeText(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = normalizeDisplayText(value)
        return normalized.isEmpty ? nil : normalized
    }

    static func truncateText(_ value: String, maxLength: Int = 180) -> String {
        value.count <= maxLength ? value : String(value.prefix(maxLength - 3)) + "..."
    }

    static func formatText(_ value: String?, maxLength: Int = 180) -> String? {
        guard let normalized = normalizeText(value) else { return nil }
        return truncateText(normalized, maxLength: maxLength)
    }

    static func labelFromAxRole(_ role: String) -> String {
        let withoutPrefix = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
        var output = ""
        var previous: Character? = nil
        for character in withoutPrefix {
            if let previous, (previous.isLowercase || previous.isNumber), character.isUppercase {
                output.append(" ")
            }
            output.append(character)
            previous = character
        }
        return output.lowercased()
    }

    static func elementRoleLabel(_ element: AccessibilityElement) -> String {
        if element.role == "AXWindow" {
            return element.subrole == "AXDialog" ? "dialog" : "standard window"
        }
        if element.role == "AXWebArea" {
            return formatText(element.roleDescription, maxLength: 80) ?? "HTML content"
        }
        if let role = element.role, let label = roleLabels[role] {
            return label
        }
        if element.roleDescription != nil {
            return formatText(element.roleDescription, maxLength: 80) ?? "element"
        }
        return element.role.map(labelFromAxRole) ?? "element"
    }

    static func elementAnnotations(_ element: AccessibilityElement) -> [String] {
        var annotations: [String] = []
        if element.valueSettable == true {
            annotations.append(element.valueType.map { "settable, \($0)" } ?? "settable")
        }
        if element.enabled == false { annotations.append("disabled") }
        if element.selected == true {
            annotations.append("selected")
        } else if element.selectable == true {
            annotations.append("selectable")
        }
        if element.expanded == true { annotations.append("expanded") }
        let role = element.role
        if element.pressable == true, element.clickableKind == "press",
            role == nil || !primaryClickRoleNames.contains(role!)
        {
            annotations.append("pressable")
        }
        if element.pickable == true, element.clickableKind == "pick" { annotations.append("pickable") }
        if element.mouseClickable == true, element.clickableKind == "mouse", element.selectable != true,
            role == nil || !primaryClickRoleNames.contains(role!), role != "AXStaticText",
            role == nil || !genericWrapperRoles.contains(role!)
        {
            annotations.append("clickable")
        }
        return annotations
    }

    static func elementPrimaryText(_ element: AccessibilityElement) -> String? {
        let candidates: [(String?, Int)] = [
            (element.name, 180), (element.value, 180), (element.visibleText, 180), (element.text, 180),
            (element.titleElementText, 180), (element.description, 180), (element.placeholderValue, 180),
            (element.identifier, 180), (element.url, 240),
        ]
        for (candidate, maxLength) in candidates {
            if let text = formatText(candidate, maxLength: maxLength) {
                return text
            }
        }
        return nil
    }

    static func actionLabel(_ action: String) -> String {
        actionLabels[action] ?? (action.hasPrefix("AX") ? String(action.dropFirst(2)) : action)
    }

    static func secondaryActions(_ element: AccessibilityElement) -> [String] {
        (element.actions ?? []).filter { action in
            if action == "AXPick", element.clickableKind == "pick" { return false }
            if let role = element.role, menuRoleNames.contains(role), menuActionNoiseNames.contains(action) {
                return false
            }
            return !defaultActionNames.contains(action) && !genericWebActionNames.contains(action)
        }.map(actionLabel)
    }

    static func elementDetails(_ element: AccessibilityElement, primary: String?) -> [String] {
        var details: [String] = []
        func add(_ label: String, _ value: String?) {
            if let value, value != primary {
                details.append("\(label): \(value)")
            }
        }
        add("Description", formatText(element.description))
        add("Value", formatText(element.value))
        add("Visible Text", formatText(element.visibleText))
        add("Text", formatText(element.text))
        add("Title Element", formatText(element.titleElementText))
        add("Placeholder", formatText(element.placeholderValue))
        add("Columns", formatText(element.columnTitles?.joined(separator: ", ")))
        add("Identifier", formatText(element.identifier, maxLength: 120))
        add("URL", formatText(element.url, maxLength: 240))
        add("Help", formatText(element.help))
        let actions = secondaryActions(element)
        if !actions.isEmpty {
            details.append("Secondary Actions: \(actions.joined(separator: ", "))")
        }
        return details
    }

    static func formatElementLine(_ element: AccessibilityElement, depth: Int) -> String {
        let primary = elementPrimaryText(element)
        let annotations = elementAnnotations(element)
        let details = elementDetails(element, primary: primary)
        var line = String(repeating: "\t", count: depth) + "\(element.index ?? 0) \(elementRoleLabel(element))"
        if !annotations.isEmpty {
            line += " (\(annotations.joined(separator: ", ")))"
        }
        if let primary {
            line += " \(primary)"
        }
        if !details.isEmpty {
            line += (primary != nil ? ", " : " ") + details.joined(separator: ", ")
        }
        return line
    }

    static func findElement(index: Int, in elements: [AccessibilityElement]) -> AccessibilityElement? {
        for element in elements {
            if element.index == index { return element }
            if let child = findElement(index: index, in: element.children) { return child }
        }
        return nil
    }

    static func focusedElementLine(_ snapshot: AccessibilityAppStateSnapshot) -> String? {
        guard let focusedIndex = snapshot.focusedElementIndex else { return nil }
        guard let element = findElement(index: focusedIndex, in: snapshot.elements) else {
            return "The focused UI element is \(focusedIndex)."
        }
        return "The focused UI element is \(formatElementLine(element, depth: 0))."
    }

    static func windowSpaceLine(_ snapshot: AccessibilityAppStateSnapshot) -> String? {
        guard snapshot.windowOnCurrentSpace == false else { return nil }
        let currentSpace = snapshot.currentSpaceId.map(String.init) ?? "unknown"
        let spaceIds = snapshot.windowSpaceIds ?? []
        let windowSpaces = spaceIds.isEmpty ? "unknown" : spaceIds.map(String.init).joined(separator: ", ")
        return "Window is on another macOS Space (current Space \(currentSpace), window Spaces \(windowSpaces)). Screenshot capture can still work, but macOS may expose only a reduced Accessibility tree until the window is moved to the current Space."
    }

    /// The `appState` text the agent consumes.
    public static func render(_ snapshot: AccessibilityAppStateSnapshot) -> String {
        let indexed = index(snapshot).snapshot
        let appName = indexed.appDisplayName ?? indexed.app
        let appIdentity = indexed.appPath ?? appName
        var appDetails: [String] = []
        if let bundleId = indexed.bundleId { appDetails.append("bundleID \(bundleId)") }
        if let pid = indexed.pid { appDetails.append("pid \(pid)") }
        var lines = [
            "Computer Use state",
            "<app_state>",
            appDetails.isEmpty ? "App=\(appIdentity)" : "App=\(appIdentity) (\(appDetails.joined(separator: ", ")))",
        ]
        if let windowTitle = formatText(indexed.windowTitle) ?? formatText(indexed.elements.first?.name) {
            lines.append("Window: \"\(windowTitle)\", App: \(appName).")
        }
        if let spaceLine = windowSpaceLine(indexed) {
            lines.append(spaceLine)
        }
        func visit(_ element: AccessibilityElement, depth: Int) {
            lines.append(formatElementLine(element, depth: depth))
            for child in element.children {
                visit(child, depth: depth + 1)
            }
        }
        for element in indexed.elements {
            visit(element, depth: 0)
        }
        if let focusedLine = focusedElementLine(indexed) {
            lines.append("")
            lines.append(focusedLine)
        }
        lines.append("</app_state>")
        return lines.joined(separator: "\n")
    }
}
