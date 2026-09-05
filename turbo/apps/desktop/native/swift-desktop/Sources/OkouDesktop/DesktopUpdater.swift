import AppKit
import DesktopCore

@MainActor
final class DesktopUpdater {
  private let model: DesktopModel
  private let quitForUpdate: @MainActor () -> Void
  private var loop: Task<Void, Never>?
  private var pending: URL?
  private var checking = false
  private var staging: URL?

  init(model: DesktopModel, quitForUpdate: @escaping @MainActor () -> Void) {
    self.model = model
    self.quitForUpdate = quitForUpdate
  }
  func start() {
    guard model.configuration.production else { return }
    loop = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        do { try await self.check(manual: false) } catch { self.model.report(error) }
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
    let config = model.configuration
    if !config.production {
      if manual {
        showInfo(
          "Preview updates",
          "Download a new build from the pull request to update this development app.")
      }
      return
    }
    let line = config.product == "okou" ? "ai-okou-desktop" : "zero"
    let url = config.apiURL.appendingPathComponent(
      "api/desktop/updates/\(line)/stable/darwin/arm64/RELEASES.json")
    let session = URLSession(configuration: .ephemeral)
    defer { session.finishTasksAndInvalidate() }
    let (data, response) = try await session.data(from: url)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw DesktopFailure("update_feed", "Could not check for desktop updates")
    }
    let feed = try JSON.decode(data)
    let version = try feed.requireString("currentRelease")
    guard version.compare(config.version, options: .numeric) == .orderedDescending else {
      if manual { showInfo("No Updates Available", "\(config.name) is up to date.") }
      return
    }
    guard let release = feed["releases"].array.first(where: { $0["version"].string == version })
    else {
      throw DesktopFailure("update_feed", "The update feed did not include its current release")
    }
    let expected =
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v\(version)/Okou-darwin-arm64-\(version).zip"
    guard config.product == "okou", release["updateTo"]["url"].string == expected else {
      throw DesktopFailure("update_feed", "The update does not belong to this desktop product")
    }
    if pending == nil {
      let directory = model.preferences.directory.appendingPathComponent(
        "updates/\(UUID().uuidString)")
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      staging = directory
      let (download, response) = try await session.download(from: URL(string: expected)!)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw DesktopFailure("update_download", "Desktop update download failed")
      }
      let archive = directory.appendingPathComponent("update.zip")
      try FileManager.default.moveItem(at: download, to: archive)
      let links = try UpdateArchive.validate(archive, appName: "Okou.app")
      for link in links {
        let target = try await ProcessCommand().run("/usr/bin/unzip", ["-p", archive.path, link])
        try UpdateArchive.validateLink(String(decoding: target, as: UTF8.self))
      }
      let extracted = directory.appendingPathComponent("extracted")
      _ = try await ProcessCommand().run(
        "/usr/bin/ditto", ["-x", "-k", archive.path, extracted.path], timeout: 120)
      let candidate = extracted.appendingPathComponent("Okou.app")
      let requirement =
        "anchor apple generic and identifier \"\(config.bundleID)\" and certificate leaf[subject.OU] = \"C5UWSXYB67\""
      _ = try await ProcessCommand().run(
        "/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, candidate.path])
      guard
        Bundle(url: candidate)?.object(forInfoDictionaryKey: "CFBundleShortVersionString")
          as? String == version
      else { throw DesktopFailure("update_identity", "The downloaded app has a different version") }
      pending = candidate
    }
    let recent = model.host.lastCommand.map { Date().timeIntervalSince($0) < 30 * 60 } ?? false
    guard !model.host.executing, !model.recorder.busy, !recent else {
      if manual {
        showInfo(
          "Update Downloaded",
          "Version \(version) will install after Computer Use has been idle for 30 minutes and recording has finished."
        )
      }
      return
    }
    if manual {
      let alert = NSAlert()
      alert.messageText = "Restart to install \(version)?"
      alert.addButton(withTitle: "Restart")
      alert.addButton(withTitle: "Later")
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    guard let candidate = pending, let staging else { return }
    try await model.shutdown()
    // Copy the installer out of the bundle that it will replace.
    let installer = staging.appendingPathComponent("okou-desktop-updater")
    try FileManager.default.copyItem(
      at: Bundle.main.resourceURL!.appendingPathComponent("native/okou-desktop-updater"),
      to: installer)
    let process = Process()
    process.executableURL = installer
    process.arguments = [
      String(ProcessInfo.processInfo.processIdentifier), candidate.path, Bundle.main.bundleURL.path,
      config.bundleID,
    ]
    try process.run()
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
