import Foundation

/// What a later click needs to know about an `app.state` snapshot.
public struct ComputerUseSnapshotMetadata: Equatable, Sendable {
    public var app: String
    public var snapshotId: String
    public var elementIdsByIndex: [String]
    public var focusedElementIndex: Int?
    public var windowId: Int?
    public var windowFrame: ComputerUseCoordinateBounds?
    public var screenshotWidth: Double
    public var screenshotHeight: Double
    public var screenshotSource: String
    public var screenshotSourceName: String
    public var sourceBounds: ComputerUseCoordinateBounds?

    public init(
        app: String, snapshotId: String, elementIdsByIndex: [String], focusedElementIndex: Int?, windowId: Int?,
        windowFrame: ComputerUseCoordinateBounds?, screenshotWidth: Double, screenshotHeight: Double,
        screenshotSource: String, screenshotSourceName: String, sourceBounds: ComputerUseCoordinateBounds?
    ) {
        self.app = app
        self.snapshotId = snapshotId
        self.elementIdsByIndex = elementIdsByIndex
        self.focusedElementIndex = focusedElementIndex
        self.windowId = windowId
        self.windowFrame = windowFrame
        self.screenshotWidth = screenshotWidth
        self.screenshotHeight = screenshotHeight
        self.screenshotSource = screenshotSource
        self.screenshotSourceName = screenshotSourceName
        self.sourceBounds = sourceBounds
    }
}

/// LRU of recent snapshots keyed by app and snapshot id, plus the latest
/// snapshot per app. Port of `ComputerUseSnapshotStore`.
public final class ComputerUseSnapshotStore: @unchecked Sendable {
    public static let defaultLimit = 50

    private let maxEntries: Int
    private var order: [String] = []
    private var snapshots: [String: ComputerUseSnapshotMetadata] = [:]
    private var latestByApp: [String: String] = [:]
    private let lock = NSLock()

    public init(maxEntries: Int = ComputerUseSnapshotStore.defaultLimit) {
        self.maxEntries = maxEntries
    }

    static func appKey(_ app: String) -> String {
        app.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func key(_ app: String, _ snapshotId: String) -> String {
        "\(Self.appKey(app))\u{0}\(snapshotId)"
    }

    public func set(_ metadata: ComputerUseSnapshotMetadata) {
        lock.withLock {
            let key = key(metadata.app, metadata.snapshotId)
            if snapshots[key] != nil {
                order.removeAll { $0 == key }
            }
            snapshots[key] = metadata
            order.append(key)
            latestByApp[Self.appKey(metadata.app)] = key
            while snapshots.count > maxEntries, let oldest = order.first {
                order.removeFirst()
                snapshots.removeValue(forKey: oldest)
                for (appKey, snapshotKey) in latestByApp where snapshotKey == oldest {
                    latestByApp.removeValue(forKey: appKey)
                }
            }
        }
    }

    public func get(app: String, snapshotId: String) -> ComputerUseSnapshotMetadata? {
        lock.withLock { snapshots[key(app, snapshotId)] }
    }

    public func latest(app: String) -> ComputerUseSnapshotMetadata? {
        lock.withLock {
            guard let key = latestByApp[Self.appKey(app)] else { return nil }
            return snapshots[key]
        }
    }
}
