import AppKit
import DesktopCore

/// Duplicate launches signal the existing application after writing a private
/// callback request. Authentication codes never enter distributed notifications.
@MainActor
final class DesktopActivation: NSObject {
  private let directory: URL
  private let identity: String
  private let receive: @MainActor ([URL]) -> Void
  private let report: @MainActor (any Error) -> Void
  private let notification = Notification.Name("ai.vm0.desktop.native-activation")
  private var lock: DesktopInstanceLock?

  init(
    directory: URL, identity: String, receive: @escaping @MainActor ([URL]) -> Void,
    report: @escaping @MainActor (any Error) -> Void
  ) throws {
    self.directory = directory
    self.identity = identity + "." + String(getuid())
    self.receive = receive
    self.report = report
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    super.init()
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(activated), name: notification, object: self.identity,
      suspensionBehavior: .deliverImmediately)
  }

  func claim() throws -> Bool {
    if lock != nil { return true }
    lock = try DesktopInstanceLock.acquire(at: directory.appendingPathComponent("instance.lock"))
    if lock != nil { consumeRequests() }
    return lock != nil
  }

  func forward(_ urls: [URL]) throws {
    let name =
      String(format: "%.6f", Date().timeIntervalSince1970) + "-" + UUID().uuidString + ".json"
    let file = directory.appendingPathComponent(name)
    try JSONEncoder().encode(urls.map(\.absoluteString)).write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    DistributedNotificationCenter.default().postNotificationName(
      notification, object: identity, userInfo: nil, deliverImmediately: true)
  }

  func stop() {
    DistributedNotificationCenter.default().removeObserver(self)
    lock = nil
  }

  @objc private func activated(_ value: Notification) { consumeRequests() }

  private func consumeRequests() {
    guard lock != nil else { return }
    do {
      let files = try FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil
      )
      .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
      for file in files {
        let strings = try JSONDecoder().decode([String].self, from: Data(contentsOf: file))
        let urls = try strings.map { text in
          guard let url = URL(string: text) else {
            throw DesktopFailure("activation", "The queued desktop callback is invalid")
          }
          return url
        }
        try FileManager.default.removeItem(at: file)
        receive(urls)
      }
    } catch { report(error) }
  }
}
