import Foundation

public enum RecorderWindowOptions {
    /// System chrome nobody records: menu bar extras, the Dock, banners, and
    /// the recorder's own overlays.
    public static let chromeBundleIds: Set<String> = [
        "ai.okou.desktop",
        "ai.vm0.zero.desktop",
        "com.apple.controlcenter",
        "com.apple.dock",
        "com.apple.notificationcenterui",
        "com.apple.spotlight",
        "com.apple.systemuiserver",
        "com.apple.WindowManager",
        "com.apple.wifi.WiFiAgent",
    ]

    static func windowId(_ id: String) -> String? {
        let parts = id.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == "window", !parts[1].isEmpty else {
            return nil
        }
        return String(parts[1])
    }

    /// Joins sources to previews by CoreGraphics window id, drops chrome and
    /// preview-less windows, and sorts by app then title.
    public static func build(
        sources: [DesktopRecorderSource], previews: [DesktopRecorderWindowPreview]
    ) -> [DesktopRecorderWindowOption] {
        var previewById: [String: DesktopRecorderWindowPreview] = [:]
        for preview in previews {
            if let id = windowId(preview.id) {
                previewById[id] = preview
            }
        }

        var options: [DesktopRecorderWindowOption] = []
        for source in sources {
            guard source.kind == .window else { continue }
            if let bundleId = source.bundleId, chromeBundleIds.contains(bundleId) { continue }
            guard let id = windowId(source.id), let preview = previewById[id] else { continue }
            options.append(
                DesktopRecorderWindowOption(
                    id: source.id,
                    title: source.title,
                    appName: source.appName ?? source.title,
                    previewDataUrl: preview.previewDataUrl
                )
            )
        }

        return options.sorted { left, right in
            let byApp = left.appName.localizedCompare(right.appName)
            if byApp != .orderedSame {
                return byApp == .orderedAscending
            }
            return left.title.localizedCompare(right.title) == .orderedAscending
        }
    }
}
