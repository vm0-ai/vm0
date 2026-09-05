import Foundation

/// A persistent, correlated JSON-lines channel. Permission probes and command
/// execution share the Computer Use process; recording has a separate owner.
@MainActor
public final class HelperProcess {
  private let executable: URL
  private let arguments: [String]
  private let cancelStopsProcess: Bool
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var buffer = Data()
  private struct Pending {
    let continuation: CheckedContinuation<JSON, any Error>
    let deadline: Task<Void, Never>
  }
  private var pending: [String: Pending] = [:]
  public private(set) var generation = 0

  public init(executable: URL, arguments: [String] = ["--stdio"], cancelStopsProcess: Bool = true) {
    self.executable = executable
    self.arguments = arguments
    self.cancelStopsProcess = cancelStopsProcess
  }

  public func request(_ kind: String, fields: JSON = .object([:]), timeout: Double = 35)
    async throws -> JSON
  {
    try Task.checkCancellation()
    try start()
    let id = UUID().uuidString
    var request = fields
    request["id"] = .string(id)
    request["kind"] = .string(kind)
    var bytes = try request.encoded()
    bytes.append(10)
    let message = bytes
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let deadline = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
          guard let self, self.pending[id] != nil else { return }
          self.close(
            error: DesktopFailure(
              "command_timeout", "Native helper timed out while executing \(kind)"))
        }
        pending[id] = Pending(continuation: continuation, deadline: deadline)
        do { try input?.write(contentsOf: message) } catch { close(error: error) }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        guard let self, self.cancelStopsProcess, self.pending[id] != nil else { return }
        self.close(error: CancellationError())
      }
    }
  }

  private func start() throws {
    if process != nil { return }
    let child = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    child.executableURL = executable
    child.arguments = arguments
    child.standardInput = stdin
    child.standardOutput = stdout
    child.standardError = FileHandle.standardError
    let nextGeneration = generation + 1
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let bytes = handle.availableData
      Task { @MainActor in self?.receive(bytes, generation: nextGeneration) }
    }
    child.terminationHandler = { [weak self] child in
      let status = child.terminationStatus
      Task { @MainActor in
        guard let self, self.generation == nextGeneration else { return }
        self.close(error: DesktopFailure("helper_unavailable", "Native helper exited (\(status))"))
      }
    }
    do { try child.run() } catch {
      stdout.fileHandleForReading.readabilityHandler = nil
      throw error
    }
    generation = nextGeneration
    process = child
    input = stdin.fileHandleForWriting
    output = stdout.fileHandleForReading
  }

  private func receive(_ bytes: Data, generation: Int) {
    guard generation == self.generation, process != nil else { return }
    if bytes.isEmpty {
      close(error: DesktopFailure("helper_unavailable", "Native helper closed its output"))
      return
    }
    buffer.append(bytes)
    if buffer.count > 64 * 1024 * 1024 {
      close(error: DesktopFailure("result_too_large", "Native helper output exceeded 64 MiB"))
      return
    }
    while let newline = buffer.firstIndex(of: 10) {
      let line = Data(buffer[..<newline])
      buffer.removeSubrange(...newline)
      if line.isEmpty { continue }
      do {
        let response = try JSON.decode(line)
        guard let id = response["id"].string, let request = pending.removeValue(forKey: id) else {
          throw DesktopFailure("helper_protocol", "Native helper returned an unknown request ID")
        }
        request.deadline.cancel()
        if response["status"].string == "succeeded" {
          request.continuation.resume(returning: response["result"])
        } else {
          request.continuation.resume(
            throwing: DesktopFailure(
              response["error"]["code"].string ?? "helper_unavailable",
              response["error"]["message"].string ?? "Native helper command failed"))
        }
      } catch {
        close(error: error)
        return
      }
    }
  }

  public func close(error: any Error = CancellationError()) {
    let child = process
    process = nil
    output?.readabilityHandler = nil
    input?.closeFile()
    input = nil
    output?.closeFile()
    output = nil
    buffer.removeAll()
    let requests = pending.values
    pending.removeAll()
    for request in requests {
      request.deadline.cancel()
      request.continuation.resume(throwing: error)
    }
    if let child, child.isRunning { child.terminate() }
  }
}
