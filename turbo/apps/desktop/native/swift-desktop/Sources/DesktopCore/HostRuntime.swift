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
  private var connection: Connection?

  private final class Connection {
    var accepting = true
    var executing = false
    var token: String?
    var startTask: Task<Void, Never>?
    var heartbeatTask: Task<Void, Never>?
    var commandTask: Task<Void, Never>?
    var stopTask: Task<Void, Never>?
  }

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
    guard connection?.accepting != true else { return }
    let previous = connection
    let next = Connection()
    connection = next
    hostID = nil
    status = "connecting"
    onChange()
    next.startTask = Task { [weak self] in
      guard let self else { return }
      // A replacement cannot register until claimed work from the previous
      // connection has completed and its heartbeat/process ownership is joined.
      if let previous { await self.drain(previous) }
      guard next.accepting, !Task.isCancelled else { return }
      self.executing = false
      var attempt = 0
      while next.accepting && !Task.isCancelled {
        self.status = "connecting"
        self.onChange()
        do {
          let body = try await self.runtimeBody()
          try Task.checkCancellation()
          let response = try await self.api.request(
            "api/computer-use/hosts/start", method: "POST", body: body)
          next.token = try response.requireString("hostToken")
          guard next.accepting, !Task.isCancelled else { return }
          self.hostID = try response.requireString("hostId")
          self.status = "online"
          self.lastError = nil
          self.lastHeartbeat = Date()
          self.onChange()
          next.heartbeatTask = Task { await self.heartbeatLoop(next) }
          next.commandTask = Task { await self.commandLoop(next) }
          return
        } catch {
          guard await self.recover(error, attempt: &attempt, connection: next) else { return }
        }
      }
    }
  }

  /// Stop claiming work, allow a claimed command and its completion to finish,
  /// then revoke the host token. Updates and sign-out use the same drain.
  public func stop() async {
    guard let stopped = connection else { return }
    await drain(stopped)
    guard connection === stopped else { return }
    connection = nil
    executing = false
    hostID = nil
    status = "offline"
    onChange()
  }

  private func drain(_ stopped: Connection) async {
    if let task = stopped.stopTask {
      await task.value
      return
    }
    stopped.accepting = false
    stopped.startTask?.cancel()
    let task = Task {
      await stopped.startTask?.value
      stopped.startTask = nil
      if !stopped.executing { stopped.commandTask?.cancel() }
      await stopped.commandTask?.value
      stopped.commandTask = nil
      stopped.heartbeatTask?.cancel()
      await stopped.heartbeatTask?.value
      stopped.heartbeatTask = nil
      await self.revoke(stopped)
    }
    stopped.stopTask = task
    await task.value
  }

  private func revoke(_ stopped: Connection) async {
    if let token = stopped.token {
      stopped.token = nil
      do {
        _ = try await api.request(
          "api/computer-use/host/stop", method: "POST", body: .object([:]), hostToken: token,
          timeout: 10)
      } catch let error as DesktopHTTPError where error.status == 401 {
        // The server has already revoked this host.
      } catch {
        if connection === stopped { record(error) }
      }
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

  private func heartbeatLoop(_ current: Connection) async {
    var attempt = 0
    while !Task.isCancelled, let token = current.token {
      do {
        try await Task.sleep(for: .seconds(2))
        _ = try await api.request(
          "api/computer-use/heartbeat", method: "POST", body: runtimeBody(), hostToken: token,
          timeout: 10)
        if connection === current { lastHeartbeat = Date() }
        attempt = 0
        onChange()
      } catch {
        if !(await recover(error, attempt: &attempt, connection: current)) { return }
      }
    }
  }

  private func commandLoop(_ current: Connection) async {
    var attempt = 0
    while current.accepting && !Task.isCancelled, let token = current.token {
      do {
        let next = try await api.request(
          "api/computer-use/host/commands/next", method: "POST",
          body: .object(["supportedCapabilities": .strings(capabilities())]), hostToken: token)
        if next["status"].string == "command" {
          let command = next["command"]
          let id = try command.requireString("id")
          current.executing = true
          if connection === current { executing = true }
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
          current.executing = false
          if connection === current { executing = false }
          lastCommand = Date()
          if connection === current, current.accepting {
            status = "online"
            lastError = nil
          }
          onChange()
        }
        guard current.accepting else { return }
        attempt = 0
        let elapsed = lastCommand.map { Date().timeIntervalSince($0) } ?? .infinity
        try await Task.sleep(for: .seconds(elapsed < 10 ? 0.5 : elapsed < 60 ? 1 : 5))
      } catch {
        current.executing = false
        if connection === current { executing = false }
        if !(await recover(error, attempt: &attempt, connection: current)) { return }
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

  private func recover(_ error: any Error, attempt: inout Int, connection current: Connection)
    async -> Bool
  {
    if error is CancellationError || Task.isCancelled { return false }
    if connection === current { record(error) }
    if let http = error as? DesktopHTTPError, !http.retryable {
      current.accepting = false
      if connection === current {
        status = http.status == 401 ? "unauthenticated" : http.status == 403 ? "disabled" : "error"
        hostID = nil
        onChange()
      }
      return false
    }
    guard current.accepting || current.executing else { return false }
    attempt += 1
    if connection === current { status = "recovering" }
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
