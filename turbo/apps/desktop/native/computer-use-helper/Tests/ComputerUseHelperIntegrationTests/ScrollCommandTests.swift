import Foundation
import Testing

private final class ScrollTestBundle: NSObject {}

struct ScrollCommandTests {
    private func response(_ fields: [String: Any]) throws -> [String: Any] {
        let testBundle = Bundle(for: ScrollTestBundle.self)
        let executable = testBundle.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("computer-use-helper")
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = executable
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let request: [String: Any] = ["id": "scroll-validation", "kind": "element.scroll"]
            .merging(fields) { _, value in value }
        try input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: request))
        try input.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test(arguments: ["diagonal", "", "DOWN"])
    func rejectsInvalidDirectionBeforeTargetLookup(direction: String) throws {
        let result = try response(["direction": direction, "app": "missing-test-app", "elementId": "w0"])
        #expect(result["status"] as? String == "failed")
        #expect(result["id"] as? String == "scroll-validation")
        let error = try #require(result["error"] as? [String: Any])
        #expect(error["code"] as? String == "unsupported_command")
        #expect((error["message"] as? String)?.contains("direction") == true)
    }

    @Test
    func rejectsInvalidPageCountsBeforeTargetLookup() throws {
        for pages in [0, -1, true, "2", NSNull()] as [Any] {
            let result = try response(["direction": "down", "pages": pages])
            let error = try #require(result["error"] as? [String: Any])
            #expect(result["status"] as? String == "failed")
            #expect(error["code"] as? String == "unsupported_command")
            #expect(error["message"] as? String == "Scroll pages must be a positive finite number")
        }
    }

    @Test
    func reportsUnsupportedFractionalPagesInsteadOfSuccess() throws {
        let result = try response(["direction": "down", "pages": 0.5])
        let error = try #require(result["error"] as? [String: Any])
        #expect(result["status"] as? String == "failed")
        #expect(error["code"] as? String == "unsupported_command")
        #expect((error["message"] as? String)?.contains("whole number of pages") == true)
    }
}
