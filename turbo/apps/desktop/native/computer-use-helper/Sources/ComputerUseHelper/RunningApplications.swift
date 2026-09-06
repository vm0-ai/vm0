import AppKit

/// Read on the helper's pumped main run loop so NSWorkspace can process external
/// launch and exit notifications. The command queue does not run a run loop.
func currentRunningApplications() -> [NSRunningApplication] {
    if Thread.isMainThread {
        return NSWorkspace.shared.runningApplications
    }
    return DispatchQueue.main.sync {
        NSWorkspace.shared.runningApplications
    }
}
