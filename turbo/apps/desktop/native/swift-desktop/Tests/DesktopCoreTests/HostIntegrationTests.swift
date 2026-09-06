import DesktopCore
import Foundation
import Testing

@Suite struct HostIntegrationTests {
  @Test(arguments: [false, true]) @MainActor
  func registeredHostExecutesAndCompletesQueuedCommand(permissionFailure: Bool) async throws {
    // The fake boundary is a real HTTP server and a real JSON-lines process.
    // DesktopAPI, HostRuntime and ComputerCommands all use their production paths.
    let script = """
      import json, socket, sys, threading
      from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
      from socketserver import TCPServer
      done = threading.Event()
      completed = {}
      issued = False
      permission_calls = 0
      registrations = 0
      registered_host_name = None
      fail_permissions = sys.argv[1] == 'true'
      class Handler(BaseHTTPRequestHandler):
          def log_message(self, *args): pass
          def respond(self, body, status=200):
              data=json.dumps(body).encode()
              self.send_response(status)
              self.send_header('Content-Type','application/json')
              if status==503: self.send_header('Retry-After','0.01')
              self.send_header('Content-Length',str(len(data)))
              self.end_headers()
              self.wfile.write(data)
          def do_GET(self):
              if self.path == '/api/test/wait-complete':
                  if not done.wait(10):
                      self.respond({'error':'No command completed'},500)
                  else: self.respond(completed)
              else: self.respond({'userId':'user-test','email':'test@example.invalid'})
          def do_POST(self):
              global issued,completed,registrations,registered_host_name
              body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
              if self.path == '/api/computer-use/hosts/start':
                  registrations+=1
                  registered_host_name=body.get('hostName')
                  if registrations==1: self.respond({},503);return
                  if self.headers.get('Authorization') != 'Bearer user-token':
                      self.respond({},401); return
                  self.respond({'hostId':'host-test','hostToken':'host-token'}); return
              if self.headers.get('Authorization') != 'Bearer host-token':
                  self.respond({},401); return
              if self.path.endswith('/commands/next'):
                  if issued: self.respond({'status':'idle'})
                  else:
                      issued=True
                      self.respond({'status':'command','command':{'id':'command-test','kind':'apps.list','payload':{}}})
              elif self.path.endswith('/complete'):
                  completed={'body':body,'clientType':self.headers.get('X-Client-Type'),'product':self.headers.get('X-Client-Product'),'version':self.headers.get('X-Client-Version'),'registeredHostName':registered_host_name,'systemHostName':' '.join(socket.gethostname().split())}
                  self.respond({})
                  done.set()
              else: self.respond({})
      class LoopbackServer(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self)
              self.server_name='localhost'
              self.server_port=self.server_address[1]
      server=LoopbackServer(('127.0.0.1',0),Handler)
      threading.Thread(target=server.serve_forever,daemon=True).start()
      for line in sys.stdin:
          request=json.loads(line)
          if request['kind']=='server.start': result={'port':server.server_port}
          elif request['kind']=='permissions.state':
              permission_calls += 1
              if fail_permissions and issued:
                  print(json.dumps({'id':request['id'],'status':'failed','error':{'code':'helper_unavailable','message':'Permission probe failed'}}),flush=True)
                  continue
              result={'accessibility':True,'screenRecording':True}
          elif request['kind']=='apps.list': result={'apps':[{'name':'Notes','bundleId':'com.apple.Notes'}],'appState':'fixture-state','screenshot':'fixture-image','elements':[],'visibleElements':[],'pluginContent':'plugin-summary'}
          else: raise RuntimeError('Unexpected helper command')
          print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"),
      arguments: ["python3", "-u", "-c", script, String(permissionFailure)])
    defer { helper.close() }
    let server = try await helper.request("server.start")
    let port = Int(try #require(server["port"].number))
    let configuration = try DesktopConfiguration(
      platformURL: "http://127.0.0.1:\(port)", version: "0.46.12", preview: true)
    let api = DesktopAPI(configuration: configuration)
    api.tokenProvider = { _ in "user-token" }
    let commands = ComputerCommands(helper: helper)
    let host = HostRuntime(
      api: api, installationID: UUID().uuidString,
      permissions: { try await helper.request("permissions.state") },
      execute: { command, permissions in
        await commands.execute(command, permissions: permissions)
      })
    var retry: HostRuntime.Recovery?
    host.onChange = { if let current = host.recovery { retry = current } }
    host.start()
    let completion = try await api.request("api/test/wait-complete")
    await host.stop()
    let recovery = try #require(retry)
    #expect(recovery.phase == .start && recovery.attempt == 1)
    #expect(recovery.retryDelay == 0.01)
    #expect(recovery.nextRetryAt > recovery.lastRetryAt)
    #expect(host.recovery == nil)
    #expect(host.errors.first?.phase == .start)
    let log = try #require(host.commands.first)
    #expect(log["startedAt"].string != nil && log["completedAt"].string != nil)
    #expect(try #require(log["durationMs"].number) >= 0)
    if permissionFailure {
      #expect(completion["body"]["status"].string == "failed")
      #expect(completion["body"]["error"]["code"].string == "accessibility_unavailable")
    } else {
      #expect(completion["body"]["status"].string == "succeeded")
      #expect(completion["body"]["result"]["apps"].array.first?["name"].string == "Notes")
      #expect(completion["body"]["result"]["screenshot"].string == "fixture-image")
      let summary = log["response"]["result"]
      #expect(summary["screenshot"] == .null && summary["appState"] == .null)
      #expect(summary["pluginContent"].string == "plugin-summary")
      #expect(
        summary["omittedResultFields"]
          == .strings(["appState", "elements", "screenshot", "visibleElements"]))
    }
    #expect(completion["clientType"].string == "Desktop")
    #expect(completion["product"].string == "okou")
    #expect(completion["version"].string == "0.46.12")
    #expect(
      try completion.requireString("registeredHostName")
        == completion.requireString("systemHostName"))
    #expect(host.status == "offline")
    #expect(host.hostID == nil)
  }

  @Test @MainActor func updateArchiveRejectsTraversalBeforeExtraction() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = """
      import pathlib, sys, zipfile
      root=pathlib.Path(sys.argv[1])
      with zipfile.ZipFile(root/'good.zip','w') as z: z.writestr('Okou.app/Contents/Info.plist','test')
      with zipfile.ZipFile(root/'bad.zip','w') as z: z.writestr('Okou.app/../../outside','test')
      """
    _ = try await ProcessCommand().run("/usr/bin/env", ["python3", "-c", script, directory.path])
    #expect(
      try UpdateArchive.validate(directory.appendingPathComponent("good.zip"), appName: "Okou.app")
        .isEmpty)
    #expect(throws: DesktopFailure.self) {
      try UpdateArchive.validate(directory.appendingPathComponent("bad.zip"), appName: "Okou.app")
    }
    #expect(throws: DesktopFailure.self) { try UpdateArchive.validateLink("../../outside") }
    #expect(throws: DesktopFailure.self) { try UpdateArchive.validateLink("/tmp/outside") }
    try UpdateArchive.validateLink("Versions/Current/Resources")
  }
}
