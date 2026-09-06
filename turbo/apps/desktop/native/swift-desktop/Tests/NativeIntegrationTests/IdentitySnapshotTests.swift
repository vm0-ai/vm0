import AppKit
import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

extension NativeIntegrationTests {
  @Test @MainActor func identityRefreshRetriesTheWholeExpiredSession() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = """
      import json,sys,threading
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      from socketserver import TCPServer
      generation=0
      mode='expire-between'
      requests=[]
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def reply(self,data,status=200,kind='application/json'):
              self.send_response(status);self.send_header('Content-Type',kind)
              self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
          def do_GET(self):
              global generation,mode
              if self.path.startswith('/desktop-auth/'):
                  page='<script>window.vm0DesktopAuth.completeSignIn({token:"owner-'+str(generation)+'"}).then(()=>location.replace("/"));</script>'
                  self.reply(page.encode(),kind='text/html');return
              if self.path=='/': self.reply(b'<html>Done</html>',kind='text/html');return
              owner=self.headers.get('Authorization','').removeprefix('Bearer owner-')
              requests.append(self.path.rsplit('/',1)[-1]+'-'+owner)
              if owner!=str(generation) or mode=='unauthorized': self.reply(b'{}',401);return
              if self.path=='/api/auth/me':
                  data={'userId':'user-'+owner,'email':'fixture@example.test','orgId':None if mode=='no-org' else 'org-'+owner}
                  if mode=='missing-email': del data['email']
                  if mode=='missing-org-id': del data['orgId']
                  if mode=='invalid-user-id': data['userId']=''
                  if mode=='expire-between': generation+=1;mode='valid'
                  self.reply(json.dumps(data).encode())
              elif self.path=='/api/org':
                  if mode in ('no-org','deleted-org'): self.reply(b'{}',404);return
                  if mode=='null-org': self.reply(b'null');return
                  data={'id':'other-org' if mode=='mixed-org' else 'org-'+owner,'name':'Fixture'}
                  if mode=='missing-org-name': del data['name']
                  self.reply(json.dumps(data).encode())
              else: self.reply(b'{}',404)
      class Server(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self);self.server_name='localhost';self.server_port=self.server_address[1]
      server=Server(('127.0.0.1',0),Handler)
      threading.Thread(target=server.serve_forever,daemon=True).start()
      for line in sys.stdin:
          command=json.loads(line)
          if command['kind'] not in ('start','inspect'): mode=command['kind']
          print(json.dumps({'id':command['id'],'status':'succeeded','result':{'port':server.server_port,'requests':requests}}),flush=True)
      """
    let server = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { server.close() }
    let address = try await server.request("start")
    let configuration = try DesktopConfiguration(
      platformURL: "http://127.0.0.1:\(Int(try #require(address["port"].number)))",
      version: "1.0.0", preview: true)
    let auth = DesktopAuth(
      configuration: configuration, preferences: try DesktopPreferences(directory: directory))
    let api = DesktopAPI(configuration: configuration)
    api.tokenProvider = { force in try await auth.getToken(force: force) }
    try await auth.refreshIdentity(api: api)
    #expect(auth.user["userId"].string == "user-1")
    #expect(auth.organization["id"].string == "org-1")
    let observed = try await server.request("inspect")
    #expect(observed["requests"] == .strings(["me-0", "org-0", "me-1", "org-1"]))
    for mode in [
      "missing-email", "missing-org-id", "invalid-user-id", "mixed-org", "missing-org-name",
      "null-org",
    ] {
      _ = try await server.request(mode)
      await #expect(throws: (any Error).self) { try await auth.refreshIdentity(api: api) }
      #expect(auth.user["userId"].string == "user-1")
      #expect(auth.organization["id"].string == "org-1")
    }
    for mode in ["no-org", "deleted-org"] {
      _ = try await server.request(mode)
      try await auth.refreshIdentity(api: api)
      #expect(auth.signedIn && auth.organization == .null)
    }
    _ = try await server.request("unauthorized")
    try await auth.refreshIdentity(api: api)
    #expect(!auth.signedIn && auth.organization == .null)
  }
}
