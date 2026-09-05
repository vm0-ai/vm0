import Foundation

@MainActor
public final class HostRuntime {
  public private(set) var status = "offline"
  public private(set) var hostID: String?
  public private(set) var lastError: String?
  public private(set) var lastHeartbeat: Date?
  public private(set) var lastCommand: Date?
  public private(set) var commands: [JSON] = []
  public private(set) var errors: [String] = []
  public private(set) var executing = false
  public var onChange: @MainActor () -> Void = {}
  public var capabilities: @MainActor () -> [String] = { ComputerCommands.capabilities }
  public var execute: @MainActor (JSON, JSON) async -> JSON
  public var permissions: @MainActor () async throws -> JSON
  private let api: DesktopAPI
  private let installationID: String
  private var hostToken: String?
  private var wantsOnline = false
  private var startTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var commandTask: Task<Void, Never>?

  public init(
    api: DesktopAPI, installationID: String,
    permissions: @escaping @MainActor () async throws -> JSON,
    execute: @escaping @MainActor (JSON, JSON) async -> JSON
  ) {
    self.api = api
    self.installationID = installationID
    self.permissions = permissions
    self.execute = execute
  }

  public func start() {
    guard !wantsOnline else { return }
    wantsOnline = true
    startTask = Task { [weak self] in
      guard let self else { return }
      var attempt = 0
      while self.wantsOnline && !Task.isCancelled {
        self.status = "connecting"
        self.onChange()
        do {
          let body = try await self.runtimeBody()
          let response = try await self.api.request(
            "api/computer-use/hosts/start", method: "POST", body: body)
          self.hostToken = try response.requireString("hostToken")
          self.hostID = try response.requireString("hostId")
          self.status = "online"
          self.lastError = nil
          self.lastHeartbeat = Date()
          self.onChange()
          self.heartbeatTask = Task { await self.heartbeatLoop() }
          self.commandTask = Task { await self.commandLoop() }
          return
        } catch {
          guard await self.recover(error, attempt: &attempt) else { return }
        }
      }
    }
  }

  /// Stop claiming work, allow a claimed command and its completion to finish,
  /// then revoke the host token. Updates and sign-out use the same drain.
  public func stop() async {
    wantsOnline = false
    startTask?.cancel()
    await startTask?.value
    startTask = nil
    if !executing { commandTask?.cancel() }
    await commandTask?.value
    commandTask = nil
    heartbeatTask?.cancel()
    await heartbeatTask?.value
    heartbeatTask = nil
    let token = hostToken
    hostToken = nil
    hostID = nil
    status = "offline"
    onChange()
    if let token {
      do {
        _ = try await api.request(
          "api/computer-use/host/stop", method: "POST", body: .object([:]), hostToken: token,
          timeout: 10)
      } catch let error as DesktopHTTPError where error.status == 401 {
        // The server has already revoked this host.
      } catch { record(error) }
    }
  }

  private func runtimeBody() async throws -> JSON {
    .object([
      "installationId": .string(installationID),
      "hostName": .string(ProcessInfo.processInfo.hostName),
      "appVersion": .string(api.configuration.version),
      "osVersion": .string(ProcessInfo.processInfo.operatingSystemVersionString),
      "supportedCapabilities": .strings(capabilities()), "permissions": try await permissions(),
    ])
  }

  private func heartbeatLoop() async {
    var attempt = 0
    while !Task.isCancelled, let token = hostToken {
      do {
        try await Task.sleep(for: .seconds(2))
        _ = try await api.request(
          "api/computer-use/heartbeat", method: "POST", body: runtimeBody(), hostToken: token,
          timeout: 10)
        lastHeartbeat = Date()
        attempt = 0
        onChange()
      } catch {
        if !(await recover(error, attempt: &attempt)) { return }
      }
    }
  }

  private func commandLoop() async {
    var attempt = 0
    while wantsOnline && !Task.isCancelled, let token = hostToken {
      do {
        let next = try await api.request(
          "api/computer-use/host/commands/next", method: "POST",
          body: .object(["supportedCapabilities": .strings(capabilities())]), hostToken: token)
        if next["status"].string == "command" {
          let command = next["command"]
          let id = try command.requireString("id")
          executing = true
          let start = Date()
          var log = command
          log["status"] = .string("running")
          commands.insert(log, at: 0)
          commands = Array(commands.prefix(20))
          onChange()
          let result: JSON
          do {
            let currentPermissions =
              command["kind"].string == "plugin.call" ? JSON.object([:]) : try await permissions()
            result = await execute(command, currentPermissions)
          } catch let failure as DesktopFailure {
            result = failure.response
          } catch {
            result = DesktopFailure("helper_unavailable", error.localizedDescription).response
          }
          if let index = commands.firstIndex(where: { $0["id"].string == id }) {
            commands[index]["status"] = result["status"]
            commands[index]["durationMs"] = .number(Date().timeIntervalSince(start) * 1000)
            var summary = result
            for key in ["screenshot", "appState", "elements", "visibleElements", "pluginContent"] {
              var fields = summary["result"].object ?? [:]
              fields.removeValue(forKey: key)
              summary["result"] = .object(fields)
            }
            commands[index]["response"] = summary
          }
          try await complete(id: id, result: result, token: token)
          executing = false
          lastCommand = Date()
          status = "online"
          lastError = nil
          onChange()
        }
        attempt = 0
        let elapsed = lastCommand.map { Date().timeIntervalSince($0) } ?? .infinity
        try await Task.sleep(for: .seconds(elapsed < 10 ? 0.5 : elapsed < 60 ? 1 : 5))
      } catch {
        executing = false
        if !(await recover(error, attempt: &attempt)) { return }
      }
    }
  }

  private func complete(id: String, result: JSON, token: String) async throws {
    for attempt in 0..<3 {
      do {
        _ = try await api.request(
          "api/computer-use/host/commands/\(id)/complete", method: "POST", body: result,
          hostToken: token, timeout: 60)
        return
      } catch let error as DesktopHTTPError where error.status == 409 { return } catch {
        if attempt == 2 { throw error }
        if let http = error as? DesktopHTTPError, !http.retryable { throw error }
        try await Task.sleep(for: .seconds(2))
      }
    }
  }

  private func recover(_ error: any Error, attempt: inout Int) async -> Bool {
    if error is CancellationError || Task.isCancelled { return false }
    record(error)
    if let http = error as? DesktopHTTPError, !http.retryable {
      status = http.status == 401 ? "unauthenticated" : http.status == 403 ? "disabled" : "error"
      wantsOnline = false
      hostToken = nil
      hostID = nil
      onChange()
      return false
    }
    guard wantsOnline else { return false }
    attempt += 1
    status = "recovering"
    onChange()
    let delay =
      (error as? DesktopHTTPError)?.retryAfter ?? min(60, 2 * pow(2, Double(min(attempt - 1, 5))))
    do {
      try await Task.sleep(for: .seconds(delay))
      return true
    } catch { return false }
  }

  private func record(_ error: any Error) {
    lastError = error.localizedDescription
    errors.insert(error.localizedDescription, at: 0)
    errors = Array(errors.prefix(20))
    onChange()
  }
}
