import AppKit
import DesktopCore
import IOKit.pwr_mgt
import Sentry

@MainActor
final class DesktopModel: ObservableObject {
  let configuration: DesktopConfiguration
  let preferences: DesktopPreferences
  let api: DesktopAPI
  let auth: DesktopAuth
  let helper: HelperProcess
  let host: HostRuntime
  let mcp: MCPPlugins
  let recorder: ScreenRecorder
  let areaSelector = AreaSelector()
  @Published var error: String?
  @Published var pluginsAvailable = false
  @Published var debugAvailable = false
  @Published var debugEnabled = false
  @Published var permissions: JSON = .object([:])
  private var keepAwakeAssertion: IOPMAssertionID = 0
  private var keepAwakeActive = false
  private var permissionTask: Task<Void, Never>?
  private var featuresTask: Task<Void, Never>?
  private var shuttingDown = false
  private var featureRequestID: UUID?
  private(set) var changingAccount = false
  var onChange: @MainActor () -> Void = {}
  private let filesystem = FilesystemTools()

  private struct FeatureSwitches: Decodable {
    let effectiveSwitches: [String: Bool]
  }

  init(configuration: DesktopConfiguration, directory: URL, helperDirectory: URL) throws {
    self.configuration = configuration
    preferences = try DesktopPreferences(directory: directory)
    api = DesktopAPI(configuration: configuration)
    auth = DesktopAuth(configuration: configuration, preferences: preferences)
    helper = HelperProcess(
      executable: helperDirectory.appendingPathComponent("computer-use-helper"))
    let commands = ComputerCommands(helper: helper)
    host = HostRuntime(
      api: api, installationID: try preferences.installationID(),
      permissions: { [helper] in
        try DesktopPermissionState.validated(await helper.request("permissions.state"))
      },
      execute: { command, permissions in await commands.execute(command, permissions: permissions) }
    )
    mcp = MCPPlugins(preferences: preferences)
    recorder = ScreenRecorder(
      helper: HelperProcess(
        executable: helperDirectory.appendingPathComponent("screen-recorder-helper"),
        cancelStopsProcess: false), preferences: preferences, api: api, auth: auth)
    api.tokenProvider = { [auth] force in try await auth.getToken(force: force) }
    host.execute = { [weak self, commands] command, permissions in
      guard let self else {
        return DesktopFailure("plugin_unavailable", "Desktop is shutting down").response
      }
      if command["kind"].string == "plugin.call" {
        guard self.pluginsAvailable else {
          return DesktopFailure("feature_disabled", "Desktop plugins are disabled for this account")
            .response
        }
        let payload = command["payload"]
        if payload["plugin"].string == "mcp" { return await self.mcp.execute(payload) }
        guard payload["plugin"].string == "filesystem" else {
          return DesktopFailure("unknown_plugin", "Unknown desktop plugin").response
        }
        guard self.filesystemEnabled else {
          return DesktopFailure("plugin_disabled", "Filesystem access is disabled").response
        }
        return await self.filesystem.execute(payload, allowedDirectories: self.allowedDirectories)
      }
      let result = await commands.execute(command, permissions: permissions)
      if result["error"]["code"].string == "automation_permission_denied" {
        self.error = "Allow browser Automation in System Settings to continue."
      }
      return result
    }
    host.capabilities = { [weak self] in
      guard let self else { return ComputerCommands.capabilities }
      var capabilities = ComputerCommands.capabilities + self.mcp.capabilities
      if self.pluginsAvailable && self.filesystemEnabled && !self.allowedDirectories.isEmpty {
        capabilities +=
          ["plugin.call", "plugin.filesystem"]
          + FilesystemTools.tools.map { "plugin.filesystem.\($0)" }
      }
      return Array(Set(capabilities)).sorted()
    }
    host.onChange = { [weak self] in
      guard let self else { return }
      self.mcp.setContext(
        available: self.pluginsAvailable,
        online: ["online", "recovering"].contains(self.host.status))
      self.changed()
    }
    host.onError = { phase, error in
      SentrySDK.capture(error: error) { scope in
        scope.setTag(value: phase.rawValue, key: "desktop.runtime.phase")
      }
    }
    auth.onChange = { [weak self] in self?.changed() }
    mcp.onChange = { [weak self] in self?.changed() }
    recorder.onChange = { [weak self] in self?.changed() }
  }

  var keepAwake: Bool { preferences.value["keepAwakeEnabled"].bool }
  var filesystemEnabled: Bool {
    preferences.value["computerUsePlugins"]["filesystem"]["enabled"].bool
  }
  var allowedDirectories: [String] {
    preferences.value["computerUsePlugins"]["filesystem"]["allowedDirectories"].array.compactMap(
      \.string)
  }
  var ready: Bool {
    !changingAccount && !shuttingDown && auth.signedIn && auth.organization["id"].string != nil
      && permissions["accessibility"].bool
      && permissions["screenRecording"].bool
  }

  func launch(startHost: Bool = true) async {
    guard permissionTask == nil, featuresTask == nil else { return }
    shuttingDown = false
    do {
      try applyKeepAwake()
      try await refresh()
      if startHost && ready { host.start() }
    } catch { report(error) }
    permissionTask = Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(3))
          guard let self else { return }
          try await self.refreshPermissions()
        } catch {
          if Task.isCancelled { return }
          self?.report(error)
        }
      }
    }
    featuresTask = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(60)) } catch { return }
        guard let self else { return }
        do { try await self.refreshFeatures() } catch is CancellationError {} catch {
          self.report(error)
        }
      }
    }
  }

  func refresh() async throws {
    try await refresh(allowAccountChange: false)
  }

  private func refresh(allowAccountChange: Bool) async throws {
    guard !changingAccount || allowAccountChange else { throw CancellationError() }
    try await refreshPermissions()
    try await auth.refreshIdentity(api: api)
    try await refreshFeatures(allowAccountChange: allowAccountChange)
    changed()
  }

  private func refreshFeatures(allowAccountChange: Bool = false) async throws {
    guard !shuttingDown, !changingAccount || allowAccountChange else { return }
    guard auth.signedIn else {
      featureRequestID = nil
      try await disableFeatures()
      changed()
      return
    }
    let id = UUID()
    let authRevision = auth.revision
    featureRequestID = id
    defer { if featureRequestID == id { featureRequestID = nil } }
    do {
      let body = try await api.request("api/feature-switches")
      try Task.checkCancellation()
      guard !shuttingDown, featureRequestID == id, auth.revision == authRevision else {
        throw CancellationError()
      }
      let switches = try JSONDecoder().decode(FeatureSwitches.self, from: body.encoded())
        .effectiveSwitches
      pluginsAvailable = switches["computerUseDesktopPlugins"] == true
      debugAvailable = switches["_debug"] == true
      if !debugAvailable { debugEnabled = false }
      let recordingEnabled = switches["introVideo"] == true
      let wasRecordingEnabled = recorder.available
      recorder.available = recordingEnabled
      if wasRecordingEnabled && !recordingEnabled { try await recorder.shutdown(force: true) }
    } catch {
      guard !shuttingDown, featureRequestID == id, auth.revision == authRevision,
        !(error is CancellationError)
      else { throw CancellationError() }
      do { try await disableFeatures() } catch { report(error) }
      throw error
    }
    guard !shuttingDown, featureRequestID == id, auth.revision == authRevision else {
      throw CancellationError()
    }
    mcp.setContext(
      available: pluginsAvailable, online: ["online", "recovering"].contains(host.status))
    changed()
  }

  private func disableFeatures() async throws {
    pluginsAvailable = false
    debugAvailable = false
    debugEnabled = false
    let wasRecordingEnabled = recorder.available
    recorder.available = false
    mcp.setContext(available: false, online: false)
    if wasRecordingEnabled { try await recorder.shutdown(force: true) }
  }

  func consume(_ url: URL) async throws {
    guard configuration.callback(url) != nil else { return }
    try await changeAccount {
      if try await self.auth.consume(url) {
        try await self.refresh(allowAccountChange: true)
      }
    }
    if ready { host.start() }
  }

  func switchOrganization() async throws {
    try await changeAccount {
      try await self.auth.selectOrganization()
      try await self.refresh(allowAccountChange: true)
    }
    if ready { host.start() }
  }

  func signOut() async throws {
    try await changeAccount {
      try await self.auth.signOut()
      self.pluginsAvailable = false
      self.recorder.available = false
      self.debugAvailable = false
      self.debugEnabled = false
    }
  }

  private func changeAccount(_ operation: @escaping @MainActor () async throws -> Void) async throws
  {
    guard !changingAccount, !shuttingDown else {
      throw DesktopFailure("auth_busy", "Wait for the current account change or shutdown to finish")
    }
    let wasOnline = ["online", "connecting", "recovering"].contains(host.status)
    let recordingAvailable = recorder.available
    changingAccount = true
    featureRequestID = nil
    recorder.available = false
    areaSelector.cancel()
    changed()
    defer {
      changingAccount = false
      changed()
    }
    await host.stop()
    await mcp.shutdownAndWait()
    var authenticationStarted = false
    do {
      // Finish delivery with its original identity, or cancel preparation and
      // preserve finalized capture files, before WebKit can change accounts.
      try await recorder.shutdown()
      try Task.checkCancellation()
      authenticationStarted = true
      try await operation()
    } catch {
      var canResume = true
      if authenticationStarted {
        pluginsAvailable = false
        debugAvailable = false
        debugEnabled = false
        do { try await refresh(allowAccountChange: true) } catch {
          canResume = false
          if !(error is CancellationError) { report(error) }
        }
      } else {
        recorder.available = recordingAvailable
      }
      changingAccount = false
      if canResume, wasOnline, ready { host.start() }
      mcp.setContext(
        available: pluginsAvailable, online: ["online", "recovering"].contains(host.status))
      throw error
    }
  }

  func requestPermission(_ name: String) async throws {
    if name == "accessibility" {
      try await refreshPermissions("permissions.request_accessibility")
    } else if name == "screenRecording" {
      try await refreshPermissions("permissions.request_screen_recording")
    } else {
      _ = try await helper.request(
        "permissions.probe_automation", fields: .object(["target": .string(name)]))
      try await refreshPermissions()
    }
    changed()
  }

  private func refreshPermissions(_ kind: String = "permissions.state") async throws {
    do {
      permissions = try DesktopPermissionState.validated(await helper.request(kind))
    } catch {
      permissions = .null
      changed()
      throw error
    }
    changed()
  }

  func setKeepAwake(_ enabled: Bool) throws {
    try preferences.update { $0["keepAwakeEnabled"] = .bool(enabled) }
    try applyKeepAwake()
    changed()
  }
  private func applyKeepAwake() throws {
    if keepAwake && !keepAwakeActive {
      let result = IOPMAssertionCreateWithName(
        kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn), "Okou Desktop Keep Awake" as CFString,
        &keepAwakeAssertion)
      guard result == kIOReturnSuccess else {
        throw DesktopFailure("keep_awake", "Could not prevent display sleep (\(result))")
      }
      keepAwakeActive = true
    } else if !keepAwake && keepAwakeActive {
      IOPMAssertionRelease(keepAwakeAssertion)
      keepAwakeActive = false
    }
  }

  func setFilesystem(_ enabled: Bool) throws {
    try preferences.update { $0["computerUsePlugins"]["filesystem"]["enabled"] = .bool(enabled) }
    changed()
  }
  func addDirectory() throws {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = true
    guard panel.runModal() == .OK else { return }
    let paths = Array(Set(allowedDirectories + panel.urls.map(\.path))).sorted()
    try preferences.update {
      $0["computerUsePlugins"]["filesystem"]["allowedDirectories"] = .strings(paths)
    }
    changed()
  }
  func removeDirectory(_ path: String) throws {
    let paths = allowedDirectories.filter { $0 != path }
    try preferences.update {
      $0["computerUsePlugins"]["filesystem"]["allowedDirectories"] = .strings(paths)
    }
    changed()
  }

  func shutdown() async throws {
    guard !changingAccount else {
      throw DesktopFailure("auth_busy", "Wait for the account change to finish before quitting")
    }
    let wasOnline = ["online", "connecting", "recovering"].contains(host.status)
    let recordingAvailable = recorder.available
    shuttingDown = true
    recorder.available = false
    // Drain claimed work before cancelling permission probes that share its helper.
    await host.stop()
    areaSelector.cancel()
    do {
      try await recorder.shutdown()
    } catch {
      // The user is still in the app after a failed finalization. Keep the
      // existing monitors and capture controls, and restore the host intent.
      shuttingDown = false
      recorder.available = recordingAvailable
      if wasOnline && ready { host.start() }
      changed()
      throw error
    }
    permissionTask?.cancel()
    featuresTask?.cancel()
    await permissionTask?.value
    await featuresTask?.value
    permissionTask = nil
    featuresTask = nil
    await mcp.shutdownAndWait()
    await helper.stop()
    if keepAwakeActive {
      IOPMAssertionRelease(keepAwakeAssertion)
      keepAwakeActive = false
    }
  }
  func run(_ operation: @escaping @MainActor () async throws -> Void) {
    Task { do { try await operation() } catch is CancellationError {} catch { report(error) } }
  }
  func report(_ error: any Error) {
    self.error = error.localizedDescription
    SentrySDK.capture(error: error)
    changed()
  }
  func changed() {
    objectWillChange.send()
    onChange()
  }
}
