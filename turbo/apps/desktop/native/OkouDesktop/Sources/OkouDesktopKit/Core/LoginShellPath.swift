import Foundation

/// Resolves the user's login shell PATH. GUI apps inherit the launchd
/// environment whose PATH misses Homebrew and version-manager directories, so
/// stdio MCP servers such as `npx` would fail with ENOENT. Port of
/// `resolveLoginShellPath`: the shell prints PATH between random marks so rc
/// output cannot corrupt the result; nil on timeout or any failure.
public enum LoginShellPath {
    public static let resolveTimeoutMs: Double = 10_000

    public static func resolve(
        shell: String? = nil, environment: [String: String] = ProcessInfo.processInfo.environment,
        timeoutMs: Double = LoginShellPath.resolveTimeoutMs
    ) async -> String? {
        let shellPath = shell ?? environment["SHELL"] ?? "/bin/zsh"
        let mark = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shellPath)
        process.arguments = ["-i", "-l", "-c", "printf '%s%s%s' '\(mark)' \"$PATH\" '\(mark)'"]
        process.environment = environment
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let output: Data? = await withTaskGroup(of: Data?.self) { group in
            group.addTask {
                let data = stdout.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                return process.terminationStatus == 0 ? data : nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutMs * 1_000_000))
                if process.isRunning {
                    process.terminate()
                }
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        guard let output, let text = String(data: output, encoding: .utf8) else { return nil }
        guard let start = text.range(of: String(mark)), let end = text.range(of: String(mark), range: start.upperBound..<text.endIndex) else {
            return nil
        }
        let path = text[start.upperBound..<end.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }
}
