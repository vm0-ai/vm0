import DesktopCore
import Foundation
import Testing

@Suite struct HostStopTests {
  @Test(.timeLimit(.minutes(1))) @MainActor
  func userStopReportsClaimedCommandAndRevokesWithoutDraining() async throws {
    let script = try #require(
      Bundle.module.url(forResource: "host-stop", withExtension: "py", subdirectory: "Fixtures"))
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
      for await _ in states where host.executing { break }
      #expect(host.hostID == "host-1")
      let began = ContinuousClock.now
      // The claimed command is still held by the external helper; a user Stop
      // must not wait for it, unlike a replacement registration.
      await host.stop()
      #expect(ContinuousClock.now - began < .seconds(3))
      #expect(host.status == "offline")
      #expect(!host.executing)
      #expect(host.hostID == nil)
      let stopped = try await api.request("api/test/events")
      #expect(stopped["events"] == .strings(["start-1", "complete-1:failed:no_host", "stop-1"]))
      _ = try await api.request("api/test/release-command")
      let late = try await api.request("api/test/wait-late")
      let events = late["events"].array.compactMap(\.string).filter { $0 != "late-complete-1" }
      #expect(events == ["start-1", "complete-1:failed:no_host", "stop-1"])
      #expect(late["registrations"].number == 1)
      #expect(host.status == "offline")
      #expect(host.errors.isEmpty)
    } catch {
      helper.close()
      await host.stop()
      throw error
    }
  }
}
