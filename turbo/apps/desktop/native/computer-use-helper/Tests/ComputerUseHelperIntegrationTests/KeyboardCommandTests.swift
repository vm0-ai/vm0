import Foundation
import Testing

private final class KeyboardTestBundle: NSObject {}

struct KeyboardCommandTests {
    @Test(arguments: ["never", "on-window-unavailable", "always"])
    func rejectsUnknownSnapshotBeforeAppActivation(policy: String) throws {
        let bundle = Bundle(for: KeyboardTestBundle.self)
        let executable = bundle.bundleURL.deletingLastPathComponent().appendingPathComponent("computer-use-helper")
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = ["--stdio"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
        let request: [String: Any] = [
            "id": "keyboard-snapshot", "kind": "keyboard.press_key",
            "app": "ai.vm0.test.keyboard-not-running", "key": "CMD+w",
            "snapshotId": "expired-snapshot", "foregroundRecovery": policy,
        ]
        var data = try JSONSerialization.data(withJSONObject: request)
        data.append(10)
        try input.fileHandleForWriting.write(contentsOf: data)
        try input.fileHandleForWriting.close()
        let exited = ended.wait(timeout: .now() + 5) == .success
        if !exited { process.terminate() }
        process.waitUntilExit()
        #expect(exited, "The helper must exit after its input closes")
        #expect(process.terminationStatus == 0)
        let response = output.fileHandleForReading.readDataToEndOfFile()
        let result = try #require(JSONSerialization.jsonObject(with: response) as? [String: Any])
        #expect(result["id"] as? String == "keyboard-snapshot")
        #expect(result["status"] as? String == "failed")
        let error = try #require(result["error"] as? [String: Any])
        #expect(error["code"] as? String == "unsupported_command")
        #expect((error["message"] as? String)?.contains("expired-snapshot") == true)
    }
}
