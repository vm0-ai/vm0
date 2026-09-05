import AppKit
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
      import json,os,sys
      for line in sys.stdin:
          request=json.loads(line)
          if 'id' not in request: continue
          method=request['method']
          if method=='initialize':
              result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
          elif method=='tools/list':
              result={'tools':[{'name':name,'description':name,'inputSchema':{'type':'object'}} for name in ['echo','crash']]}
          elif method=='tools/call':
              if request['params']['name']=='crash': sys.exit(7)
              result={'content':[{'type':'text','text':json.dumps({'message':request['params']['arguments']['message'],'env':os.environ.get('OKOU_TEST_VALUE'),'privateTokenInherited':'GH_TOKEN' in os.environ})}]}
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
  }

  @Test @MainActor func httpMcpAndWebKitTokenRefreshUseRealBoundaries() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let preferences = try DesktopPreferences(directory: directory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = """
      import json,sys,threading
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def reply(self,data,status=200,content_type='application/json'):
              self.send_response(status)
              self.send_header('Content-Type',content_type)
              self.send_header('Content-Length',str(len(data)))
              self.end_headers()
              self.wfile.write(data)
          def do_GET(self):
              if self.path.startswith('/desktop-auth/'):
                  self.reply(b'<html><body><script>window.vm0DesktopAuth.completeSignIn({token:"fixture-same-token"});</script></body></html>',content_type='text/html')
              elif self.path=='/api/auth/me': self.reply(b'{"userId":"fixture-user"}')
              elif self.path=='/api/org': self.reply(b'{"id":"fixture-org","name":"Fixture"}')
              else: self.reply(b'',405)
          def do_DELETE(self): self.reply(b'',204)
          def do_POST(self):
              request=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
              if 'id' not in request: self.reply(b'',202); return
              method=request['method']
              if method=='initialize': result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'http-fixture','version':'1'}}
              elif method=='tools/list': result={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]}
              elif method=='tools/call': result={'content':[{'type':'text','text':'http-works'}]}
              else: result={}
              self.reply(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}).encode())
      server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
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
    try await auth.signOut()
    #expect(!auth.signedIn)
    #expect(try await auth.getToken(force: false) == nil)
  }
}
