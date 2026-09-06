import Foundation

/// The single JSON preferences file under the app's user data directory.
/// Whole-file read-modify-write, no locking, like `desktop-preferences.ts`.
public struct DesktopPreferencesStore: Sendable {
    public static let fileName = "desktop-preferences.json"

    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func read() throws -> [String: JSONValue] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return [:]
        }
        let data = try Data(contentsOf: fileURL)
        return (try JSONValue.parse(data)).objectValue ?? [:]
    }

    public func write(_ record: [String: JSONValue]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let text = JSONValue.object(record).serialized(options: JSONSerializationOptions(pretty: true)) + "\n"
        try Data(text.utf8).write(to: fileURL, options: .atomic)
    }

    /// Reads, mutates and writes back so sibling keys survive.
    public func update(_ mutate: (inout [String: JSONValue]) -> Void) throws {
        var record = try read()
        mutate(&record)
        try write(record)
    }
}

public enum ComputerUseInstallationId {
    public static let preferenceKey = "computerUseInstallationId"
    private static let uuidPattern =
        #/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/#.ignoresCase()

    public static func isValid(_ value: String) -> Bool {
        value.firstMatch(of: uuidPattern) != nil
    }

    /// Returns the stored installation id, generating and persisting a new
    /// one when absent or malformed. This id is the server-side upsert key for
    /// host de-duplication; losing it creates orphan host rows.
    public static func readOrCreate(
        store: DesktopPreferencesStore,
        generate: () -> String = { UUID().uuidString.lowercased() }
    ) throws -> String {
        let preferences = try store.read()
        if let existing = preferences[preferenceKey]?.stringValue, isValid(existing) {
            return existing
        }
        let installationId = generate()
        var updated = preferences
        updated[preferenceKey] = .string(installationId)
        try store.write(updated)
        return installationId
    }
}
