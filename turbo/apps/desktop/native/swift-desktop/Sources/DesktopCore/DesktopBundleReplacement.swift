import Foundation

@MainActor
public enum DesktopBundleReplacement {
  /// The caller verifies signatures and bundle identities before this step.
  /// Keep the original bundle until Launch Services accepts the replacement.
  public static func install(
    candidate: URL, installed: URL,
    launch: @MainActor (URL) async throws -> Void
  ) async throws {
    let manager = FileManager.default
    let backupName = installed.lastPathComponent + ".backup-" + UUID().uuidString
    let backup = installed.deletingLastPathComponent().appendingPathComponent(backupName)
    _ = try manager.replaceItemAt(
      installed, withItemAt: candidate, backupItemName: backupName,
      options: [.withoutDeletingBackupItem])
    do {
      try await launch(installed)
    } catch {
      let launchError = error
      _ = try manager.replaceItemAt(installed, withItemAt: backup)
      try await launch(installed)
      throw DesktopFailure(
        "update_relaunch",
        "The update could not launch. The previous version was restored and relaunched: \(launchError.localizedDescription)"
      )
    }
    do { try manager.removeItem(at: backup) } catch {
      FileHandle.standardError.write(
        Data(
          "The update launched, but its backup could not be removed: \(error.localizedDescription)\n"
            .utf8))
    }
  }
}
