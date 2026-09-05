import AppKit
import DesktopCore

@main
enum Installer {
  @MainActor static func main() async {
    do {
      let args = CommandLine.arguments
      guard args.count == 5, let pid = Int32(args[1]),
        ["ai.okou.desktop", "ai.vm0.zero.desktop"].contains(args[4])
      else { throw DesktopFailure("update_arguments", "Invalid updater arguments") }
      let candidate = URL(fileURLWithPath: args[2])
      let installed = URL(fileURLWithPath: args[3])
      let requirement =
        "anchor apple generic and identifier \"\(args[4])\" and certificate leaf[subject.OU] = \"C5UWSXYB67\""
      _ = try await ProcessCommand().run(
        "/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, candidate.path])
      guard Bundle(url: installed)?.bundleIdentifier == args[4],
        Bundle(url: candidate)?.bundleIdentifier == args[4]
      else { throw DesktopFailure("update_identity", "Desktop update bundle identity mismatch") }
      let deadline = Date().addingTimeInterval(60)
      while let application = NSRunningApplication(processIdentifier: pid),
        !application.isTerminated
      {
        guard Date() < deadline else {
          throw DesktopFailure("update_timeout", "Desktop did not quit for its update")
        }
        try await Task.sleep(for: .milliseconds(200))
      }
      try await DesktopBundleReplacement.install(candidate: candidate, installed: installed) {
        app in
        _ = try await NSWorkspace.shared.openApplication(
          at: app, configuration: NSWorkspace.OpenConfiguration())
      }
    } catch {
      let app = NSApplication.shared
      app.setActivationPolicy(.accessory)
      let alert = NSAlert(error: error)
      alert.runModal()
      exit(1)
    }
  }
}
