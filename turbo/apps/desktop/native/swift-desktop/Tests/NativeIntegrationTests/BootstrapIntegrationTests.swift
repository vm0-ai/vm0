import AppKit
import DesktopCore
import Foundation
import Testing

@testable import OkouDesktop

@Suite(.serialized) struct BootstrapIntegrationTests {
  @Test @MainActor func replacementRestoresThePreviousBundleWhenLaunchFails() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let installed = directory.appendingPathComponent("Okou.app")
    let candidate = directory.appendingPathComponent("candidate.app")
    defer { try? FileManager.default.removeItem(at: directory) }
    for (app, version) in [(installed, "old"), (candidate, "new")] {
      try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
      try Data(version.utf8).write(to: app.appendingPathComponent("version"))
    }
    let log = directory.appendingPathComponent("launches")
    let script = """
      import pathlib,sys
      version=(pathlib.Path(sys.argv[1])/'version').read_text()
      with open(sys.argv[2],'a') as log: log.write(version+'\\n')
      sys.exit(23 if version=='new' else 0)
      """
    await #expect(throws: DesktopFailure.self) {
      try await DesktopBundleReplacement.install(candidate: candidate, installed: installed) {
        app in
        _ = try await ProcessCommand().run(
          "/usr/bin/env", ["python3", "-c", script, app.path, log.path])
      }
    }
    #expect(
      try String(contentsOf: installed.appendingPathComponent("version"), encoding: .utf8) == "old")
    #expect(try String(contentsOf: log, encoding: .utf8) == "new\nold\n")
    let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    #expect(remaining.sorted() == ["Okou.app", "launches"])
  }

  @Test @MainActor func corruptPreferencesDoNotDisableTheBootstrapUpdater() async throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try Data("{broken preferences".utf8).write(
      to: directory.appendingPathComponent("desktop-preferences.json"))
    let script = """
      import json,sys,threading
      from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
      from socketserver import TCPServer
      checked=threading.Event()
      paths=[]
      class Handler(BaseHTTPRequestHandler):
          def log_message(self,*args): pass
          def do_GET(self):
              paths.append(self.path)
              data=b'{"currentRelease":"0.46.14","releases":[]}'
              self.send_response(200)
              self.send_header('Content-Type','application/json')
              self.send_header('Content-Length',str(len(data)))
              self.end_headers()
              self.wfile.write(data)
              checked.set()
      class Server(ThreadingHTTPServer):
          def server_bind(self):
              TCPServer.server_bind(self)
              self.server_name='localhost'
              self.server_port=self.server_address[1]
      server=Server(('127.0.0.1',0),Handler)
      threading.Thread(target=server.serve_forever,daemon=True).start()
      for line in sys.stdin:
          request=json.loads(line)
          if request['kind']=='server.start': result={'port':server.server_port}
          else: result={'checked':checked.wait(10),'paths':paths}
          print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      """
    let fixture = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { fixture.close() }
    let server = try await fixture.request("server.start")
    let port = Int(try #require(server["port"].number))
    let feedURL = try #require(URL(string: "http://127.0.0.1:\(port)/stable/RELEASES.json"))
    let delegate = DesktopDelegate()
    defer {
      delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    }
    #expect(throws: DecodingError.self) {
      _ = try delegate.loadRuntime(
        configuration: DesktopConfiguration(platformURL: "https://app.okou.ai", version: "0.46.14"),
        directory: directory, helperDirectory: directory, feed: DesktopUpdateFeed(url: feedURL))
    }
    // The observable boundary is an actual feed request after the production
    // runtime constructor has failed on the on-disk preferences file.
    let result = try await fixture.request("server.wait")
    #expect(result["checked"].bool)
    #expect(result["paths"] == .strings(["/stable/RELEASES.json"]))
    #expect(
      try String(
        contentsOf: directory.appendingPathComponent("desktop-preferences.json"), encoding: .utf8)
        == "{broken preferences")
  }
}
