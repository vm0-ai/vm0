import DesktopCore
import Foundation
import Testing

@Suite struct DesktopIntegrationTests {
  @Test @MainActor func malformedHelperRepliesRejectTheirRequestAndAllowRestart() async throws {
    let script = """
      import json,sys
      for line in sys.stdin:
          request=json.loads(line)
          if request['kind']=='malformed': response={'id':request['id'],'status':'failed','error':{'message':'Missing code'}}
          else: response={'id':request['id'],'status':'succeeded','result':{'accessibility':True}}
          print(json.dumps(response),flush=True)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { helper.close() }
    _ = try await helper.request("permissions.state")
    let before = helper.generation
    await #expect(throws: DecodingError.self) { try await helper.request("malformed") }
    #expect(try await helper.request("permissions.state")["accessibility"].bool)
    #expect(helper.generation > before)
  }

  @Test @MainActor func preferenceRoundTripPreservesExistingInstallation() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let preferences = try DesktopPreferences(directory: directory)
    let id = try preferences.installationID()
    try preferences.update { $0["keepAwakeEnabled"] = .bool(true) }
    let reopened = try DesktopPreferences(directory: directory)
    #expect(try reopened.installationID() == id)
    #expect(reopened.value["keepAwakeEnabled"].bool)
  }

  @Test func filesystemCommandsEnforceDirectoryGrants() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let granted = root.appendingPathComponent("granted")
    try FileManager.default.createDirectory(at: granted, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let secret = root.appendingPathComponent("outside.txt")
    try Data("outside".utf8).write(to: secret)
    try FileManager.default.createSymbolicLink(
      at: granted.appendingPathComponent("escape"), withDestinationURL: root)
    let tools = FilesystemTools()
    func call(_ tool: String, _ args: [String: JSON]) async -> JSON {
      await tools.execute(
        .object(["tool": .string(tool), "arguments": .object(args)]),
        allowedDirectories: [granted.path])
    }
    let file = granted.appendingPathComponent("note.txt")
    let write = await call(
      "write_file", ["path": .string(file.path), "content": .string("hello\nworld")])
    #expect(write["status"].string == "succeeded")
    let read = await call("read_text_file", ["path": .string(file.path), "head": .number(1)])
    #expect(read["result"]["content"].string == "hello")
    let denied = await call(
      "read_text_file", ["path": .string(granted.appendingPathComponent("escape/outside.txt").path)]
    )
    #expect(denied["error"]["code"].string == "path_denied")
    let deniedWrite = await call(
      "write_file",
      [
        "path": .string(granted.appendingPathComponent("escape/new.txt").path),
        "content": .string("must not write"),
      ])
    #expect(deniedWrite["error"]["code"].string == "path_denied")
    #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("new.txt").path))
    let dryRun = await call(
      "edit_file",
      [
        "path": .string(file.path), "dryRun": .bool(true),
        "edits": .array([.object(["oldText": .string("hello"), "newText": .string("changed")])]),
      ])
    #expect(dryRun["status"].string == "succeeded")
    #expect(try String(contentsOf: file, encoding: .utf8) == "hello\nworld")
  }

  @Test func callbackAndServiceOriginsRemainCompatible() throws {
    for reference in ["staging", "pr-31838"] {
      let preview = try DesktopConfiguration(
        platformURL: "https://\(reference)-app-okou-app-preview.vm0.workers.dev", version: "0.46.15"
      )
      #expect(preview.apiURL.absoluteString == "https://\(reference)-api.vm6.ai")
      #expect(preview.webURL.absoluteString == "https://\(reference)-www.omby.ai")
      #expect(preview.signInURL.host == "\(reference)-www.omby.ai")
      #expect(preview.bundleID == "ai.okou.desktop.dev")
    }
    let config = try DesktopConfiguration(platformURL: "https://app.okou.ai", version: "0.46.12")
    #expect(config.apiURL.absoluteString == "https://api.vm0.ai")
    #expect(config.webURL.absoluteString == "https://www.vm0.ai")
    let code = String(repeating: "a", count: 32)
    #expect(
      config.callback(URL(string: "ai.okou.desktop://auth/callback?code=\(code)")!)?.code == code)
    #expect(
      config.callback(URL(string: "ai.okou.desktop.dev://auth/callback?code=\(code)")!) == nil)
    #expect(
      !config.allowsAuthPage(URL(string: "https://www.vm0.ai.attacker.example/desktop-auth/token")!)
    )
    let preview = try DesktopConfiguration(
      platformURL: "https://pr-123-app.omby.ai", version: "0.46.12", preview: true)
    #expect(preview.apiURL.host == "pr-123-api.vm6.ai")
    #expect(preview.bundleID == "ai.okou.desktop.dev")
  }

  @Test @MainActor func helperRequestsUseRealProcessAndPropagateFailures() async throws {
    let script = """
      import json,sys
      for line in sys.stdin:
          request=json.loads(line)
          if request['kind']=='permissions.state':
              response={'id':request['id'],'status':'succeeded','result':{'accessibility':True,'screenRecording':False}}
          else:
              response={'id':request['id'],'status':'failed','error':{'code':'permission_denied','message':'No grant'}}
          print(json.dumps(response),flush=True)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { helper.close() }
    let permissions = try await helper.request("permissions.state")
    #expect(permissions["accessibility"].bool)
    #expect(!permissions["screenRecording"].bool)
    await #expect(throws: DesktopFailure.self) { try await helper.request("app.state") }
    let again = try await helper.request("permissions.state")
    #expect(again == permissions)
  }
}
