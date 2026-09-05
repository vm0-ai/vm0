import AppKit
import Darwin
import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

extension NativeIntegrationTests {
  @Test @MainActor func preparationCancellationAndLostSourcesKeepCaptureOwnership() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let preferences = try DesktopPreferences(directory: directory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let serverScript = """
      import json,sys,threading
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      from socketserver import TCPServer
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def do_GET(self):
              if self.path.startswith('/desktop-auth/'):
                  kind='text/html';data=b'<script>window.vm0DesktopAuth.completeSignIn({token:"capture-owner"}).then(()=>window.location.replace("/"));</script>'
              elif self.path=='/': kind='text/html';data=b'<html>Done</html>'
              elif self.path=='/api/auth/me': kind='application/json';data=b'{"userId":"capture-user"}'
              elif self.path=='/api/org': kind='application/json';data=b'{"id":"capture-org"}'
              else: kind='application/json';data=b'{}'
              self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
      class Server(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self);self.server_name='localhost';self.server_port=self.server_address[1]
      server=Server(('127.0.0.1',0),Handler)
      threading.Thread(target=server.serve_forever,daemon=True).start()
      for line in sys.stdin:
          request=json.loads(line)
          print(json.dumps({'id':request['id'],'status':'succeeded','result':{'port':server.server_port}}),flush=True)
      """
    let server = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"),
      arguments: ["python3", "-u", "-c", serverScript])
    defer { server.close() }
    let address = try await server.request("start")
    let configuration = try DesktopConfiguration(
      platformURL: "http://127.0.0.1:\(Int(try #require(address["port"].number)))",
      version: "1.0.0", preview: true)
    let auth = DesktopAuth(configuration: configuration, preferences: preferences)
    let api = DesktopAPI(configuration: configuration)
    api.tokenProvider = { force in try await auth.getToken(force: force) }
    let helperScript = """
      import json,os,pathlib,signal,sys,threading
      signal.signal(signal.SIGTERM,signal.SIG_IGN)
      condition=threading.Condition()
      output_lock=threading.Lock()
      entered=False
      marker=pathlib.Path(sys.argv[1])
      output=None
      stop_failed=False
      def reply(request,result):
          with output_lock: print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      def wait_for_prepare(request):
          with condition: condition.wait_for(lambda:entered,timeout=20)
          reply(request,{'entered':entered,'pid':os.getpid()})
      for line in sys.stdin:
          request=json.loads(line);kind=request['kind']
          if kind=='test.wait':
              threading.Thread(target=wait_for_prepare,args=(request,),daemon=True).start();continue
          if kind=='recorder.prepare':
              if not marker.exists():
                  marker.write_text('prepared')
                  with condition: entered=True;condition.notify_all()
                  continue
              result={'sessionId':'replacement'}
          elif kind=='recorder.start':
              output=pathlib.Path(request['payload']['outputPath']);output.write_bytes(b'frames before source loss');result={}
          elif kind=='recorder.state': result={'status':'failed','elapsedMs':1000,'error':{'code':'source_closed','message':'The source window closed'}}
          elif kind=='recorder.stop':
              if not stop_failed:
                  stop_failed=True
                  reply_value={'id':request['id'],'status':'failed','error':{'code':'capture_failed','message':'Finalization is temporarily unavailable'}}
                  with output_lock: print(json.dumps(reply_value),flush=True)
                  continue
              clicks=output.with_suffix('.json');clicks.write_text('[]')
              result={'videoPath':str(output),'clickTrackPath':str(clicks),'durationMs':1000,'sizeBytes':output.stat().st_size,'width':100,'height':100,'failure':{'code':'source_closed','message':'The source window closed'}}
          else: result={}
          reply(request,result)
      signal.pause()
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"),
      arguments: [
        "python3", "-u", "-c", helperScript, directory.appendingPathComponent("prepared").path,
      ],
      cancelStopsProcess: false)
    defer { helper.close() }
    let recorder = ScreenRecorder(helper: helper, preferences: preferences, api: api, auth: auth)
    recorder.available = true
    let source: JSON = .object([
      "id": .string("window:2"), "kind": .string("window"), "title": .string("Fixture window"),
    ])
    let preparing = Task {
      try await recorder.start(source: source, systemAudio: false, microphone: false)
    }
    let pending = try await helper.request("test.wait")
    #expect(pending["entered"].bool && recorder.status == "preparing")
    let retiredPID = pid_t(try #require(pending["pid"].number))
    recorder.available = false
    let shutdown = Task { try await recorder.shutdown(force: true) }
    recorder.available = true
    // A rapid new start reports that the old preparation is still owned.
    await #expect(throws: DesktopFailure.self) {
      try await recorder.start(source: source, systemAudio: false, microphone: false)
    }
    try await shutdown.value
    await #expect(throws: CancellationError.self) { try await preparing.value }
    #expect(recorder.status == "idle")
    #expect(kill(retiredPID, 0) == -1)
    #expect(errno == ESRCH)
    let (events, continuation) = AsyncStream<String>.makeStream()
    var sawFailedFinalization = false
    recorder.onChange = {
      if recorder.error?.contains("temporarily unavailable") == true {
        sawFailedFinalization = true
      }
      continuation.yield(recorder.status)
    }
    let deadline = Task {
      do { try await Task.sleep(for: .seconds(10)) } catch { return }
      continuation.finish()
    }
    defer {
      deadline.cancel()
      continuation.finish()
      recorder.onChange = {}
    }
    try await recorder.start(source: source, systemAudio: false, microphone: false)
    for await status in events { if status == "ready" { break } }
    #expect(sawFailedFinalization)
    #expect(recorder.status == "ready")
    #expect(recorder.error == "The source window closed")
    let files = try FileManager.default.contentsOfDirectory(
      at: directory.appendingPathComponent("recordings"), includingPropertiesForKeys: nil)
    #expect(files.filter { $0.pathExtension == "mp4" }.count == 1)
    #expect(files.filter { $0.pathExtension == "json" }.count == 1)
    try await recorder.shutdown()
    try await auth.signOut()
  }

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
