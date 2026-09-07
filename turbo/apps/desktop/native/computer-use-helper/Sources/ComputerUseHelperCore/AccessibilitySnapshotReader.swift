import ApplicationServices
import Foundation

/// Reads one accessibility snapshot. A new reader is required after an action or
/// before another capture so values cannot escape the snapshot that observed them.
public final class AccessibilitySnapshotReader {
    private struct CachedValue {
        let value: Any?
    }

    private static let metadata: [String] = [
        kAXRoleAttribute, kAXRoleDescriptionAttribute, kAXSubroleAttribute,
        kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXHelpAttribute,
        kAXPlaceholderValueAttribute, kAXVisibleTextAttribute, kAXTextAttribute,
        kAXTitleUIElementAttribute, kAXColumnTitlesAttribute, kAXIdentifierAttribute,
        kAXURLAttribute, kAXFocusedAttribute, kAXEnabledAttribute, kAXSelectedAttribute,
        kAXExpandedAttribute, "AXHidden", kAXPositionAttribute, kAXSizeAttribute,
    ].map { $0 as String }
    private static let metadataNames = Set(metadata)

    private let timeoutSeconds: Float
    private let recordError: (AXError, CFString) -> Void
    private var values: [AXUIElement: [String: CachedValue]] = [:]

    public init(timeoutSeconds: Float, recordError: @escaping (AXError, CFString) -> Void) {
        self.timeoutSeconds = timeoutSeconds
        self.recordError = recordError
    }

    public func value(_ element: AXUIElement, _ attribute: CFString) -> Any? {
        if let cached = values[element]?[attribute as String] {
            return cached.value
        }
        let attributes =
            Self.metadataNames.contains(attribute as String)
            ? Self.metadata.map { $0 as CFString } : [attribute]
        prefetch(element, attributes)
        return values[element]?[attribute as String]?.value
    }

    public func prefetch(_ element: AXUIElement, _ attributes: [CFString]) {
        let missing = attributes.filter { values[element]?[$0 as String] == nil }
        guard !missing.isEmpty else { return }
        AXUIElementSetMessagingTimeout(element, timeoutSeconds)
        var result: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(element, missing as CFArray, [], &result)
        if error == .success, let entries = result as? [Any], entries.count == missing.count {
            for (attribute, entry) in zip(missing, entries) {
                store(element, attribute, decoded(entry, attribute: attribute))
            }
        } else if error == .cannotComplete {
            recordError(error, missing[0])
            for attribute in missing { store(element, attribute, nil) }
        } else {
            // Some accessibility providers cannot answer a batch. Retain the
            // individual-attribute behavior for those providers.
            for (index, attribute) in missing.enumerated() {
                var entry: CFTypeRef?
                let readError = AXUIElementCopyAttributeValue(element, attribute, &entry)
                if readError != .success { recordError(readError, attribute) }
                store(element, attribute, readError == .success ? entry : nil)
                if readError == .cannotComplete {
                    for remaining in missing.dropFirst(index + 1) { store(element, remaining, nil) }
                    break
                }
            }
        }
    }

    private func store(_ element: AXUIElement, _ attribute: CFString, _ value: Any?) {
        values[element, default: [:]][attribute as String] = CachedValue(value: value)
    }

    private func decoded(_ value: Any, attribute: CFString) -> Any? {
        let reference = value as CFTypeRef
        guard CFGetTypeID(reference) == AXValueGetTypeID() else { return value }
        let wrapped = reference as! AXValue
        guard AXValueGetType(wrapped) == .axError else { return value }
        var error = AXError.success
        AXValueGetValue(wrapped, .axError, &error)
        recordError(error, attribute)
        return nil
    }
}
