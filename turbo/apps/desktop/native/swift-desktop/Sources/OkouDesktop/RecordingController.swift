import AppKit
import SwiftUI

@MainActor
final class RecordingController {
  private let recorder: ScreenRecorder
  private let report: (any Error) -> Void
  private let showSettings: () -> Void
  private(set) var window: NSPanel?
  private var presentedCapture: UUID?

  init(
    recorder: ScreenRecorder, report: @escaping (any Error) -> Void,
    showSettings: @escaping () -> Void
  ) {
    self.recorder = recorder
    self.report = report
    self.showSettings = showSettings
  }

  func update() {
    guard
      recorder.capturing || ["finalizing", "discarding", "delivering"].contains(recorder.status)
    else {
      window?.orderOut(nil)
      if recorder.status == "ready", recorder.error != nil { showSettings() }
      return
    }
    if window == nil {
      let panel = NSPanel(
        contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
        defer: false)
      panel.title = "Recording Controls"
      panel.isFloatingPanel = true
      panel.hidesOnDeactivate = false
      panel.isMovableByWindowBackground = true
      panel.level = .floating
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.hasShadow = true
      panel.isReleasedWhenClosed = false
      panel.contentView = NSHostingView(
        rootView: RecordingControls(recorder: recorder, report: report))
      window = panel
    }
    if presentedCapture != recorder.captureID {
      presentedCapture = recorder.captureID
      placeWindow()
    }
    window?.orderFrontRegardless()
  }

  private func placeWindow() {
    let screen =
      NSScreen.screens.first { screen in
        guard
          let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return false }
        return "display:\(id.uint32Value)" == recorder.captureSourceID
      } ?? NSScreen.main ?? NSScreen.screens.first
    guard let screen,
      let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
    else { return }
    let display = CGDisplayBounds(id.uint32Value)
    let work = screen.visibleFrame
    let quartzWork = CGRect(
      x: display.minX + work.minX - screen.frame.minX,
      y: display.minY + screen.frame.maxY - work.maxY,
      width: work.width, height: work.height)
    let placement = Self.placement(captured: recorder.captureArea, display: quartzWork)
    window?.setFrame(
      CGRect(
        x: screen.frame.minX + placement.minX - display.minX,
        y: screen.frame.maxY - placement.maxY + display.minY,
        width: placement.width, height: placement.height), display: true)
  }

  /// Same below/above/right/left ordering as the existing Electron controller.
  /// Inputs use Quartz global coordinates; AppKit conversion happens at the window boundary.
  static func placement(captured: CGRect?, display: CGRect) -> CGRect {
    let size = CGSize(width: 268, height: 60)
    let gap: CGFloat = 16
    guard let captured else {
      return CGRect(
        x: display.midX - size.width / 2, y: display.maxY - size.height - gap, width: size.width,
        height: size.height)
    }
    let x = min(max(captured.midX - size.width / 2, display.minX), display.maxX - size.width)
    if captured.maxY + gap + size.height <= display.maxY {
      return CGRect(x: x, y: captured.maxY + gap, width: size.width, height: size.height)
    }
    if captured.minY - gap - size.height >= display.minY {
      return CGRect(
        x: x, y: captured.minY - gap - size.height, width: size.width, height: size.height)
    }
    let y = min(max(captured.minY, display.minY), display.maxY - size.height)
    if captured.maxX + gap + size.width <= display.maxX {
      return CGRect(x: captured.maxX + gap, y: y, width: size.width, height: size.height)
    }
    if captured.minX - gap - size.width >= display.minX {
      return CGRect(
        x: captured.minX - gap - size.width, y: y, width: size.width, height: size.height)
    }
    return CGRect(x: x, y: display.maxY - size.height - gap, width: size.width, height: size.height)
  }
}

private struct RecordingControls: View {
  @ObservedObject var recorder: ScreenRecorder
  let report: (any Error) -> Void
  var body: some View {
    HStack(spacing: 14) {
      Circle().fill(recorder.status == "paused" ? Color.orange : Color.red).frame(
        width: 8, height: 8)
      Text(String(format: "%02d:%02d", Int(recorder.elapsed) / 60, Int(recorder.elapsed) % 60))
        .monospacedDigit().frame(minWidth: 48)
      if recorder.capturing {
        Button {
          run { try await recorder.pauseOrResume() }
        } label: {
          Image(systemName: recorder.status == "paused" ? "play.fill" : "pause.fill")
        }.help(recorder.status == "paused" ? "Resume recording" : "Pause recording")
          .accessibilityLabel(recorder.status == "paused" ? "Resume recording" : "Pause recording")
        Button {
          run { try await recorder.stop() }
        } label: {
          Image(systemName: "stop.fill")
        }
        .help("Stop and review (⌃⇧R)").accessibilityLabel("Stop and review")
        Button {
          run { try await recorder.discard() }
        } label: {
          Image(systemName: "trash")
        }
        .help("Discard recording").accessibilityLabel("Discard recording")
      } else {
        ProgressView().controlSize(.small)
        Text(recorder.status.capitalized).font(.caption)
      }
    }
    .buttonStyle(.borderless).padding(14).frame(width: 268, height: 60)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.18)))
  }

  private func run(_ operation: @escaping @MainActor () async throws -> Void) {
    Task { @MainActor in
      do { try await operation() } catch is CancellationError {} catch { report(error) }
    }
  }
}
