import AppKit
import DesktopCore

struct DesktopUpdateActivity {
  let executing: Bool
  let recording: Bool
  let lastCommand: Date?

  static let idle = DesktopUpdateActivity(executing: false, recording: false, lastCommand: nil)
  var shouldDefer: Bool {
    executing || recording || lastCommand.map { Date().timeIntervalSince($0) < 30 * 60 } == true
  }
}

@MainActor
final class DesktopUpdater {
  private let configuration: DesktopConfiguration
  private let directory: URL
  private let feed: DesktopUpdateFeed
  private let activity: @MainActor () -> DesktopUpdateActivity
  private let prepareForUpdate: @MainActor () async throws -> Void
  private let recoverAfterFailedUpdate: @MainActor () async -> Void
  private let report: @MainActor (any Error) -> Void
  private let quitForUpdate: @MainActor () -> Void
  private var loop: Task<Void, Never>?
  private var pending: PendingUpdate?
  private var checking = false

  private struct PendingUpdate {
    let release: DesktopRelease
    let directory: URL
    let candidate: URL
  }

  init(
    configuration: DesktopConfiguration, directory: URL, feed: DesktopUpdateFeed,
    activity: @escaping @MainActor () -> DesktopUpdateActivity,
    prepareForUpdate: @escaping @MainActor () async throws -> Void,
    recoverAfterFailedUpdate: @escaping @MainActor () async -> Void,
    report: @escaping @MainActor (any Error) -> Void,
    quitForUpdate: @escaping @MainActor () -> Void
  ) {
    self.configuration = configuration
    self.directory = directory
    self.feed = feed
    self.activity = activity
    self.prepareForUpdate = prepareForUpdate
    self.recoverAfterFailedUpdate = recoverAfterFailedUpdate
    self.report = report
    self.quitForUpdate = quitForUpdate
  }

  func start() {
    guard configuration.production, loop == nil else { return }
    loop = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        do { try await self.check(manual: false) } catch { self.report(error) }
        do { try await Task.sleep(for: .seconds(30 * 60)) } catch { return }
      }
    }
  }

  func stop() {
    loop?.cancel()
    loop = nil
  }

  func check(manual: Bool) async throws {
    guard !checking else { return }
    checking = true
    defer { checking = false }
    guard configuration.production else {
      if manual {
        showInfo(
          "Preview updates",
          "Download a new build from the pull request to update this development app.")
      }
      return
    }
    guard let release = try await feed.latest(after: configuration.version) else {
      if manual { showInfo("No Updates Available", "\(configuration.name) is up to date.") }
      return
    }
    guard configuration.product == "okou" else {
      throw DesktopFailure("update_feed", "The update does not belong to this desktop product")
    }
    if pending?.release != release {
      let downloaded = try await download(release)
      if let previous = pending { try FileManager.default.removeItem(at: previous.directory) }
      pending = downloaded
    }
    guard !activity().shouldDefer else {
      if manual {
        showInfo(
          "Update Downloaded",
          "Version \(release.version) will install after Computer Use has been idle for 30 minutes and recording has finished."
        )
      }
      return
    }
    if manual {
      let alert = NSAlert()
      alert.messageText = "Restart to install \(release.version)?"
      alert.addButton(withTitle: "Restart")
      alert.addButton(withTitle: "Later")
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    guard let pending else { return }
    try await install(pending)
  }

  private func download(_ release: DesktopRelease) async throws -> PendingUpdate {
    let staging = directory.appendingPathComponent("updates/\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: staging, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var completed = false
    defer { if !completed { try? FileManager.default.removeItem(at: staging) } }
    let session = URLSession(configuration: .ephemeral)
    defer { session.finishTasksAndInvalidate() }
    let (download, response) = try await session.download(from: release.archiveURL)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw DesktopFailure("update_download", "Desktop update download failed")
    }
    let archive = staging.appendingPathComponent("update.zip")
    try FileManager.default.moveItem(at: download, to: archive)
    let links = try UpdateArchive.validate(archive, appName: "Okou.app")
    for link in links {
      let target = try await ProcessCommand().run("/usr/bin/unzip", ["-p", archive.path, link])
      try UpdateArchive.validateLink(String(decoding: target, as: UTF8.self))
    }
    let extracted = staging.appendingPathComponent("extracted")
    _ = try await ProcessCommand().run(
      "/usr/bin/ditto", ["-x", "-k", archive.path, extracted.path], timeout: 120)
    let candidate = extracted.appendingPathComponent("Okou.app")
    let requirement =
      "anchor apple generic and identifier \"\(configuration.bundleID)\" and certificate leaf[subject.OU] = \"C5UWSXYB67\""
    _ = try await ProcessCommand().run(
      "/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, candidate.path])
    guard
      Bundle(url: candidate)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        == release.version
    else {
      throw DesktopFailure("update_identity", "The downloaded app has a different version")
    }
    completed = true
    return PendingUpdate(release: release, directory: staging, candidate: candidate)
  }

  private func install(_ update: PendingUpdate) async throws {
    // Prepare all fallible installer setup before draining the user's runtime.
    let installer = update.directory.appendingPathComponent("installer-\(UUID().uuidString)")
    try FileManager.default.copyItem(
      at: Bundle.main.resourceURL!.appendingPathComponent("native/okou-desktop-updater"),
      to: installer)
    try await prepareForUpdate()
    let process = Process()
    process.executableURL = installer
    process.arguments = [
      String(ProcessInfo.processInfo.processIdentifier), update.candidate.path,
      Bundle.main.bundleURL.path, configuration.bundleID,
    ]
    do {
      try process.run()
    } catch {
      await recoverAfterFailedUpdate()
      throw error
    }
    quitForUpdate()
  }

  private func showInfo(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }
}
