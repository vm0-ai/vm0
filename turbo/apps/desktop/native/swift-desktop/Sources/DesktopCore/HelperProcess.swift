import Foundation

/// A persistent, correlated JSON-lines channel. Permission probes and command
/// execution share the Computer Use process; recording has a separate owner.
@MainActor
public final class HelperProcess {
  private let executable: URL
  private let arguments: [String]
  private let cancelStopsProcess: Bool
  private var process: Process?
  private var termination: Task<Void, Never>?
  private var lifecycle = 0
  private var input: FileHandle?
  private var output: FileHandle?
  private var buffer = Data()
  private struct Pending {
    let continuation: CheckedContinuation<JSON, any Error>
    let deadline: Task<Void, Never>
  }
  private struct Response: Decodable {
    enum Status: String, Decodable { case succeeded, failed }
    struct Failure: Decodable {
      let code: String
      let message: String
    }
    let id: String
    let status: Status
    let result: [String: JSON]?
    let error: Failure?

    func outcome() throws -> Result<JSON, any Error> {
      switch status {
      case .succeeded:
        guard let result else {
          throw DesktopFailure("helper_protocol", "The helper omitted its result")
        }
        return .success(.object(result))
      case .failed:
        guard let error, !error.code.isEmpty, !error.message.isEmpty else {
          throw DesktopFailure("helper_protocol", "The helper omitted its failure details")
        }
        return .failure(DesktopFailure(error.code, error.message))
      }
    }
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
    try await start()
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

  private func start() async throws {
    let lifecycle = self.lifecycle
    await termination?.value
    try Task.checkCancellation()
    guard lifecycle == self.lifecycle else { throw CancellationError() }
    if process != nil { return }
    termination = nil
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
        let response = try JSONDecoder().decode(Response.self, from: line)
        guard let request = pending[response.id] else {
          throw DesktopFailure("helper_protocol", "Native helper returned an unknown request ID")
        }
        // Validate the frame before removing its continuation. A malformed
        // response must reject every pending request rather than strand one.
        let outcome = try response.outcome()
        pending.removeValue(forKey: response.id)
        request.deadline.cancel()
        request.continuation.resume(with: outcome)
      } catch {
        close(error: error)
        return
      }
    }
  }

  public func stop() async {
    close()
    await termination?.value
  }

  public func close(error: any Error = CancellationError()) {
    lifecycle += 1
    let child = process
    if child != nil { generation += 1 }
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
    if let child {
      child.terminationHandler = nil
      termination = Task { await ProcessTermination.stop(child) }
    }
  }
}
