import DesktopCore
import Foundation
import Testing

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

@Suite struct ProcessOwnershipTests {
  @Test @MainActor func helperRestartWaitsForAnUncooperativeChildToExit() async throws {
    let script = """
      import json,os,signal,sys
      signal.signal(signal.SIGTERM,signal.SIG_IGN)
      while True:
          line=sys.stdin.readline()
          if not line:
              signal.pause()
              continue
          request=json.loads(line)
          alive=False
          if 'previous' in request:
              try: os.kill(int(request['previous']),0); alive=True
              except ProcessLookupError: pass
          print(json.dumps({'id':request['id'],'status':'succeeded','result':{'pid':os.getpid(),'group':os.getpgrp(),'previousAlive':alive}}),flush=True)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { helper.close() }
    let first = try await helper.request("identity")
    #expect(first["pid"] == first["group"])
    helper.close()
    let next = try await helper.request("identity", fields: .object(["previous": first["pid"]]))
    #expect(!next["previousAlive"].bool)
    #expect(next["pid"] != first["pid"])
    await helper.stop()
    let pid = try #require(next["pid"].number)
    #expect(kill(pid_t(pid), 0) == -1)
    #expect(errno == ESRCH)
  }

  @Test @MainActor func helperExitAlsoTerminatesItsUncooperativeDescendant() async throws {
    let script = """
      import json,os,subprocess,sys
      nested="import signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); signal.pause()"
      child=subprocess.Popen([sys.executable,'-u','-c',nested],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE)
      assert child.stdout.readline()==b'ready\\n'
      for line in sys.stdin:
          request=json.loads(line)
          print(json.dumps({'id':request['id'],'status':'succeeded','result':{'child':child.pid}}),flush=True)
      """
    let helper = HelperProcess(
      executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["python3", "-u", "-c", script])
    defer { helper.close() }
    let response = try await helper.request("identity")
    let child = try #require(response["child"].number)
    await helper.stop()
    // A container's PID 1 may leave an already-dead orphan as a zombie. ps can
    // distinguish that from a live descendant on both Linux and macOS.
    let output = try await ProcessCommand().run(
      "/bin/sh", ["-c", "ps -o stat= -p \(Int(child)); test $? -le 1"])
    let state = String(decoding: output, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
    #expect(state.isEmpty || state.hasPrefix("Z"))
  }

  @Test @MainActor func commandTimeoutReapsItsChildBeforeReturning() async throws {
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: marker) }
    let script = """
      import os,signal,sys
      signal.signal(signal.SIGTERM,signal.SIG_IGN)
      with open(sys.argv[1],'w') as file: file.write(str(os.getpid()))
      while True: signal.pause()
      """
    let command = ProcessCommand()
    await #expect(throws: DesktopFailure.self) {
      try await command.run(
        "/usr/bin/env", ["python3", "-u", "-c", script, marker.path], timeout: 2)
    }
    let pid = try #require(pid_t(String(contentsOf: marker, encoding: .utf8)))
    #expect(kill(pid, 0) == -1)
    #expect(errno == ESRCH)
    let next = try await command.run("/usr/bin/env", ["python3", "-c", "print('next command')"])
    #expect(String(data: next, encoding: .utf8) == "next command\n")
  }
}
