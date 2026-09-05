import Foundation

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

/// Retains the child until it actually exits, escalating an ignored termination.
/// Callers keep this operation alive even when their original request is cancelled.
@MainActor
final class ProcessTermination {
  private let process: Process
  private var completion: CheckedContinuation<Void, Never>?
  private var escalation: Task<Void, Never>?

  private init(_ process: Process) { self.process = process }

  static func stop(_ process: Process) async {
    guard process.processIdentifier > 0 else { return }
    let owner = ProcessTermination(process)
    if process.isRunning {
      await owner.wait()
    } else {
      owner.finish()
    }
  }

  private func signal(_ value: Int32) {
    // Foundation launches a distinct process group whose ID is the child's PID.
    // Never use our inherited process group, which also owns the desktop itself.
    if kill(-process.processIdentifier, value) != 0, process.isRunning {
      kill(process.processIdentifier, value)
    }
  }

  private func wait() async {
    await withCheckedContinuation { continuation in
      completion = continuation
      process.terminationHandler = { [self] _ in
        Task { @MainActor in finish() }
      }
      guard process.isRunning else {
        finish()
        return
      }
      signal(SIGTERM)
      escalation = Task { [self] in
        do { try await Task.sleep(for: .seconds(2)) } catch { return }
        if process.isRunning { signal(SIGKILL) }
      }
    }
  }

  private func finish() {
    // The parent may exit before its own child processes. Nothing in its owned
    // group may survive once the helper's owner has finished shutting down.
    kill(-process.processIdentifier, SIGKILL)
    escalation?.cancel()
    escalation = nil
    process.terminationHandler = nil
    let continuation = completion
    completion = nil
    continuation?.resume()
  }
}
