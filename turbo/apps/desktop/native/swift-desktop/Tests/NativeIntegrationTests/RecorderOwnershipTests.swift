import AppKit
import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

extension NativeIntegrationTests {
  @Test @MainActor func sourceLoadingCannotRestoreADisabledOrNewerPicker() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = """
      import json,sys,threading
      condition=threading.Condition()
      release=threading.Event()
      output=threading.Lock()
      held=False
      def reply(request,result):
          with output:
              print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      def delayed(request):
          global held
          with condition: held=True;condition.notify_all()
          release.wait(20)
          reply(request,{'supportsMicrophone':False})
      def wait_for_request(request):
          with condition: condition.wait_for(lambda:held,timeout=20)
          reply(request,{'held':held})
      for line in sys.stdin:
          request=json.loads(line)
          kind=request['kind']
          if kind=='recorder.capabilities' and not held:
              threading.Thread(target=delayed,args=(request,),daemon=True).start()
              continue
          if kind=='test.wait':
              threading.Thread(target=wait_for_request,args=(request,),daemon=True).start()
              continue
          elif kind=='test.release': release.set();result={}
          elif kind=='recorder.capabilities': result={'supportsMicrophone':True}
          elif kind=='recorder.requestPermission': result={'granted':True}
          elif kind=='recorder.sources': result={'sources':[{'id':'display:2','kind':'display','title':'New display'}]}
          elif kind=='recorder.windowPreviews': result={'previews':[]}
          else: result={}
          reply(request,result)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"),
      arguments: ["python3", "-u", "-c", script], cancelStopsProcess: false)
    defer { helper.close() }
    let configuration = try DesktopConfiguration(
      platformURL: "http://127.0.0.1:1", version: "1.0.0", preview: true)
    let preferences = try DesktopPreferences(directory: directory)
    let recorder = ScreenRecorder(
      helper: helper, preferences: preferences, api: DesktopAPI(configuration: configuration),
      auth: DesktopAuth(configuration: configuration, preferences: preferences))
    recorder.available = true
    let oldPicker = Task { try await recorder.loadSources() }
    let waiting = try await helper.request("test.wait")
    #expect(waiting["held"].bool)
    recorder.available = false
    #expect(recorder.sources.isEmpty)
    recorder.available = true
    try await recorder.loadSources()
    _ = try await helper.request("test.release")
    await #expect(throws: CancellationError.self) { try await oldPicker.value }
    #expect(recorder.sources.first?["id"].string == "display:2")
    #expect(recorder.microphoneSupported)
  }
}
