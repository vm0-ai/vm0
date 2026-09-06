import AppKit
import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

extension NativeIntegrationTests {
  @Test @MainActor func automationResultsReachTheUIAndHostAndSurvivePermissionRefresh() async throws
  {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let helper = directory.appendingPathComponent("computer-use-helper")
    let script = """
      #!/usr/bin/env python3
      import json,pathlib,sys
      mode=pathlib.Path(__file__).parent/'mode'
      for line in sys.stdin:
          request=json.loads(line)
          state=mode.read_text() if mode.exists() else 'denied'
          result={'accessibility':True,'screenRecording':True}
          if request['kind']=='permissions.probe_automation':
              result={'status':'not_installed','reason':'Target browser is not installed.'} if request['target']=='chrome' else {'status':state,'reason':'Safari test reason'}
          elif state=='invalid-grants': result={}
          elif request['kind']=='keyboard.type_text':
              print(json.dumps({'id':request['id'],'status':'failed','error':{'code':'automation_permission_denied','message':'Safari denied this navigation'}}),flush=True)
              continue
          print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      """
    try Data(script.utf8).write(to: helper)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
    let desktop = try DesktopModel(
      configuration: DesktopConfiguration(
        platformURL: "http://127.0.0.1:1", version: "1.0.0", preview: true),
      directory: directory, helperDirectory: directory)
    defer { desktop.helper.close() }
    try await desktop.requestPermission("safari")
    let denied = desktop.permissions["automation"]["safari"]
    #expect(denied["status"].string == "denied")
    #expect(denied["reason"].string == "Safari test reason")
    #expect(denied["updatedAt"].string.flatMap { ISO8601DateFormatter().date(from: $0) } != nil)
    let firstHostState = try await desktop.host.permissions()
    #expect(firstHostState["automation"]["safari"] == denied)
    try await desktop.requestPermission("chrome")
    #expect(desktop.permissions["automation"]["chrome"]["status"].string == "not_installed")
    try await desktop.requestPermission("accessibility")
    try await desktop.requestPermission("screenRecording")
    #expect(desktop.permissions["automation"]["safari"] == denied)
    let mode = directory.appendingPathComponent("mode")
    try Data("granted".utf8).write(to: mode)
    try await desktop.requestPermission("safari")
    #expect(desktop.permissions["automation"]["safari"]["status"].string == "granted")
    let granted = desktop.permissions["automation"]
    try Data("invalid-status".utf8).write(to: mode)
    await #expect(throws: (any Error).self) { try await desktop.requestPermission("safari") }
    #expect(desktop.permissions["automation"] == granted)
    try Data("invalid-grants".utf8).write(to: mode)
    await #expect(throws: DecodingError.self) { try await desktop.host.permissions() }
    #expect(desktop.permissions == .null && !desktop.ready)
    try Data("granted".utf8).write(to: mode)
    let restored = try await desktop.host.permissions()
    #expect(restored["automation"] == granted)
    let failed = await desktop.host.execute(
      .object([
        "kind": .string("keyboard.type_text"),
        "payload": .object(["app": .string("com.apple.Safari"), "text": .string("fixture")]),
      ]), restored)
    #expect(failed["error"]["code"].string == "automation_permission_denied")
    let afterDenial = try await desktop.host.permissions()
    #expect(afterDenial["automation"]["safari"]["status"].string == "denied")
    #expect(afterDenial["automation"]["safari"]["reason"].string == "Safari denied this navigation")
    #expect(afterDenial["automation"]["chrome"] == granted["chrome"])
  }
}
