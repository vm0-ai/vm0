import AppKit
import Darwin
import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

@Suite(.serialized) struct NativeIntegrationTests {
  @MainActor private func waitForState(_ plugins: MCPPlugins, _ status: String) async throws {
    if plugins.states.first?["status"].string == status { return }
    let (stream, continuation) = AsyncStream<[JSON]>.makeStream()
    plugins.onChange = { continuation.yield(plugins.states) }
    let deadline = Task {
      do { try await Task.sleep(for: .seconds(15)) } catch { return }
      continuation.finish()
    }
    defer {
      deadline.cancel()
      continuation.finish()
      plugins.onChange = {}
    }
    for await states in stream {
      if states.first?["status"].string == status { return }
    }
    throw DesktopFailure("test_timeout", "MCP did not reach \(status): \(plugins.states)")
  }

  @Test @MainActor func stdioToolsRecoverAfterARealProcessCrash() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let preferences = try DesktopPreferences(directory: directory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = """
      import json,os,signal,sys
      signal.signal(signal.SIGTERM,signal.SIG_IGN)
      while True:
          line=sys.stdin.readline()
          if not line:
              signal.pause()
              continue
          request=json.loads(line)
          if 'id' not in request: continue
          method=request['method']
          if method=='initialize':
              result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
          elif method=='tools/list':
              result={'tools':[{'name':name,'description':name,'inputSchema':{'type':'object'}} for name in ['echo','crash']]}
          elif method=='tools/call':
              if request['params']['name']=='crash': sys.exit(7)
              result={'content':[{'type':'text','text':json.dumps({'message':request['params']['arguments']['message'],'env':os.environ.get('OKOU_TEST_VALUE'),'privateTokenInherited':'GH_TOKEN' in os.environ,'pid':os.getpid()})}]}
          else: result={}
          print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
      """
    let plugins = MCPPlugins(preferences: preferences)
    defer { plugins.shutdown() }
    let config: JSON = .object([
      "mcpServers": .object([
        "fixture": .object([
          "command": .string("python3"), "args": .strings(["-u", "-c", script]),
          "env": .object(["OKOU_TEST_VALUE": .string("explicit-server-env")]),
        ])
      ])
    ])
    try plugins.importJSON(config.text())
    #expect(plugins.states.first?["enabled"].bool == false)
    plugins.setContext(available: true, online: true)
    try plugins.setEnabled("fixture", true)
    try await waitForState(plugins, "running")
    let listing = await plugins.execute(
      .object(["server": .string("fixture"), "tool": .string("tools/list")]))
    let listed = try JSON.decode(Data(try listing["result"].requireString("content").utf8))
    #expect(listed["server"].string == "fixture")
    #expect(listed["tools"].array.count == 2)
    let command: JSON = .object([
      "server": .string("fixture"), "tool": .string("echo"),
      "arguments": .object(["message": .string("hello")]),
    ])
    let first = await plugins.execute(command)
    let content = try JSON.decode(Data(try first["result"].requireString("content").utf8))
    #expect(content["message"].string == "hello")
    #expect(content["env"].string == "explicit-server-env")
    #expect(content["privateTokenInherited"].bool == false)
    let failed = await plugins.execute(
      .object(["server": .string("fixture"), "tool": .string("crash")]))
    #expect(failed["status"].string == "failed")
    try await waitForState(plugins, "running")
    let recovered = await plugins.execute(command)
    #expect(recovered["status"].string == "succeeded")
    plugins.setContext(available: false, online: true)
    #expect(plugins.capabilities.isEmpty)
    let disabled = await plugins.execute(command)
    #expect(disabled["error"]["code"].string == "feature_disabled")
    let retired = try JSON.decode(Data(try recovered["result"].requireString("content").utf8))
    let retiredPID = pid_t(try #require(retired["pid"].number))
    plugins.setContext(available: true, online: true)
    try await waitForState(plugins, "running")
    #expect(kill(retiredPID, 0) == -1)
    #expect(errno == ESRCH)
    let restarted = await plugins.execute(command)
    let current = try JSON.decode(Data(try restarted["result"].requireString("content").utf8))
    let currentPID = pid_t(try #require(current["pid"].number))
    #expect(currentPID != retiredPID)
    await plugins.shutdownAndWait()
    #expect(kill(currentPID, 0) == -1)
    #expect(errno == ESRCH)
    // Stop again before the newly scheduled connect task gets an actor turn.
    plugins.setContext(available: true, online: true)
    await plugins.shutdownAndWait()
    #expect(plugins.capabilities.isEmpty)
  }

  @Test @MainActor func httpMcpAndWebKitTokenRefreshUseRealBoundaries() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let preferences = try DesktopPreferences(directory: directory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = """
      import json,sys,threading
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      from socketserver import TCPServer
      features_valid=True
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def reply(self,data,status=200,content_type='application/json'):
              self.send_response(status)
              self.send_header('Content-Type',content_type)
              self.send_header('Content-Length',str(len(data)))
              self.end_headers()
              self.wfile.write(data)
          def do_GET(self):
              global features_valid
              if self.path.startswith('/desktop-auth/'):
                  self.reply(b'<html><body><script>window.vm0DesktopAuth.completeSignIn({token:"fixture-same-token"});</script></body></html>',content_type='text/html')
              elif self.path=='/api/auth/me': self.reply(b'{"userId":"fixture-user"}')
              elif self.path=='/api/org': self.reply(b'{"id":"fixture-org","name":"Fixture"}')
              elif self.path=='/api/test/malformed-features': features_valid=False; self.reply(b'{}')
              elif self.path=='/api/feature-switches':
                  flags={'_debug':True,'computerUseDesktopPlugins':True,'introVideo':True}
                  self.reply(json.dumps({'effectiveSwitches':flags,'switches':{}} if features_valid else {'switches':flags}).encode())
              else: self.reply(b'',405)
          def do_DELETE(self): self.reply(b'',204)
          def do_POST(self):
              if self.path=='/api/uploads/prepare': self.reply(b'{"error":"offline fixture"}',503); return
              request=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
              if 'id' not in request: self.reply(b'',202); return
              method=request['method']
              if method=='initialize': result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'http-fixture','version':'1'}}
              elif method=='tools/list': result={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]}
              elif method=='tools/call': result={'content':[{'type':'text','text':'http-works'}]}
              else: result={}
              self.reply(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}).encode())
      class LoopbackServer(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self)
              self.server_name='localhost'
              self.server_port=self.server_address[1]
      server=LoopbackServer(('127.0.0.1',0),Handler)
      threading.Thread(target=server.serve_forever,daemon=True).start()
      for line in sys.stdin:
          request=json.loads(line)
          print(json.dumps({'id':request['id'],'status':'succeeded','result':{'port':server.server_port}}),flush=True)
      """
    let fixture = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { fixture.close() }
    let server = try await fixture.request("server.start")
    let port = Int(try #require(server["port"].number))
    let origin = "http://127.0.0.1:\(port)"
    let plugins = MCPPlugins(preferences: preferences)
    defer { plugins.shutdown() }
    try plugins.importJSON(
      JSON.object(["fixture": .object(["url": .string(origin + "/mcp")])]).text())
    plugins.setContext(available: true, online: true)
    try plugins.setEnabled("fixture", true)
    try await waitForState(plugins, "running")
    let result = await plugins.execute(
      .object(["server": .string("fixture"), "tool": .string("echo")]))
    #expect(result["result"]["content"].string == "http-works")
    let configuration = try DesktopConfiguration(
      platformURL: origin, version: "1.0.0", preview: true)
    let auth = DesktopAuth(configuration: configuration, preferences: preferences)
    #expect(try await auth.getToken(force: false) == "fixture-same-token")
    // A provider may legitimately return the same token; completion, not a
    // string inequality, establishes that the refresh succeeded.
    #expect(try await auth.getToken(force: true) == "fixture-same-token")
    let api = DesktopAPI(configuration: configuration)
    api.tokenProvider = { force in try await auth.getToken(force: force) }
    try await auth.refreshIdentity(api: api)
    #expect(auth.signedIn)
    #expect(auth.organization["id"].string == "fixture-org")
    let recorderScript = """
      import json,pathlib,sys
      output=None
      for line in sys.stdin:
          request=json.loads(line)
          kind=request['kind']
          payload=request['payload']
          if kind=='recorder.capabilities': result={'supportsMicrophone':True}
          elif kind=='recorder.requestPermission': result={'granted':True}
          elif kind=='recorder.sources': result={'sources':[{'id':'display:1','kind':'display','title':'Fixture display'}]}
          elif kind=='recorder.windowPreviews': result={'previews':[]}
          elif kind=='recorder.prepare':
              assert payload['sourceKind']=='display' and payload['sourceId']=='display:1'
              assert payload['systemAudio'] and payload['microphone']
              result={'sessionId':'recording-fixture'}
          elif kind=='recorder.start':
              assert payload['sessionId']=='recording-fixture'
              output=pathlib.Path(payload['outputPath'])
              output.write_bytes(b'recorded frames')
              result={}
          elif kind=='recorder.stop':
              clicks=output.with_suffix('.json');clicks.write_text('[]')
              result={'videoPath':str(output),'clickTrackPath':str(clicks),'durationMs':1000,'sizeBytes':output.stat().st_size,'width':100,'height':100}
          elif kind=='recorder.state': result={'status':'recording','elapsedMs':1000}
          else: result={}
          print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      """
    let recorderHelper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"),
      arguments: ["python3", "-u", "-c", recorderScript], cancelStopsProcess: false)
    defer { recorderHelper.close() }
    let recorder = ScreenRecorder(
      helper: recorderHelper, preferences: preferences, api: api, auth: auth)
    recorder.available = true
    try await recorder.loadSources()
    let source = try #require(recorder.sources.first)
    try await recorder.start(source: source, systemAudio: true, microphone: true)
    #expect(recorder.status == "recording")
    try await recorder.pauseOrResume()
    #expect(recorder.status == "paused")
    try await recorder.pauseOrResume()
    #expect(recorder.status == "recording")
    try await recorder.stop()
    #expect(recorder.status == "ready")
    #expect(recorder.error?.contains("503") == true)
    let recordings = try FileManager.default.contentsOfDirectory(
      at: directory.appendingPathComponent("recordings"), includingPropertiesForKeys: nil)
    #expect(recordings.filter { $0.pathExtension == "mp4" }.count == 1)
    #expect(recordings.filter { $0.pathExtension == "json" }.count == 1)
    try await recorder.deliver()
    #expect(recorder.status == "ready")
    try await recorder.shutdown()
    let helperPath = directory.appendingPathComponent("computer-use-helper")
    let permissionScript = """
      #!/usr/bin/env python3
      import json,sys
      for line in sys.stdin:
          request=json.loads(line)
          print(json.dumps({'id':request['id'],'status':'succeeded','result':{'accessibility':True,'screenRecording':True}}),flush=True)
      """
    try Data(permissionScript.utf8).write(to: helperPath)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helperPath.path)
    let desktop = try DesktopModel(
      configuration: configuration, directory: directory, helperDirectory: directory)
    try await desktop.refresh()
    #expect(desktop.pluginsAvailable && desktop.debugAvailable && desktop.recorder.available)
    desktop.debugEnabled = true
    _ = try await api.request("api/test/malformed-features")
    // A malformed account-scoped response must not activate privileged
    // capabilities from the raw overrides instead of effective permissions.
    await #expect(throws: DecodingError.self) { try await desktop.refresh() }
    #expect(!desktop.pluginsAvailable && !desktop.debugAvailable && !desktop.recorder.available)
    #expect(!desktop.debugEnabled)
    try await desktop.shutdown()
    try await auth.signOut()
    #expect(!auth.signedIn)
    #expect(try await auth.getToken(force: false) == nil)
  }
}
