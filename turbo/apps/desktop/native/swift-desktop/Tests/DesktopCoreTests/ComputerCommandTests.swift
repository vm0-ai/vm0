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

  @Test @MainActor func commandsPreserveSnapshotTargetsAndPostActionState() async throws {
    let script = """
      import json,sys
      for line in sys.stdin:
          request=json.loads(line)
          kind=request['kind']
          if kind=='apps.list': result={'apps':[{'name':'Notes'}]}
          elif kind=='app.state':
              result={'app':'Notes','snapshotId':request['snapshotId'],'screenshot':'aW1hZ2U=','screenshotSource':'window','screenshotWidth':100,'screenshotHeight':100,'screenshotSourceBounds':{'x':0,'y':0,'width':100,'height':100},'windowId':1,'windowFrame':{'x':0,'y':0,'width':100,'height':100},'elements':[{'role':'AXButton','id':'opaque-button','name':'Save','actions':['AXPress']}],'settled':request.get('settle',False)}
          else:
              if 'elementIndex' in request:
                  assert request['elementId']=='opaque-button'
                  assert request.get('snapshotId')
              if kind=='element.click' and 'x' in request:
                  assert request['screenshotSource']=='window'
                  assert request['sourceBounds']['width']==100
              result={'received':request,'normalizedKey':request.get('key')}
          print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
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
