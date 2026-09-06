import Foundation

/// Required fields produced by the bundled Computer Use helper. AX attributes
/// such as role and title remain optional because macOS may omit them.
struct NativeSnapshot: Decodable {
  struct Bounds: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    var valid: Bool { [x, y, width, height].allSatisfy(\.isFinite) && width > 0 && height > 0 }
  }
  struct Element: Decodable {
    let id: String
    let index: Int
    let children: [Element]?
    var flattened: [Element] { [self] + (children ?? []).flatMap(\.flattened) }
  }
  let app: String
  let appDisplayName: String
  let pid: Int
  let snapshotId: String
  let elements: [Element]
  let elementIdsByIndex: [String]
  let nodeCount: Int
  let truncated: Bool
  let truncationReasons: [String]
  let screenshot: String
  let screenshotMimeType: String
  let screenshotSource: String
  let screenshotSourceName: String
  let screenshotWidth: Int
  let screenshotHeight: Int
  let screenshotSourceBounds: Bounds
  let windowId: UInt32
  let windowFrame: Bounds
  let windowIsOnScreen: Bool

  func validate(app: String, snapshotID: String) throws {
    guard self.app == app, snapshotId == snapshotID, pid > 0, nodeCount >= 0 else {
      throw DesktopFailure(
        "helper_protocol", "The helper returned an unrelated or invalid snapshot")
    }
    let nodes = elements.flatMap(\.flattened)
    guard
      nodes.enumerated().allSatisfy({ $0.offset == $0.element.index && !$0.element.id.isEmpty }),
      nodes.map(\.id) == elementIdsByIndex
    else {
      throw DesktopFailure("helper_protocol", "The helper returned inconsistent element targets")
    }
    guard screenshotSource == "window", screenshotMimeType == "image/png", !screenshot.isEmpty,
      screenshotWidth > 0, screenshotHeight > 0, screenshotSourceBounds.valid, windowFrame.valid
    else {
      throw DesktopFailure(
        "screen_recording_unavailable",
        "app.state must return a target-window screenshot with bounds")
    }
  }
}
