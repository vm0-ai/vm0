import Foundation

/// One node of the raw accessibility tree returned by the native helper.
///
/// The helper emits arbitrary keys per element; `raw` keeps them so the
/// normalization pass can spread an element unchanged, while the typed
/// accessors read the fields the shaping rules depend on.
public struct AccessibilityElement: Equatable, Sendable {
    public var raw: [String: JSONValue]
    public var children: [AccessibilityElement]
    public var index: Int?

    public init(raw: [String: JSONValue], children: [AccessibilityElement] = [], index: Int? = nil) {
        var stripped = raw
        stripped.removeValue(forKey: "children")
        self.raw = stripped
        self.children = children
        self.index = index ?? raw["index"]?.intValue
    }

    public static func parse(_ value: JSONValue) -> AccessibilityElement? {
        guard let object = value.objectValue else { return nil }
        let children = (object["children"]?.arrayValue ?? []).compactMap(AccessibilityElement.parse)
        return AccessibilityElement(raw: object, children: children)
    }

    func string(_ key: String) -> String? {
        raw[key]?.stringValue
    }

    func bool(_ key: String) -> Bool? {
        raw[key]?.boolValue
    }

    public var id: String? { string("id") }
    public var role: String? { string("role") }
    public var subrole: String? { string("subrole") }
    public var roleDescription: String? { string("roleDescription") }
    public var name: String? { string("name") }
    public var value: String? { string("value") }
    public var valueType: String? { string("valueType") }
    public var valueSettable: Bool? { bool("valueSettable") }
    public var description: String? { string("description") }
    public var help: String? { string("help") }
    public var placeholderValue: String? { string("placeholderValue") }
    public var visibleText: String? { string("visibleText") }
    public var text: String? { string("text") }
    public var titleElementText: String? { string("titleElementText") }
    public var columnTitles: [String]? { raw["columnTitles"]?.arrayValue?.compactMap(\.stringValue) }
    public var identifier: String? { string("identifier") }
    public var url: String? { string("url") }
    public var focused: Bool? { bool("focused") }
    public var enabled: Bool? { bool("enabled") }
    public var selected: Bool? { bool("selected") }
    public var expanded: Bool? { bool("expanded") }
    public var hidden: Bool? { bool("hidden") }
    public var actions: [String]? { raw["actions"]?.arrayValue?.compactMap(\.stringValue) }
    public var pressable: Bool? { bool("pressable") }
    public var pickable: Bool? { bool("pickable") }
    public var selectable: Bool? { bool("selectable") }
    public var mouseClickable: Bool? { bool("mouseClickable") }
    public var clickableKind: String? { string("clickableKind") }
}

/// The `app.state` snapshot: metadata plus the element tree. `raw` holds
/// every metadata key the helper returned so the public result can include
/// fields this code does not model.
public struct AccessibilityAppStateSnapshot: Equatable, Sendable {
    public var raw: [String: JSONValue]
    public var elements: [AccessibilityElement]

    public init(raw: [String: JSONValue], elements: [AccessibilityElement]) {
        var stripped = raw
        stripped.removeValue(forKey: "elements")
        self.raw = stripped
        self.elements = elements
    }

    public static func parse(_ value: JSONValue) -> AccessibilityAppStateSnapshot? {
        guard let object = value.objectValue, let elementsValue = object["elements"]?.arrayValue else {
            return nil
        }
        var elements: [AccessibilityElement] = []
        for entry in elementsValue {
            guard let element = AccessibilityElement.parse(entry) else { return nil }
            elements.append(element)
        }
        return AccessibilityAppStateSnapshot(raw: object, elements: elements)
    }

    func string(_ key: String) -> String? { raw[key]?.stringValue }

    public var app: String { string("app") ?? "" }
    public var appDisplayName: String? { string("appDisplayName") }
    public var bundleId: String? { string("bundleId") }
    public var pid: Int? { raw["pid"]?.intValue }
    public var appPath: String? { string("appPath") }
    public var windowTitle: String? { string("windowTitle") }
    public var windowId: Int? { raw["windowId"]?.intValue }
    public var windowFrame: ComputerUseCoordinateBounds? { ComputerUseCoordinateBounds(raw["windowFrame"]) }
    public var windowOnCurrentSpace: Bool? { raw["windowOnCurrentSpace"]?.boolValue }
    public var currentSpaceId: Int? { raw["currentSpaceId"]?.intValue }
    public var windowSpaceIds: [Int]? { raw["windowSpaceIds"]?.arrayValue?.compactMap(\.intValue) }
    public var snapshotId: String { string("snapshotId") ?? "" }
    public var elementIdsByIndex: [String]? {
        get { raw["elementIdsByIndex"]?.arrayValue?.map { $0.stringValue ?? "" } }
        set { raw["elementIdsByIndex"] = newValue.map { .array($0.map(JSONValue.string)) } }
    }
    public var focusedElementIndex: Int? {
        get { raw["focusedElementIndex"]?.intValue }
        set { raw["focusedElementIndex"] = newValue.map { .number(Double($0)) } }
    }
    public var nodeCount: Int? {
        get { raw["nodeCount"]?.intValue }
        set { raw["nodeCount"] = newValue.map { .number(Double($0)) } }
    }
    public var truncated: Bool? {
        get { raw["truncated"]?.boolValue }
        set { raw["truncated"] = newValue.map(JSONValue.bool) }
    }
    public var truncationReasons: [String]? {
        get { raw["truncationReasons"]?.arrayValue?.compactMap(\.stringValue) }
        set { raw["truncationReasons"] = newValue.map { .array($0.map(JSONValue.string)) } }
    }
    public var screenshot: String? { string("screenshot") }
    public var screenshotMimeType: String? { string("screenshotMimeType") }
    public var screenshotSource: String? { string("screenshotSource") }
    public var screenshotSourceName: String? { string("screenshotSourceName") }
    public var screenshotWidth: Double? { raw["screenshotWidth"]?.doubleValue }
    public var screenshotHeight: Double? { raw["screenshotHeight"]?.doubleValue }
    public var screenshotSourceBounds: ComputerUseCoordinateBounds? { ComputerUseCoordinateBounds(raw["screenshotSourceBounds"]) }

    /// Every element in the tree, including descendants.
    public var elementCount: Int {
        func count(_ elements: [AccessibilityElement]) -> Int {
            elements.reduce(0) { $0 + 1 + count($1.children) }
        }
        return count(elements)
    }
}
