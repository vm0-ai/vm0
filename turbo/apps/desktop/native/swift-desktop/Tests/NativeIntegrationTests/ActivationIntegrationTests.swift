import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

@Suite struct ActivationIntegrationTests {
  @Test @MainActor func duplicateLaunchForwardsCallbacksToTheExistingOwner() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let identity = "ai.okou.test." + UUID().uuidString
    let (events, continuation) = AsyncStream<[URL]>.makeStream()
    let owner = try DesktopActivation(
      directory: directory, identity: identity,
      receive: { continuation.yield($0) }, report: { Issue.record("\($0)") })
    defer {
      owner.stop()
      continuation.finish()
    }
    #expect(try owner.claim())
    let duplicate = try DesktopActivation(
      directory: directory, identity: identity,
      receive: { _ in Issue.record("Duplicate instance accepted a callback") },
      report: { Issue.record("\($0)") })
    defer { duplicate.stop() }
    #expect(try !duplicate.claim())
    let url = try #require(
      URL(string: "ai.okou.desktop.dev://auth/callback?code=" + String(repeating: "a", count: 32)))
    try duplicate.forward([url])
    let received = await withTaskGroup(of: [URL]?.self) { group in
      group.addTask { await events.first(where: { _ in true }) }
      group.addTask {
        try? await Task.sleep(for: .seconds(10))
        return nil
      }
      let value = await group.next()!
      group.cancelAll()
      return value
    }
    #expect(received == [url])
    let files = try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil)
    #expect(files.allSatisfy { $0.pathExtension != "json" })
    owner.stop()
    #expect(try duplicate.claim())
  }
}
