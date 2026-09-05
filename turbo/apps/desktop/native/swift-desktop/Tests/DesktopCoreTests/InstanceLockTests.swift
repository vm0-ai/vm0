import DesktopCore
import Foundation
import Testing

@Suite struct InstanceLockTests {
  @Test @MainActor func onlyOneProcessCanOwnTheInstanceAndExitReleasesIt() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("instance.lock")
    var owner = try DesktopInstanceLock.acquire(at: file)
    #expect(owner != nil)
    let script = """
      import fcntl,sys
      with open(sys.argv[1],'w') as file:
          try:
              fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
              print('owned')
          except BlockingIOError: print('blocked')
      """
    func attempt() async throws -> String {
      let data = try await ProcessCommand().run(
        "/usr/bin/env", ["python3", "-c", script, file.path])
      return String(decoding: data, as: UTF8.self)
    }
    #expect(try await attempt() == "blocked\n")
    owner = nil
    #expect(try await attempt() == "owned\n")
    #expect(try DesktopInstanceLock.acquire(at: file) != nil)
  }
}
