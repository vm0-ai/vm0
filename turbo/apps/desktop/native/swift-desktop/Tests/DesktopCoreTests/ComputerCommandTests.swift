import DesktopCore
import Foundation
import Testing

@Suite struct ComputerCommandTests {
  @Test(arguments: ["target_app_unresponsive", "browser_navigation_failed"]) @MainActor
  func helperLocalErrorsUseTheExistingApiFailureCode(code: String) async throws {
    let script = """
      import json,sys
      for line in sys.stdin:
          request=json.loads(line)
          print(json.dumps({'id':request['id'],'status':'failed','error':{'code':sys.argv[1],'message':'Native target failed'}}),flush=True)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"),
      arguments: ["python3", "-u", "-c", script, code])
    defer { helper.close() }
    let response = await ComputerCommands(helper: helper).execute(
      .object(["kind": .string("app.open"), "payload": .object(["app": .string("Notes")])]),
      permissions: .object(["accessibility": .bool(true), "screenRecording": .bool(true)]))
    #expect(response["status"].string == "failed")
    #expect(response["error"]["code"].string == "accessibility_unavailable")
    #expect(response["error"]["message"].string == "Native target failed")
  }

  @Test(arguments: ["app", "snapshotId", "elements", "windowFrame", "screenshotWidth"])
  @MainActor func malformedSnapshotsNeverBecomeElementTargets(field: String) async throws {
    let script = try #require(
      Bundle.module.url(
        forResource: "computer-command", withExtension: "py", subdirectory: "Fixtures"))
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"),
      arguments: ["python3", "-u", script.path, field])
    defer { helper.close() }
    let runtime = ComputerCommands(helper: helper)
    let permissions: JSON = .object(["accessibility": .bool(true), "screenRecording": .bool(true)])
    let state = await runtime.execute(
      .object(["kind": .string("app.state"), "payload": .object(["app": .string("Notes")])]),
      permissions: permissions)
    #expect(state["error"]["code"].string == "accessibility_unavailable")
    let click = await runtime.execute(
      .object([
        "kind": .string("element.click"),
        "payload": .object(["app": .string("Notes"), "elementIndex": .number(0)]),
      ]), permissions: permissions)
    #expect(click["error"]["code"].string == "unsupported_command")
  }

  @Test @MainActor func commandsPreserveSnapshotTargetsAndPostActionState() async throws {
    let script = try #require(
      Bundle.module.url(
        forResource: "computer-command", withExtension: "py", subdirectory: "Fixtures"))
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", script.path])
    defer { helper.close() }
    let runtime = ComputerCommands(helper: helper)
    let permissions: JSON = .object(["accessibility": .bool(true), "screenRecording": .bool(true)])
    func call(_ kind: String, _ fields: [String: JSON] = [:]) async -> JSON {
      var payload = fields
      payload["app"] = .string("Notes")
      return await runtime.execute(
        .object(["kind": .string(kind), "payload": .object(payload)]), permissions: permissions)
    }
    let apps = await call("apps.list")
    #expect(apps["result"]["apps"].array.first?["name"].string == "Notes")
    let initial = await call("app.state")
    #expect(initial["result"]["appState"].string?.contains("Save") == true)
    let cases: [(String, [String: JSON])] = [
      ("app.open", [:]),
      ("element.click", ["elementIndex": .number(0)]),
      ("element.click", ["x": .number(25), "y": .number(30)]),
      ("element.scroll", ["elementIndex": .number(0), "direction": .string("down")]),
      ("element.set_value", ["elementIndex": .number(0), "value": .string("edited")]),
      ("element.perform_action", ["elementIndex": .number(0), "action": .string("AXPress")]),
      ("keyboard.type_text", ["text": .string("hello")]),
      ("keyboard.press_key", ["key": .string("CMD+S")]),
    ]
    for (kind, payload) in cases {
      let response = await call(kind, payload)
      #expect(response["status"].string == "succeeded", "\(kind): \(response)")
      #expect(response["result"]["screenshot"].string == "aW1hZ2U=")
      #expect(response["result"]["settled"].bool)
      #expect(response["result"]["action"]["received"]["kind"].string == kind)
    }
    let invalid = await call("element.scroll", ["direction": .string("down")])
    #expect(invalid["error"]["code"].string == "unsupported_command")
    helper.close()
    let stale = await call("element.click", ["elementIndex": .number(0)])
    #expect(stale["error"]["code"].string == "unsupported_command")
    let refreshed = await call("app.state")
    #expect(refreshed["status"].string == "succeeded")
    let recovered = await call("element.click", ["elementIndex": .number(0)])
    #expect(recovered["status"].string == "succeeded")
  }
}
