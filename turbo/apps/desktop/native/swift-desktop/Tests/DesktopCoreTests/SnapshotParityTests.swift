import DesktopCore
import Foundation
import Testing

@Suite struct SnapshotParityTests {
  @Test func matchesExistingDesktopSnapshots() throws {
    // Golden results were captured from the actual TypeScript normalizer and
    // renderer at baseline 45d2e0f; expectations are not produced by Swift.
    let url = try #require(
      Bundle.module.url(forResource: "snapshots", withExtension: "json", subdirectory: "Fixtures"))
    for fixture in try JSON.decode(Data(contentsOf: url)).array {
      let actual = AccessibilitySnapshot.transform(fixture["input"])
      for key in [
        "appState", "elementIdsByIndex", "focusedElementIndex", "nodeCount", "truncationReasons",
      ] {
        #expect(
          actual[key] == fixture["expected"][key], "\(fixture["name"].string ?? "snapshot"): \(key)"
        )
      }
    }
  }
}
