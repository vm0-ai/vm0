import Foundation

/// Bounded commands used for native system utilities. Output goes to a private
/// temporary file so verbose shell startup files cannot fill a pipe and hang.
@MainActor
public final class ProcessCommand {
  private var process: Process?
  private var completion: CheckedContinuation<Data, any Error>?
  private var deadline: Task<Void, Never>?
  private let output: URL
  private var handle: FileHandle?

  public init() {
    output = FileManager.default.temporaryDirectory.appendingPathComponent(
      "okou-command-\(UUID().uuidString)")
  }

  public func run(_ executable: String, _ arguments: [String], timeout: Double = 30) async throws
    -> Data
  {
    guard process == nil else { throw DesktopFailure("process_busy", "Command is already running") }
    _ = FileManager.default.createFile(
      atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
    let handle = try FileHandle(forWritingTo: output)
    self.handle = handle
    defer {
      handle.closeFile()
      self.handle = nil
      try? FileManager.default.removeItem(at: output)
    }
    let child = Process()
    child.executableURL = URL(fileURLWithPath: executable)
    child.arguments = arguments
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = handle
    child.standardError = FileHandle.standardError
    child.terminationHandler = { [weak self] child in
      let status = child.terminationStatus
      Task { @MainActor in
        guard let self, self.completion != nil else { return }
        do {
          guard status == 0 else {
            throw DesktopFailure(
              "process_failed",
              "\(URL(fileURLWithPath: executable).lastPathComponent) exited (\(status))")
          }
          let size =
            try FileManager.default.attributesOfItem(atPath: self.output.path)[.size] as? NSNumber
          guard let size, size.intValue <= 16 * 1024 * 1024 else {
            throw DesktopFailure("result_too_large", "System command output exceeded 16 MiB")
          }
          self.finish(.success(try Data(contentsOf: self.output)))
        } catch { self.finish(.failure(error)) }
      }
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        completion = continuation
        process = child
        deadline = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
          self?.finish(.failure(DesktopFailure("command_timeout", "System command timed out")))
        }
        do { try child.run() } catch { finish(.failure(error)) }
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
    }
  }

  private func finish(_ result: Result<Data, any Error>) {
    deadline?.cancel()
    deadline = nil
    let continuation = completion
    completion = nil
    process?.terminationHandler = nil
    if let process, process.isRunning { process.terminate() }
    process = nil
    continuation?.resume(with: result)
  }
}
