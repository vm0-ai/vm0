import DesktopCore
import Foundation
import Testing

@Suite struct UpdateFeedIntegrationTests {
  @Test @MainActor func releaseSelectionChecksTheActualFeedContractAndDownloadOrigin() async throws
  {
    let script = """
      import json,sys,threading
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      from socketserver import TCPServer
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def do_GET(self):
              url='https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.zip'
              if self.path=='/wrong-origin': url='https://example.invalid/Okou.zip'
              feed={'currentRelease':'1.2.3','releases':[{'version':'1.2.3','updateTo':{'url':url}}]}
              if self.path=='/malformed': del feed['currentRelease']
              data=json.dumps(feed).encode()
              self.send_response(200)
              self.send_header('Content-Type','application/json')
              self.send_header('Content-Length',str(len(data)))
              self.end_headers()
              self.wfile.write(data)
      class Server(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self)
              self.server_name='localhost'
              self.server_port=self.server_address[1]
      server=Server(('127.0.0.1',0),Handler)
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
    let origin = try #require(URL(string: "http://127.0.0.1:\(port)"))
    let feed = DesktopUpdateFeed(url: origin)
    let release = try #require(await feed.latest(after: "1.2.2"))
    #expect(release.version == "1.2.3")
    #expect(release.archiveURL.lastPathComponent == "Okou-darwin-arm64-1.2.3.zip")
    #expect(try await feed.latest(after: "1.2.3") == nil)
    #expect(try await feed.latest(after: "1.3.0") == nil)
    await #expect(throws: DesktopFailure.self) {
      try await DesktopUpdateFeed(url: origin.appendingPathComponent("wrong-origin")).latest(
        after: "1.2.2")
    }
    await #expect(throws: DecodingError.self) {
      try await DesktopUpdateFeed(url: origin.appendingPathComponent("malformed")).latest(
        after: "1.2.2")
    }
  }
}
