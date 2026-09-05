import DesktopCore
import Foundation
import Testing

@Suite struct HostReconnectTests {
  @Test(.timeLimit(.minutes(1))) @MainActor
  func revokedHostDrainsClaimedWorkBeforeRegisteringItsReplacement() async throws {
    let script = try #require(
      Bundle.module.url(
        forResource: "host-reconnect", withExtension: "py", subdirectory: "Fixtures"))
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", script.path])
    defer { helper.close() }
    let server = try await helper.request("server.start")
    let port = Int(try #require(server["port"].number))
    let api = DesktopAPI(
      configuration: try DesktopConfiguration(
        platformURL: "http://127.0.0.1:\(port)", version: "0.46.14", preview: true))
    api.tokenProvider = { _ in "user-token" }
    let commands = ComputerCommands(helper: helper)
    let host = HostRuntime(
      api: api, installationID: UUID().uuidString,
      permissions: { try await helper.request("permissions.state") },
      execute: { command, permissions in await commands.execute(command, permissions: permissions) }
    )
    let (states, continuation) = AsyncStream<String>.makeStream()
    host.onChange = { [weak host] in
      if let host { continuation.yield(host.status) }
    }
    defer { continuation.finish() }
    host.start()
    do {
      for await state in states {
        if state == "unauthenticated" { break }
      }
      #expect(host.executing)
      host.start()
      _ = try await api.request("api/test/release-command")
      let pending = try await api.request("api/test/wait-completion")
      // The external server holds the old completion response. No replacement
      // may register while that claimed command still belongs to the old host.
      #expect(pending["registrations"].number == 1)
      _ = try await api.request("api/test/release-completion")
      let result = try await api.request("api/test/wait-finished")
      #expect(result["events"] == .strings(["start-1", "complete-1", "start-2", "complete-2"]))
      #expect(host.hostID == "host-2")
      await host.stop()
      #expect(host.status == "offline")
      #expect(!host.executing)
    } catch {
      helper.close()
      await host.stop()
      throw error
    }
  }
}
