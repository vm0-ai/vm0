import AppKit
import Carbon
import DesktopCore
import Sentry
import SwiftUI

@main
enum DesktopApp {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = DesktopDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}

@MainActor
final class DesktopDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
  private var model: DesktopModel?
  private var mainWindow: NSWindow?
  private var statusItem: NSStatusItem?
  private var updater: DesktopUpdater?
  private var hotKey: EventHotKeyRef?
  private var hotKeyHandler: EventHandlerRef?
  private var hotKeyAttempted = false
  private var quitting = false
  private var pendingURLs: [URL] = []
  private var startupFailure: (DesktopConfiguration, any Error)?

  private struct BundledConfiguration: Decodable {
    let platformUrl: String
    let product: String
    let preview: Bool
    let sentryDsn: String?
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      let resources = Bundle.main.resourceURL!
      let raw = try JSONDecoder().decode(
        BundledConfiguration.self,
        from:
          Data(contentsOf: resources.appendingPathComponent("desktop-runtime-config.json")))
      guard
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
          as? String,
        !version.isEmpty
      else { throw DesktopFailure("configuration", "The app bundle has no desktop version") }
      let config = try DesktopConfiguration(
        platformURL: raw.platformUrl, product: raw.product, version: version, preview: raw.preview)
      if let dsn = raw.sentryDsn, !dsn.isEmpty {
        SentrySDK.start { options in
          options.dsn = dsn
          options.releaseName = "desktop@\(config.version)"
          options.environment = config.production ? "production" : "development"
          options.sendDefaultPii = false
          options.tracesSampleRate = 0
        }
      }
      // A native preview uses the existing development identity. It can
      // coexist with the production app and its permission grants.
      let directory = FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(
          config.name)
      let line = config.product == "okou" ? "ai-okou-desktop" : "zero"
      let feed = DesktopUpdateFeed(
        url: config.apiURL.appendingPathComponent(
          "api/desktop/updates/\(line)/stable/darwin/arm64/RELEASES.json"))
      let model: DesktopModel
      do {
        model = try loadRuntime(
          configuration: config, directory: directory,
          helperDirectory: resources.appendingPathComponent("native"), feed: feed)
      } catch {
        startupFailure = (config, error)
        reportBootstrapFailure(error, directory: directory)
        installDegradedMenu(config)
        showWindow()
        return
      }
      model.onChange = { [weak self] in self?.refreshStatus() }
      installMenus()
      statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
      let menu = NSMenu()
      menu.delegate = self
      statusItem?.menu = menu
      NSApp.setActivationPolicy(.accessory)
      refreshStatus()
      if CommandLine.arguments.contains("--smoke-test") {
        showWindow()
        model.run {
          _ = try await model.helper.request("permissions.state")
          if let index = CommandLine.arguments.firstIndex(of: "--smoke-screenshot"),
            CommandLine.arguments.indices.contains(index + 1),
            let view = self.mainWindow?.contentView
          {
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
              throw DesktopFailure("smoke_test", "Could not render the native settings window")
            }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else {
              throw DesktopFailure("smoke_test", "Could not encode the native settings window")
            }
            try png.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1]))
          }
          FileHandle.standardOutput.write(Data("OKOU_SWIFT_DESKTOP_READY\n".utf8))
          await model.helper.stop()
          NSApp.terminate(nil)
        }
        return
      }
      Task {
        await model.launch()
        if !model.ready { showWindow() }
        for url in pendingURLs { model.run { try await model.consume(url) } }
        pendingURLs = []
      }
    } catch {
      let alert = NSAlert(error: error)
      alert.runModal()
      NSApp.terminate(nil)
    }
  }

  /// Bootstrap owns update polling before touching preferences or runtime state.
  /// Missing runtime activity is an intentional idle state after startup fails.
  func loadRuntime(
    configuration: DesktopConfiguration, directory: URL,
    helperDirectory: URL, feed: DesktopUpdateFeed
  ) throws -> DesktopModel {
    updater = DesktopUpdater(
      configuration: configuration, directory: directory, feed: feed,
      activity: { [weak self] in
        guard let model = self?.model else { return .idle }
        return DesktopUpdateActivity(
          executing: model.host.executing, recording: model.recorder.busy,
          lastCommand: model.host.lastCommand)
      },
      prepareForUpdate: { [weak self] in
        if let model = self?.model { try await model.shutdown() }
      },
      report: { [weak self] error in
        if let model = self?.model {
          model.report(error)
        } else {
          self?.reportBootstrapFailure(error, directory: directory)
        }
      },
      quitForUpdate: { [weak self] in
        self?.quitting = true
        NSApp.terminate(nil)
      })
    updater?.start()
    let model = try DesktopModel(
      configuration: configuration, directory: directory, helperDirectory: helperDirectory)
    self.model = model
    return model
  }

  func applicationWillTerminate(_ notification: Notification) {
    updater?.stop()
    updateShortcut(recording: false)
  }

  private func reportBootstrapFailure(_ error: any Error, directory: URL) {
    SentrySDK.capture(error: error)
    FileHandle.standardError.write(Data("Desktop startup: \(error.localizedDescription)\n".utf8))
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let file = directory.appendingPathComponent("desktop-bootstrap-failure.log")
      try Data("\(Date()) \(error.localizedDescription)\n".utf8).write(to: file, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    } catch {
      FileHandle.standardError.write(
        Data("Could not save desktop startup diagnostic: \(error.localizedDescription)\n".utf8))
    }
  }

  private func installDegradedMenu(_ configuration: DesktopConfiguration) {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let app = NSMenu(title: configuration.name)
    app.addItem(item("Show Startup Error", #selector(showWindow)))
    app.addItem(item("Check for Updates…", #selector(checkUpdates)))
    app.addItem(.separator())
    app.addItem(item("Quit \(configuration.name)", #selector(quit), key: "q"))
    appItem.submenu = app
    NSApp.mainMenu = main
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    guard let model else {
      pendingURLs += urls
      return
    }
    for url in urls { model.run { try await model.consume(url) } }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    showWindow()
    return false
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  @objc func showWindow() {
    guard let model else {
      if let (config, error) = startupFailure {
        NSApp.setActivationPolicy(.regular)
        let alert = NSAlert(error: error)
        alert.messageText = "\(config.name) hit an error during startup."
        alert.informativeText =
          config.production
          ? "Keep the app running: a fixed update will be downloaded and installed automatically as soon as it is available."
          : "Download the latest development build and reinstall the app."
        alert.runModal()
      }
      return
    }
    if mainWindow == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 680, height: 760),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered,
        defer: false)
      window.title = model.configuration.name
      window.contentView = NSHostingView(rootView: DesktopView(model: model))
      window.minSize = NSSize(width: 620, height: 640)
      window.delegate = self
      window.isReleasedWhenClosed = false
      window.center()
      mainWindow = window
    }
    NSApp.setActivationPolicy(.regular)
    mainWindow?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    NSApp.setActivationPolicy(.accessory)
    return false
  }

  private func installMenus() {
    guard let model else { return }
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let application = NSMenu(title: model.configuration.name)
    application.addItem(
      withTitle: "About \(model.configuration.name)",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    application.addItem(item("Check for Updates…", #selector(checkUpdates)))
    application.addItem(item("Developer Tools", #selector(toggleDebug)))
    application.addItem(.separator())
    application.addItem(item("Quit \(model.configuration.name)", #selector(quit), key: "q"))
    appItem.submenu = application
    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    for (title, selector, key) in [
      ("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
      ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a"),
    ] {
      edit.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
    }
    editItem.submenu = edit
    let windowItem = NSMenuItem()
    main.addItem(windowItem)
    let window = NSMenu(title: "Window")
    window.addItem(
      withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    window.addItem(
      withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = window
    NSApp.windowsMenu = window
    NSApp.mainMenu = main
  }

  private func item(_ title: String, _ action: Selector?, key: String = "", enabled: Bool = true)
    -> NSMenuItem
  {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = self
    item.isEnabled = enabled
    return item
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    guard let model else { return }
    menu.removeAllItems()
    menu.autoenablesItems = false
    menu.addItem(
      item("\(model.configuration.name) · \(model.host.status.capitalized)", nil, enabled: false))
    if let organization = model.auth.organization["name"].string {
      menu.addItem(item(organization, nil, enabled: false))
    }
    menu.addItem(item("Open \(model.configuration.name)", #selector(showWindow)))
    menu.addItem(.separator())
    menu.addItem(
      item(
        "Start Computer Use", #selector(startHost),
        enabled: model.ready && !["online", "connecting", "recovering"].contains(model.host.status))
    )
    menu.addItem(
      item("Stop Computer Use", #selector(stopHost), enabled: model.host.status != "offline"))
    menu.addItem(item("Refresh Status", #selector(refresh)))
    menu.addItem(
      item("Switch Workspace…", #selector(switchOrganization), enabled: model.auth.signedIn))
    menu.addItem(item(model.auth.signedIn ? "Sign Out" : "Sign In…", #selector(signInOrOut)))
    menu.addItem(.separator())
    let awake = item("Keep Awake", #selector(toggleAwake))
    awake.state = model.keepAwake ? .on : .off
    menu.addItem(awake)
    menu.addItem(item("Accessibility Settings…", #selector(accessibilitySettings)))
    menu.addItem(item("Screen Recording Settings…", #selector(screenSettings)))
    if model.recorder.available {
      menu.addItem(.separator())
      if model.recorder.capturing {
        menu.addItem(
          item(
            "\(model.recorder.status.capitalized) · \(Int(model.recorder.elapsed))s", nil,
            enabled: false))
        menu.addItem(
          item(
            model.recorder.status == "paused" ? "Resume Recording" : "Pause Recording",
            #selector(pauseRecording)))
        menu.addItem(item("Stop and Review (⌃⇧R)", #selector(stopRecording)))
        menu.addItem(item("Discard Recording", #selector(discardRecording)))
      } else if model.recorder.status == "ready" {
        menu.addItem(item("Retry Recording Upload", #selector(retryRecording)))
        menu.addItem(item("Show Recording in Finder", #selector(revealRecording)))
      } else {
        menu.addItem(
          item("Screen Recording…", #selector(showWindow), enabled: !model.recorder.busy))
      }
    }
    menu.addItem(.separator())
    menu.addItem(item("Quit \(model.configuration.name)", #selector(quit), key: "q"))
  }

  private func refreshStatus() {
    guard let model else { return }
    let recording = model.recorder.capturing
    let image = NSImage(
      systemSymbolName: recording
        ? "record.circle.fill"
        : model.host.status == "online"
          ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark",
      accessibilityDescription: model.configuration.name)
    image?.isTemplate = true
    statusItem?.button?.image = image
    statusItem?.button?.title = recording ? " \(Int(model.recorder.elapsed))s" : ""
    if let debug = NSApp.mainMenu?.items.first?.submenu?.items.first(where: {
      $0.action == #selector(toggleDebug)
    }) {
      debug.isHidden = !model.debugAvailable
      debug.state = model.debugEnabled ? .on : .off
    }
    updateShortcut(recording: recording)
  }

  private func updateShortcut(recording: Bool) {
    if recording && !hotKeyAttempted {
      hotKeyAttempted = true
      var event = EventTypeSpec(
        eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
      let handler: EventHandlerUPP = { _, _, _ in
        Task { @MainActor in (NSApp.delegate as? DesktopDelegate)?.stopRecording() }
        return noErr
      }
      InstallEventHandler(GetApplicationEventTarget(), handler, 1, &event, nil, &hotKeyHandler)
      let result = RegisterEventHotKey(
        15, UInt32(controlKey | shiftKey), EventHotKeyID(signature: 0x4f4b_4f55, id: 1),
        GetApplicationEventTarget(), 0, &hotKey)
      if result != noErr {
        model?.report(
          DesktopFailure("shortcut", "Could not register ⌃⇧R; stop recording from the menu bar."))
      }
    } else if !recording {
      if let hotKey {
        UnregisterEventHotKey(hotKey)
        self.hotKey = nil
      }
      if let hotKeyHandler {
        RemoveEventHandler(hotKeyHandler)
        self.hotKeyHandler = nil
      }
      hotKeyAttempted = false
    }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let model, !quitting else { return .terminateNow }
    if CommandLine.arguments.contains("--smoke-test") { return .terminateNow }
    let alert = NSAlert()
    alert.messageText = "Quit \(model.configuration.name)?"
    alert.informativeText =
      "Computer Use will disconnect. Any active recording will be finalized before quitting."
    alert.addButton(withTitle: "Quit")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return .terminateCancel }
    quitting = true
    updater?.stop()
    Task {
      do {
        try await model.shutdown()
        updateShortcut(recording: false)
        NSApp.reply(toApplicationShouldTerminate: true)
      } catch {
        quitting = false
        model.report(error)
        showWindow()
        NSApp.reply(toApplicationShouldTerminate: false)
      }
    }
    return .terminateLater
  }

  @objc private func startHost() { model?.host.start() }
  @objc private func stopHost() {
    guard let model else { return }
    model.run { await model.host.stop() }
  }
  @objc private func refresh() {
    guard let model else { return }
    model.run { try await model.refresh() }
  }
  @objc private func switchOrganization() {
    guard let model else { return }
    model.run { try await model.switchOrganization() }
  }
  @objc private func signInOrOut() {
    guard let model else { return }
    model.run {
      if model.auth.signedIn { try await model.signOut() } else { try model.auth.signIn() }
    }
  }
  @objc private func toggleAwake() {
    guard let model else { return }
    model.run { try model.setKeepAwake(!model.keepAwake) }
  }
  @objc private func toggleDebug() {
    guard let model, model.debugAvailable else { return }
    model.debugEnabled.toggle()
    refreshStatus()
  }
  @objc private func accessibilitySettings() { openPrivacy("Privacy_Accessibility") }
  @objc private func screenSettings() { openPrivacy("Privacy_ScreenCapture") }
  @objc private func pauseRecording() {
    guard let model else { return }
    model.run { try await model.recorder.pauseOrResume() }
  }
  @objc func stopRecording() {
    guard let model else { return }
    model.run { try await model.recorder.stop() }
  }
  @objc private func discardRecording() {
    guard let model else { return }
    model.run { try await model.recorder.discard() }
  }
  @objc private func retryRecording() {
    guard let model else { return }
    model.run { try await model.recorder.deliver() }
  }
  @objc private func revealRecording() { model?.recorder.revealRecording() }
  @objc private func quit() { NSApp.terminate(nil) }
  @objc private func checkUpdates() {
    guard let updater else { return }
    Task {
      do { try await updater.check(manual: true) } catch { NSAlert(error: error).runModal() }
    }
  }
}
