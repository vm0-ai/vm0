import DesktopCore
import Foundation
import Testing

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@Suite struct PreviewAccessTests {
  @Test @MainActor func protectedAPIAcceptsPreviewAccessWithoutForwardingCredentials() async throws
  {
    let script = """
      import json,sys,threading
      from urllib.parse import unquote,urlsplit,parse_qs
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
              url=urlsplit(self.path)
              if url.path=='/':
                  params=parse_qs(url.query)
                  allowed=params.get('x-vercel-protection-bypass')==['preview-123']
                  self.reply({'recording':params.get('intro-video-recording'),'prompt':params.get('prompt')},200 if allowed else 403)
                  return
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
    // A saved environment with no token must not inherit a launch credential
    // intended for the bundled environment.
    let withoutAccess = DesktopAPI(
      configuration: try DesktopConfiguration(
        platformURL: origin, version: "1.0.0", preview: true, previewBypass: "preview-123",
        previewEnvironment: DesktopPreviewEnvironment(platformURL: origin)))
    await #expect(throws: DesktopHTTPError.self) { try await withoutAccess.request("api/auth/me") }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let bundled = try DesktopConfiguration(platformURL: "https://app.okou.ai", version: "1.0.0")
    let settings = try DesktopPreviewSettings(bundled: bundled, directory: directory)
    let environment = DesktopPreviewEnvironment(
      platformURL: origin + "/?prompt=retained&x-vercel-protection-bypass=preview-123",
      apiURL: origin, authURL: origin.replacingOccurrences(of: "127.0.0.1", with: "localhost"))
    try settings.save(environment)
    let relaunched = try DesktopPreviewSettings(bundled: bundled, directory: directory)
    let configuration = try relaunched.configuration(for: relaunched.value)
    #expect(configuration.bundleID == bundled.bundleID)
    #expect(configuration.name == bundled.name)
    #expect(!configuration.production)
    #expect(configuration.previewEnvironmentID == environment.id)
    #expect(configuration.apiURL.absoluteString == origin)
    #expect(configuration.signInURL.host == "localhost")
    #expect(configuration.platformURL.query == "prompt=retained")
    #expect(relaunched.runtimeDirectory(for: configuration) != directory)
    let attributes = try FileManager.default.attributesOfItem(
      atPath: directory.appendingPathComponent("desktop-preview.json").path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
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
    // Opening the system browser cannot rely on native WebKit's cookie store.
    // A fresh browser request carries preview access and the original handoff.
    let browser = URLSession(configuration: .ephemeral)
    defer { browser.finishTasksAndInvalidate() }
    let (_, blocked) = try await browser.data(from: configuration.platformURL)
    #expect((blocked as? HTTPURLResponse)?.statusCode == 403)
    let (page, response) = try await browser.data(
      from: configuration.platformPage(query: [
        .init(name: "intro-video-recording", value: "take-1")
      ]))
    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    #expect(try JSON.decode(page)["recording"] == .strings(["take-1"]))
    #expect(try JSON.decode(page)["prompt"] == .strings(["retained"]))
    let production = try DesktopConfiguration(platformURL: "https://app.okou.ai", version: "1.0.0")
    #expect(production.platformPage().absoluteString == "https://app.okou.ai/")
    for origin in ["https://app.okou.ai", "https://staging-app.omby.ai.attacker.test"] {
      #expect(throws: DesktopFailure.self) {
        try DesktopConfiguration(
          platformURL: origin, version: "1.0.0", preview: true, previewBypass: "preview-123")
      }
    }
    for environment in [
      DesktopPreviewEnvironment(platformURL: "https://app.okou.ai"),
      DesktopPreviewEnvironment(
        platformURL: "https://pr-123-app.omby.ai", apiURL: "https://api.vm0.ai"),
      DesktopPreviewEnvironment(
        platformURL: "https://pr-123-app.omby.ai", authURL: "https://tenant.clerk.accounts.dev"),
      DesktopPreviewEnvironment(
        platformURL:
          "https://pr-123-app.omby.ai/?x-vercel-protection-bypass=one&x-vercel-protection-bypass=two"
      ),
    ] {
      #expect(throws: DesktopFailure.self) { try settings.save(environment) }
      #expect(
        try DesktopPreviewSettings(bundled: bundled, directory: directory).value == relaunched.value
      )
    }
    try settings.save(nil)
    let restored = try DesktopPreviewSettings(bundled: bundled, directory: directory)
    #expect(restored.value == nil)
    let defaultConfiguration = try restored.configuration(for: restored.value)
    #expect(defaultConfiguration.production)
    #expect(restored.runtimeDirectory(for: defaultConfiguration) == directory)
  }
}
