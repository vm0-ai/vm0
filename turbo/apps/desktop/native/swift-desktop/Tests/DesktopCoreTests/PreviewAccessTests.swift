import DesktopCore
import Foundation
import Testing

@Suite struct PreviewAccessTests {
  @Test @MainActor func protectedAPIAcceptsPreviewAccessWithoutForwardingCredentials() async throws
  {
    let script = """
      import json,sys,threading
      from urllib.parse import unquote
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      from socketserver import TCPServer
      redirects=0
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def reply(self,body,status=200):
              data=json.dumps(body).encode()
              self.send_response(status)
              self.send_header('Content-Type','application/json')
              self.send_header('Content-Length',str(len(data)))
              self.end_headers()
              self.wfile.write(data)
          def do_GET(self):
              global redirects
              if self.path=='/redirected': redirects+=1;self.reply({});return
              if self.path=='/api/redirect':
                  self.send_response(302)
                  self.send_header('Location',f'http://localhost:{self.server.server_port}/redirected')
                  self.send_header('Content-Length','0')
                  self.end_headers()
                  return
              header=self.headers.get('x-vercel-protection-bypass')=='preview-123'
              cookie='x-vercel-protection-bypass=preview-123' in unquote(self.headers.get('Cookie',''))
              bearer=self.headers.get('Authorization')=='Bearer fixture-user'
              self.reply({'authorized':header and cookie and bearer},200 if header and cookie else 403)
      class Server(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self)
              self.server_name='localhost'
              self.server_port=self.server_address[1]
      server=Server(('127.0.0.1',0),Handler)
      threading.Thread(target=server.serve_forever,daemon=True).start()
      for line in sys.stdin:
          request=json.loads(line)
          print(json.dumps({'id':request['id'],'status':'succeeded','result':{'port':server.server_port,'redirects':redirects}}),flush=True)
      """
    let server = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { server.close() }
    let started = try await server.request("start")
    let origin = "http://127.0.0.1:\(Int(try #require(started["port"].number)))"
    let ordinary = DesktopAPI(
      configuration: try DesktopConfiguration(platformURL: origin, version: "1.0.0", preview: true))
    await #expect(throws: DesktopHTTPError.self) { try await ordinary.request("api/auth/me") }
    let configuration = try DesktopConfiguration(
      platformURL: origin, version: "1.0.0", preview: true, previewBypass: "preview-123")
    let protected = DesktopAPI(configuration: configuration)
    protected.tokenProvider = { _ in "fixture-user" }
    let identity = try await protected.request("api/auth/me")
    #expect(identity["authorized"].bool)
    do {
      _ = try await protected.request("api/redirect")
      Issue.record("The API unexpectedly followed a redirect")
    } catch let error as DesktopHTTPError {
      #expect(error.status == 302)
    }
    let state = try await server.request("inspect")
    #expect(state["redirects"].number == 0)
    for origin in ["https://app.okou.ai", "https://staging-app.omby.ai.attacker.test"] {
      #expect(throws: DesktopFailure.self) {
        try DesktopConfiguration(
          platformURL: origin, version: "1.0.0", preview: true, previewBypass: "preview-123")
      }
    }
  }
}
