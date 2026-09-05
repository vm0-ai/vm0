import AppKit
import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

extension NativeIntegrationTests {
  @Test @MainActor func cancelledAndSupersededWebKitWorkCannotOwnANewSession() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = """
      import json,sys,threading
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      from socketserver import TCPServer
      condition=threading.Condition()
      release=threading.Event()
      hold_identity=False
      identity_started=False
      generation=0
      requests=0
      expired=False
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def reply(self,data,status=200,kind='application/json'):
              self.send_response(status)
              self.send_header('Content-Type',kind)
              self.send_header('Content-Length',str(len(data)))
              self.end_headers()
              try: self.wfile.write(data)
              except (BrokenPipeError,ConnectionResetError): pass
          def do_GET(self):
              global generation,requests,identity_started,expired
              if self.path.startswith('/desktop-auth/'):
                  with condition:
                      requests+=1
                      if self.path.startswith('/desktop-auth/select-org'): generation+=1
                      expired=False
                      token=f'fixture-{generation}'
                  self.reply(('<script>window.vm0DesktopAuth.completeSignIn({token:'+json.dumps(token)+'});</script>').encode(),kind='text/html')
                  return
              token=self.headers.get('Authorization','').removeprefix('Bearer ')
              owner=token.removeprefix('fixture-')
              if expired: self.reply(b'{}',401); return
              if self.path=='/api/auth/me':
                  with condition:
                      held=hold_identity and not identity_started
                      if held:
                          identity_started=True
                          condition.notify_all()
                  if held: release.wait(20)
                  self.reply(json.dumps({'userId':'user-'+owner,'email':'fixture@example.test'}).encode())
              elif self.path=='/api/org': self.reply(json.dumps({'id':'org-'+owner,'name':'Fixture'}).encode())
              else: self.reply(b'{}',404)
      class Server(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self)
              self.server_name='localhost'
              self.server_port=self.server_address[1]
      server=Server(('127.0.0.1',0),Handler)
      threading.Thread(target=server.serve_forever,daemon=True).start()
      for line in sys.stdin:
          command=json.loads(line)
          kind=command['kind']
          if kind=='hold': hold_identity=True
          elif kind=='wait':
              with condition: condition.wait_for(lambda:identity_started,timeout=20)
          elif kind=='release': hold_identity=False;release.set()
          elif kind=='expire': expired=True
          print(json.dumps({'id':command['id'],'status':'succeeded','result':{'port':server.server_port,'requests':requests,'identityStarted':identity_started}}),flush=True)
      """
    let server = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { server.close() }
    let address = try await server.request("start")
    let configuration = try DesktopConfiguration(
      platformURL: "http://127.0.0.1:\(Int(try #require(address["port"].number)))",
      version: "1.0.0", preview: true)
    let auth = try DesktopAuth(
      configuration: configuration, preferences: DesktopPreferences(directory: directory))
    let cancelled = Task { try await auth.getToken(force: true) }
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    let untouched = try await server.request("inspect")
    #expect(untouched["requests"].number == 0)
    #expect(try await auth.getToken(force: true) == "fixture-0")
    let api = DesktopAPI(configuration: configuration)
    api.tokenProvider = { force in try await auth.getToken(force: force) }
    try await auth.refreshIdentity(api: api)
    let original = try auth.identity()
    _ = try await server.request("expire")
    // Upload authorization renews an expired bearer, then validates the renewed
    // bearer against the same account/workspace rather than trusting cached UI.
    #expect(try await auth.token(for: original, force: false) == "fixture-0")
    _ = try await server.request("hold")
    let oldIdentity = Task { try await auth.refreshIdentity(api: api) }
    let held = try await server.request("wait")
    #expect(held["identityStarted"].bool)
    try await auth.selectOrganization()
    try await auth.refreshIdentity(api: api)
    #expect(auth.user["userId"].string == "user-1")
    _ = try await server.request("release")
    await #expect(throws: CancellationError.self) { try await oldIdentity.value }
    #expect(auth.user["userId"].string == "user-1")
    #expect(auth.organization["id"].string == "org-1")
    await #expect(throws: DesktopFailure.self) {
      try await auth.token(for: original, force: false)
    }
    try await auth.signOut()
    #expect(try await auth.getToken(force: true) == nil)
  }
}
