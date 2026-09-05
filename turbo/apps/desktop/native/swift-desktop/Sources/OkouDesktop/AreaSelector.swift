import AppKit
import DesktopCore

@MainActor
final class AreaSelector {
  private var panels: [NSPanel] = []
  private var completion: ((JSON, JSON) -> Void)?

  func select(completion: @escaping (JSON, JSON) -> Void) {
    cancel()
    self.completion = completion
    for screen in NSScreen.screens {
      guard
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
      else { continue }
      let displayID = CGDirectDisplayID(number.uint32Value)
      let panel = SelectionPanel(
        contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered, defer: false)
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.level = .screenSaver
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      panel.isReleasedWhenClosed = false
      let view = SelectionView(frame: NSRect(origin: .zero, size: screen.frame.size))
      view.cancel = { [weak self] in self?.cancel() }
      view.selected = { [weak self] rect in
        guard let self else { return }
        let displayBounds = CGDisplayBounds(displayID)
        let area: JSON = .object([
          "x": .number(displayBounds.minX + rect.minX),
          "y": .number(displayBounds.minY + screen.frame.height - rect.maxY),
          "width": .number(rect.width), "height": .number(rect.height),
        ])
        let callback = self.completion
        self.cancel()
        callback?(
          .object(["id": .string("display:\(displayID)"), "kind": .string("display")]), area)
      }
      panel.contentView = view
      panels.append(panel)
      panel.makeKeyAndOrderFront(nil)
      panel.makeFirstResponder(view)
    }
  }

  func cancel() {
    for panel in panels { panel.close() }
    panels = []
    completion = nil
    NSCursor.arrow.set()
  }
}

private final class SelectionPanel: NSPanel {
  override var canBecomeKey: Bool { true }
}

@MainActor
private final class SelectionView: NSView {
  var selected: ((NSRect) -> Void)?
  var cancel: (() -> Void)?
  private var anchor: NSPoint?
  private var selection = NSRect.zero
  override var acceptsFirstResponder: Bool { true }

  override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
  override func draw(_ dirtyRect: NSRect) {
    let mask = NSBezierPath(rect: bounds)
    mask.append(NSBezierPath(rect: selection))
    mask.windingRule = .evenOdd
    NSColor.black.withAlphaComponent(0.45).setFill()
    mask.fill()
    NSColor.white.setStroke()
    let border = NSBezierPath(rect: selection)
    border.lineWidth = 2
    border.stroke()
    let text = "Drag to select an area · Esc to cancel" as NSString
    text.draw(
      at: NSPoint(x: 24, y: bounds.height - 48),
      withAttributes: [
        .font: NSFont.systemFont(ofSize: 18, weight: .medium), .foregroundColor: NSColor.white,
      ])
  }
  override func mouseDown(with event: NSEvent) {
    anchor = convert(event.locationInWindow, from: nil)
  }
  override func mouseDragged(with event: NSEvent) {
    guard let anchor else { return }
    let current = convert(event.locationInWindow, from: nil)
    selection = NSRect(
      x: min(anchor.x, current.x), y: min(anchor.y, current.y), width: abs(anchor.x - current.x),
      height: abs(anchor.y - current.y)
    ).intersection(bounds)
    needsDisplay = true
  }
  override func mouseUp(with event: NSEvent) {
    mouseDragged(with: event)
    if selection.width >= 2 && selection.height >= 2 { selected?(selection) }
  }
  override func keyDown(with event: NSEvent) { if event.keyCode == 53 { cancel?() } }
}
