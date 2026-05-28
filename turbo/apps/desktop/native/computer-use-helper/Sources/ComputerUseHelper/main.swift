import AppKit
import ApplicationServices
import Darwin
import Foundation

struct HelperFailure: Error {
    let code: String
    let message: String
}

struct SnapshotLimits {
    let maxDepth = 32
    let maxNodes = 2_000
    let maxChildrenPerSource = 160
    let maxWindows = 8
    let maxActions = 12
}

struct ChildEntry {
    let element: AXUIElement
    let segment: String
}

struct ChildSource: Sendable {
    let attribute: String
    let prefix: String
}

let limits = SnapshotLimits()

let childSources = [
    ChildSource(attribute: kAXChildrenAttribute as String, prefix: "e"),
    ChildSource(attribute: "AXRows", prefix: "r"),
    ChildSource(attribute: "AXContents", prefix: "c"),
    ChildSource(attribute: "AXVisibleChildren", prefix: "v"),
    ChildSource(attribute: "AXVisibleRows", prefix: "a"),
    ChildSource(attribute: "AXVisibleCells", prefix: "b"),
    ChildSource(attribute: "AXVisibleColumns", prefix: "d"),
    ChildSource(attribute: "AXSelectedChildren", prefix: "s"),
    ChildSource(attribute: "AXSelectedRows", prefix: "q"),
    ChildSource(attribute: "AXSelectedCells", prefix: "l"),
]

let visibleCollectionChildSources = [
    ChildSource(attribute: "AXVisibleRows", prefix: "a"),
    ChildSource(attribute: "AXVisibleCells", prefix: "b"),
    ChildSource(attribute: "AXVisibleColumns", prefix: "d"),
    ChildSource(attribute: "AXSelectedRows", prefix: "q"),
    ChildSource(attribute: "AXSelectedCells", prefix: "l"),
    ChildSource(attribute: "AXSelectedChildren", prefix: "s"),
    ChildSource(attribute: "AXVisibleChildren", prefix: "v"),
    ChildSource(attribute: "AXContents", prefix: "c"),
]

func appSnapshotKey(_ appName: String) -> String {
    return appName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func snapshotStorageKey(appName: String, snapshotId: String) -> String {
    return "\(appSnapshotKey(appName))\u{0}\(snapshotId)"
}

final class ComputerUseRuntimeSession: @unchecked Sendable {
    private var snapshots: [String: [String: Any]] = [:]
    private var snapshotOrder: [String] = []
    private var latestByApp: [String: String] = [:]
    private let maxSnapshots = 50

    func recordSnapshot(_ response: [String: Any]) {
        guard let appName = response["app"] as? String,
              let snapshotId = response["snapshotId"] as? String
        else {
            return
        }

        let key = snapshotStorageKey(appName: appName, snapshotId: snapshotId)
        var metadata: [String: Any] = [
            "app": appName,
            "snapshotId": snapshotId,
        ]
        for field in [
            "elementIdsByIndex",
            "focusedElementIndex",
            "windowId",
            "windowFrame",
            "screenshotSource",
            "screenshotWidth",
            "screenshotHeight",
            "screenshotSourceBounds",
        ] {
            if let value = response[field] {
                metadata[field] = value
            }
        }

        snapshots[key] = metadata
        latestByApp[appSnapshotKey(appName)] = key
        snapshotOrder.removeAll { existingKey in
            existingKey == key
        }
        snapshotOrder.append(key)

        while snapshotOrder.count > maxSnapshots {
            let removedKey = snapshotOrder.removeFirst()
            snapshots.removeValue(forKey: removedKey)
            for (appKey, snapshotKey) in latestByApp where snapshotKey == removedKey {
                latestByApp.removeValue(forKey: appKey)
            }
        }
    }

    func snapshot(appName: String, snapshotId: String?) throws -> [String: Any] {
        let key: String?
        if let snapshotId {
            key = snapshotStorageKey(appName: appName, snapshotId: snapshotId)
        } else {
            key = latestByApp[appSnapshotKey(appName)]
        }

        guard let key, let metadata = snapshots[key] else {
            let target = snapshotId.map { "\(appName): \($0)" } ?? appName
            throw HelperFailure(
                code: "unsupported_command",
                message: "No app state snapshot is available for \(target)"
            )
        }
        return metadata
    }

    func elementId(
        appName: String,
        snapshotId: String?,
        elementIndex: Int,
        commandName: String
    ) throws -> String {
        let metadata = try snapshot(appName: appName, snapshotId: snapshotId)
        let storedSnapshotId = (metadata["snapshotId"] as? String) ?? snapshotId ?? "latest"
        guard let elementIdsByIndex = metadata["elementIdsByIndex"] as? [String],
              elementIndex >= 0,
              elementIndex < elementIdsByIndex.count
        else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Element index \(elementIndex) was not found in snapshot \(storedSnapshotId)"
            )
        }
        let elementId = elementIdsByIndex[elementIndex]
        guard !elementId.isEmpty else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Element index \(elementIndex) was not found in snapshot \(storedSnapshotId)"
            )
        }
        return elementId
    }

    func requestWithPointMetadata(_ request: [String: Any]) throws -> [String: Any] {
        if request["screenshotSource"] != nil,
           request["screenshotWidth"] != nil,
           request["screenshotHeight"] != nil,
           request["sourceBounds"] != nil || request["screenshotSourceBounds"] != nil
        {
            return request
        }

        let appName = try requiredString(request, "app")
        let metadata = try snapshot(appName: appName, snapshotId: optionalString(request, "snapshotId"))
        var enriched = request
        for field in [
            "snapshotId",
            "screenshotSource",
            "screenshotWidth",
            "screenshotHeight",
            "windowId",
            "windowFrame",
        ] {
            if enriched[field] == nil, let value = metadata[field] {
                enriched[field] = value
            }
        }
        if enriched["sourceBounds"] == nil {
            enriched["sourceBounds"] = metadata["screenshotSourceBounds"]
        }
        return enriched
    }
}

let keyModifierDefinitions = [
    KeyModifierDefinition(
        name: "command",
        displayName: "Command",
        keyCode: 55,
        flag: Int(CGEventFlags.maskCommand.rawValue)
    ),
    KeyModifierDefinition(
        name: "control",
        displayName: "Control",
        keyCode: 59,
        flag: Int(CGEventFlags.maskControl.rawValue)
    ),
    KeyModifierDefinition(
        name: "option",
        displayName: "Option",
        keyCode: 58,
        flag: Int(CGEventFlags.maskAlternate.rawValue)
    ),
    KeyModifierDefinition(
        name: "shift",
        displayName: "Shift",
        keyCode: 56,
        flag: Int(CGEventFlags.maskShift.rawValue)
    ),
]

let keyModifierAliases = [
    "alt": "option",
    "altl": "option",
    "altr": "option",
    "cmd": "command",
    "cmdl": "command",
    "cmdr": "command",
    "command": "command",
    "commandl": "command",
    "commandr": "command",
    "control": "control",
    "controll": "control",
    "controlr": "control",
    "ctrl": "control",
    "ctrll": "control",
    "ctrlr": "control",
    "hyper": "command",
    "hyperl": "command",
    "hyperr": "command",
    "meta": "command",
    "metal": "command",
    "metar": "command",
    "option": "option",
    "optionl": "option",
    "optionr": "option",
    "shift": "shift",
    "shiftl": "shift",
    "shiftr": "shift",
    "super": "command",
    "superl": "command",
    "superr": "command",
]

let keyAliases = [
    "apostrophe": "'",
    "backquote": "`",
    "backslash": "\\",
    "bracketleft": "[",
    "bracketright": "]",
    "comma": ",",
    "equal": "=",
    "equals": "=",
    "grave": "`",
    "leftbracket": "[",
    "minus": "-",
    "next": "pagedown",
    "period": ".",
    "pgdn": "pagedown",
    "pgup": "pageup",
    "prior": "pageup",
    "quote": "'",
    "rightbracket": "]",
    "semicolon": ";",
    "slash": "/",
]

let keyCodes = [
    "'": 39,
    ",": 43,
    "-": 27,
    ".": 47,
    "/": 44,
    "0": 29,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "5": 23,
    "6": 22,
    "7": 26,
    "8": 28,
    "9": 25,
    ";": 41,
    "=": 24,
    "[": 33,
    "\\": 42,
    "]": 30,
    "`": 50,
    "a": 0,
    "b": 11,
    "backspace": 51,
    "c": 8,
    "d": 2,
    "delete": 51,
    "down": 125,
    "downarrow": 125,
    "e": 14,
    "end": 119,
    "enter": 36,
    "esc": 53,
    "escape": 53,
    "f": 3,
    "f1": 122,
    "f2": 120,
    "f3": 99,
    "f4": 118,
    "f5": 96,
    "f6": 97,
    "f7": 98,
    "f8": 100,
    "f9": 101,
    "f10": 109,
    "f11": 103,
    "f12": 111,
    "forwarddelete": 117,
    "g": 5,
    "h": 4,
    "home": 115,
    "i": 34,
    "j": 38,
    "k": 40,
    "l": 37,
    "left": 123,
    "leftarrow": 123,
    "m": 46,
    "n": 45,
    "o": 31,
    "p": 35,
    "pagedown": 121,
    "pageup": 116,
    "q": 12,
    "r": 15,
    "return": 36,
    "right": 124,
    "rightarrow": 124,
    "s": 1,
    "space": 49,
    "spacebar": 49,
    "t": 17,
    "tab": 48,
    "u": 32,
    "up": 126,
    "uparrow": 126,
    "v": 9,
    "w": 13,
    "x": 7,
    "y": 16,
    "z": 6,
]

let keyDisplayNames = [
    "'": "Apostrophe",
    ",": "Comma",
    "-": "Minus",
    ".": "Period",
    "/": "Slash",
    ";": "Semicolon",
    "=": "Equal",
    "[": "BracketLeft",
    "\\": "Backslash",
    "]": "BracketRight",
    "`": "Grave",
    "backspace": "Backspace",
    "delete": "Backspace",
    "down": "Down",
    "downarrow": "Down",
    "enter": "Return",
    "esc": "Escape",
    "escape": "Escape",
    "forwarddelete": "ForwardDelete",
    "left": "Left",
    "leftarrow": "Left",
    "pagedown": "PageDown",
    "pageup": "PageUp",
    "return": "Return",
    "right": "Right",
    "rightarrow": "Right",
    "space": "Space",
    "spacebar": "Space",
    "tab": "Tab",
    "up": "Up",
    "uparrow": "Up",
]

let keySyntaxHint =
    "Use xdotool-style names such as shift+semicolon, Control_L+J, ctrl+alt+n, or BackSpace."

struct WindowTarget {
    let pid: pid_t
    let windowNumber: Int
    let title: String?
    let frame: CGRect
}

struct WindowScreenshot {
    let dataUrl: String
    let width: Int
    let height: Int
}

struct AXWindowInfo {
    let title: String?
    let frame: CGRect?
    let isFocused: Bool
    let isMain: Bool
}

struct CGWindowCandidate {
    let windowNumber: Int
    let title: String?
    let frame: CGRect
    let area: Double
}

struct KeyModifierDefinition {
    let name: String
    let displayName: String
    let keyCode: Int
    let flag: Int
}

struct ParsedKeyPress {
    let keyCode: Int
    let modifiers: [KeyModifierDefinition]
    let flags: Int
    let normalizedKey: String
}

final class LaunchResultBox: @unchecked Sendable {
    var app: NSRunningApplication?
    var error: Error?
}

final class RunLoopReference: @unchecked Sendable {
    let runLoop: CFRunLoop

    init(_ runLoop: CFRunLoop) {
        self.runLoop = runLoop
    }
}

enum BackgroundWindowLocalEvent {
    private typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void

    private static let setWindowLocation: SetWindowLocationFn? = {
        _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else {
            return nil
        }
        return unsafeBitCast(symbol, to: SetWindowLocationFn.self)
    }()

    @discardableResult
    static func setPoint(_ point: CGPoint, on event: CGEvent) -> Bool {
        guard let setWindowLocation else { return false }
        setWindowLocation(event, point)
        return true
    }
}

final class HelperRunLoopThread: @unchecked Sendable {
    static let shared = HelperRunLoopThread()

    private final class RunLoopBox: @unchecked Sendable {
        var runLoop: CFRunLoop?
    }

    private let runLoop: CFRunLoop

    private init() {
        let box = RunLoopBox()
        let semaphore = DispatchSemaphore(value: 0)

        Thread.detachNewThread {
            let timer = Timer(timeInterval: 3_600, repeats: true) { _ in }
            RunLoop.current.add(timer, forMode: .common)
            box.runLoop = CFRunLoopGetCurrent()
            semaphore.signal()
            RunLoop.current.run()
        }

        semaphore.wait()
        guard let runLoop = box.runLoop else {
            fatalError("Unable to start helper run loop thread")
        }
        self.runLoop = runLoop
    }

    func addSource(_ source: CFRunLoopSource, mode: CFRunLoopMode = .commonModes) {
        CFRunLoopAddSource(runLoop, source, mode)
        CFRunLoopWakeUp(runLoop)
    }
}

final class ComputerUseVisualPointerView: NSView {
    var rotationDegrees: CGFloat = 0 {
        didSet {
            needsDisplay = true
        }
    }

    private let targetAnchor = CGPoint(x: 8, y: 6)

    override var isFlipped: Bool {
        true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        NSGraphicsContext.saveGraphicsState()
        let transform = NSAffineTransform()
        transform.translateX(by: targetAnchor.x, yBy: targetAnchor.y)
        transform.rotate(byDegrees: rotationDegrees)
        transform.translateX(by: -targetAnchor.x, yBy: -targetAnchor.y)
        transform.concat()

        let path = NSBezierPath()
        path.move(to: CGPoint(x: 8, y: 6))
        path.line(to: CGPoint(x: 20.5, y: 16))
        path.line(to: CGPoint(x: 13, y: 15.5))
        path.line(to: CGPoint(x: 8, y: 22))
        path.close()

        let bottomShadow = NSShadow()
        bottomShadow.shadowColor = NSColor(calibratedWhite: 0.02, alpha: 0.48)
        bottomShadow.shadowBlurRadius = 3.4
        bottomShadow.shadowOffset = NSSize(width: 0.9, height: -2.1)
        bottomShadow.set()

        NSColor(calibratedRed: 0.34, green: 0.37, blue: 0.40, alpha: 1).setFill()
        path.fill()

        NSGraphicsContext.current?.cgContext.setShadow(offset: .zero, blur: 0, color: nil)
        NSColor(calibratedWhite: 1, alpha: 0.9).setStroke()
        path.lineWidth = 1.1
        path.lineJoinStyle = .round
        path.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }
}

final class ComputerUseVisualPointer: @unchecked Sendable {
    static let shared = ComputerUseVisualPointer()

    private let pointerSize = CGSize(width: 30, height: 30)
    private let targetAnchor = CGPoint(x: 8, y: 6)
    private let idleHideDelay: TimeInterval = 60
    private var window: NSPanel?
    private var baseFrame: CGRect?
    private var hideTimer: Timer?
    private var moveTimer: Timer?
    private var swayTimer: Timer?
    private var swayStartedAt: TimeInterval?

    private init() {}

    func show(at screenPoint: CGPoint) {
        guard screenPoint.x.isFinite, screenPoint.y.isFinite else {
            return
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                showOnMain(at: screenPoint)
            }
            return
        }
        DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                showOnMain(at: screenPoint)
            }
        }
    }

    func hide() {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                hideOnMain()
            }
            return
        }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.hideOnMain()
            }
        }
    }

    @MainActor
    private func showOnMain(at screenPoint: CGPoint) {
        let window = ensureWindow()
        let frame = windowFrame(for: screenPoint)
        hideTimer?.invalidate()
        window.orderFrontRegardless()

        if window.alphaValue == 0 || !window.isVisible {
            moveTimer?.invalidate()
            moveTimer = nil
            baseFrame = frame
            applyVisualFrame()
            startSwayAnimation()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                window.animator().alphaValue = 0.96
            }
        } else {
            startSwayAnimation()
            moveWindowAlongArc(window, to: frame)
            window.alphaValue = 0.96
        }

        hideTimer = Timer.scheduledTimer(withTimeInterval: idleHideDelay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.hideOnMain()
            }
        }
        if let hideTimer {
            RunLoop.main.add(hideTimer, forMode: .common)
        }
    }

    @MainActor
    private func hideOnMain() {
        hideTimer?.invalidate()
        hideTimer = nil
        moveTimer?.invalidate()
        moveTimer = nil
        stopSwayAnimation()
        baseFrame = nil
        guard let window, window.isVisible else {
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            window.animator().alphaValue = 0
        } completionHandler: {
            MainActor.assumeIsolated {
                window.orderOut(nil)
            }
        }
    }

    @MainActor
    private func startSwayAnimation() {
        if swayTimer != nil {
            return
        }
        swayStartedAt = Date.timeIntervalSinceReferenceDate
        let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.updateSway()
            }
        }
        swayTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    @MainActor
    private func stopSwayAnimation() {
        swayTimer?.invalidate()
        swayTimer = nil
        swayStartedAt = nil
        pointerView()?.rotationDegrees = 0
        applyVisualFrame()
    }

    @MainActor
    private func updateSway() {
        guard let swayStartedAt else {
            return
        }
        let elapsed = Date.timeIntervalSinceReferenceDate - swayStartedAt
        let phase = elapsed * Double.pi * 2 / 3.8
        pointerView()?.rotationDegrees = CGFloat(sin(phase) * 5)
        window?.alphaValue = 0.94 + CGFloat((sin(phase - Double.pi / 2) + 1) * 0.025)
    }

    @MainActor
    private func pointerView() -> ComputerUseVisualPointerView? {
        window?.contentView as? ComputerUseVisualPointerView
    }

    @MainActor
    private func applyVisualFrame() {
        guard let window, let baseFrame else {
            return
        }
        window.setFrame(baseFrame, display: true)
    }

    @MainActor
    private func moveWindowAlongArc(_ window: NSPanel, to targetFrame: CGRect) {
        moveTimer?.invalidate()
        let startFrame = baseFrame ?? window.frame
        let start = CGPoint(x: startFrame.minX, y: startFrame.minY)
        let end = CGPoint(x: targetFrame.minX, y: targetFrame.minY)
        let delta = CGPoint(x: end.x - start.x, y: end.y - start.y)
        let distance = hypot(Double(delta.x), Double(delta.y))
        guard distance > 1 else {
            window.setFrame(targetFrame, display: true)
            return
        }

        let duration = min(0.52, max(0.26, distance / 700))
        let curve = CGFloat(min(110, max(14, distance * 0.28)))
        let sign: CGFloat = delta.x >= 0 ? 1 : -1
        let normalizedDistance = CGFloat(distance)
        let overshootDistance = CGFloat(min(26, max(4, distance * 0.07)))
        let overshoot = CGPoint(
            x: end.x + (delta.x / normalizedDistance) * overshootDistance,
            y: end.y + (delta.y / normalizedDistance) * overshootDistance
        )
        let control = CGPoint(
            x: (start.x + end.x) / 2 - (delta.y / normalizedDistance) * curve * sign,
            y: (start.y + end.y) / 2 + (delta.x / normalizedDistance) * curve * sign
        )
        let startedAt = Date.timeIntervalSinceReferenceDate
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self, weak window] _ in
            MainActor.assumeIsolated {
                guard window != nil else {
                    self?.moveTimer?.invalidate()
                    self?.moveTimer = nil
                    return
                }
                let elapsed = Date.timeIntervalSinceReferenceDate - startedAt
                let progress = min(1, elapsed / duration)
                let origin: CGPoint
                if progress < 0.82 {
                    let legProgress = Self.easeInOut(progress / 0.82)
                    origin = Self.quadraticBezierPoint(
                        from: start,
                        control: control,
                        to: overshoot,
                        progress: legProgress
                    )
                } else {
                    let legProgress = Self.easeOut((progress - 0.82) / 0.18)
                    origin = Self.linearPoint(from: overshoot, to: end, progress: legProgress)
                }
                self?.baseFrame = CGRect(origin: origin, size: targetFrame.size)
                self?.applyVisualFrame()
                if progress >= 1 {
                    self?.moveTimer?.invalidate()
                    self?.moveTimer = nil
                    self?.baseFrame = targetFrame
                    self?.applyVisualFrame()
                }
            }
        }
        moveTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private static func easeInOut(_ progress: TimeInterval) -> TimeInterval {
        if progress < 0.5 {
            return 4 * progress * progress * progress
        }
        let adjusted = -2 * progress + 2
        return 1 - adjusted * adjusted * adjusted / 2
    }

    private static func easeOut(_ progress: TimeInterval) -> TimeInterval {
        let inverse = 1 - progress
        return 1 - inverse * inverse * inverse
    }

    private static func linearPoint(from start: CGPoint, to end: CGPoint, progress: TimeInterval) -> CGPoint {
        let t = CGFloat(progress)
        return CGPoint(
            x: start.x + (end.x - start.x) * t,
            y: start.y + (end.y - start.y) * t
        )
    }

    private static func quadraticBezierPoint(
        from start: CGPoint,
        control: CGPoint,
        to end: CGPoint,
        progress: TimeInterval
    ) -> CGPoint {
        let t = CGFloat(progress)
        let inverse = 1 - t
        return CGPoint(
            x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
            y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y
        )
    }

    @MainActor
    private func ensureWindow() -> NSPanel {
        if let window {
            return window
        }

        NSApplication.shared.setActivationPolicy(.accessory)
        let window = NSPanel(
            contentRect: CGRect(origin: .zero, size: pointerSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .screenSaver
        window.alphaValue = 0
        window.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        window.contentView = ComputerUseVisualPointerView(frame: CGRect(origin: .zero, size: pointerSize))
        self.window = window
        return window
    }

    @MainActor
    private func windowFrame(for screenPoint: CGPoint) -> CGRect {
        let topLeftQuartzPoint = CGPoint(
            x: screenPoint.x - targetAnchor.x,
            y: screenPoint.y - targetAnchor.y
        )
        let topLeftAppKitPoint = appKitTopLeftPoint(fromQuartzTopLeftPoint: topLeftQuartzPoint)
        return CGRect(
            x: topLeftAppKitPoint.x,
            y: topLeftAppKitPoint.y - pointerSize.height,
            width: pointerSize.width,
            height: pointerSize.height
        )
    }

    @MainActor
    private func appKitTopLeftPoint(fromQuartzTopLeftPoint point: CGPoint) -> CGPoint {
        let match = displayMatch(forQuartzPoint: point)
        return CGPoint(
            x: match.screenFrame.minX + point.x - match.displayBounds.minX,
            y: match.screenFrame.maxY - (point.y - match.displayBounds.minY)
        )
    }

    @MainActor
    private func displayMatch(forQuartzPoint point: CGPoint) -> (displayBounds: CGRect, screenFrame: CGRect) {
        let displays = activeDisplays()
        if let containing = displays.first(where: { display in
            display.displayBounds.contains(point)
        }) {
            return containing
        }
        if let nearest = displays.min(by: { left, right in
            distance(point, to: left.displayBounds) < distance(point, to: right.displayBounds)
        }) {
            return nearest
        }
        let screenFrame = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 0, height: 0)
        return (CGRect(x: 0, y: 0, width: screenFrame.width, height: screenFrame.height), screenFrame)
    }

    @MainActor
    private func activeDisplays() -> [(displayBounds: CGRect, screenFrame: CGRect)] {
        var displayCount: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
            return []
        }
        var displayIds = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        guard CGGetActiveDisplayList(displayCount, &displayIds, &displayCount) == .success else {
            return []
        }
        return displayIds.prefix(Int(displayCount)).compactMap { displayId in
            guard let screen = screen(for: displayId) else {
                return nil
            }
            return (CGDisplayBounds(displayId), screen.frame)
        }
    }

    @MainActor
    private func screen(for displayId: CGDirectDisplayID) -> NSScreen? {
        let screenNumberKey = NSDeviceDescriptionKey("NSScreenNumber")
        return NSScreen.screens.first { screen in
            guard let number = screen.deviceDescription[screenNumberKey] as? NSNumber else {
                return false
            }
            return number.uint32Value == displayId
        }
    }

    @MainActor
    private func distance(_ point: CGPoint, to rect: CGRect) -> CGFloat {
        if rect.contains(point) {
            return 0
        }
        let x = min(max(point.x, rect.minX), rect.maxX)
        let y = min(max(point.y, rect.minY), rect.maxY)
        return hypot(point.x - x, point.y - y)
    }
}

enum BackgroundWindowScreenshot {
    private static let maxLongEdgePixels = 1_600
    private static let maxPixelArea = 1_920_000

    private typealias CreateImageFn = @convention(c) (
        CGRect,
        UInt32,
        CGWindowID,
        UInt32
    ) -> Unmanaged<CGImage>?

    private static let createImage: CreateImageFn? = {
        _ = dlopen(
            "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
            RTLD_LAZY
        )
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else {
            return nil
        }
        return unsafeBitCast(symbol, to: CreateImageFn.self)
    }()

    static func capture(windowNumber: Int) throws -> WindowScreenshot {
        guard let createImage else {
            throw HelperFailure(
                code: "screen_recording_unavailable",
                message: "Native window screenshot capture is unavailable"
            )
        }
        let imageOptions: CGWindowImageOption = [.bestResolution, .boundsIgnoreFraming]
        guard let image = createImage(
            .null,
            CGWindowListOption.optionIncludingWindow.rawValue,
            CGWindowID(windowNumber),
            imageOptions.rawValue
        )?.takeRetainedValue() else {
            throw HelperFailure(
                code: "screen_recording_unavailable",
                message: "Unable to capture target window screenshot"
            )
        }
        let scaledImage = scaledForTransport(image)
        let bitmap = NSBitmapImageRep(cgImage: scaledImage)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw HelperFailure(
                code: "screen_recording_unavailable",
                message: "Unable to encode target window screenshot"
            )
        }
        return WindowScreenshot(
            dataUrl: "data:image/png;base64,\(data.base64EncodedString())",
            width: scaledImage.width,
            height: scaledImage.height
        )
    }

    private static func scaledForTransport(_ image: CGImage) -> CGImage {
        let width = image.width
        let height = image.height
        let longEdge = max(width, height)
        let area = width * height
        let longEdgeScale = CGFloat(maxLongEdgePixels) / CGFloat(max(longEdge, 1))
        let areaScale = sqrt(CGFloat(maxPixelArea) / CGFloat(max(area, 1)))
        let scale = min(1, min(longEdgeScale, areaScale))
        guard scale < 1 else {
            return image
        }

        let scaledWidth = max(1, Int((CGFloat(width) * scale).rounded()))
        let scaledHeight = max(1, Int((CGFloat(height) * scale).rounded()))
        guard let context = CGContext(
            data: nil,
            width: scaledWidth,
            height: scaledHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return image
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: scaledWidth, height: scaledHeight))
        return context.makeImage() ?? image
    }
}

extension CGEvent {
    private static let targetWindowNumberField = CGEventField(rawValue: 51)
    private static let privateWindowRoutingField = CGEventField(rawValue: 58)

    func setWindowAddressingFields(windowNumber: Int) {
        if let targetWindowNumberField = Self.targetWindowNumberField {
            setIntegerValueField(targetWindowNumberField, value: Int64(windowNumber))
        }
        if let privateWindowRoutingField = Self.privateWindowRoutingField {
            setIntegerValueField(privateWindowRoutingField, value: 1)
        }
    }
}

func windowLocalPoint(fromScreenPoint point: CGPoint, windowFrame: CGRect) -> CGPoint {
    return CGPoint(x: point.x - windowFrame.minX, y: point.y - windowFrame.minY)
}

func quartzWindowPoint(fromWindowLocal point: CGPoint, windowHeight: CGFloat) -> CGPoint {
    return CGPoint(x: point.x, y: windowHeight - point.y)
}

struct AddressedEventDispatcher {
    let target: WindowTarget

    func postMouse(
        _ type: CGEventType,
        at screenPoint: CGPoint,
        button: CGMouseButton,
        clickState: Int64,
        pressure: Double
    ) throws {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: screenPoint,
            mouseButton: button
        ) else {
            throw HelperFailure(code: "accessibility_unavailable", message: "Unable to create mouse event")
        }

        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.setDoubleValueField(.mouseEventPressure, value: pressure)
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(target.pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowNumber))
        event.setIntegerValueField(
            .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
            value: Int64(target.windowNumber)
        )
        event.setWindowAddressingFields(windowNumber: target.windowNumber)

        let localPoint = windowLocalPoint(fromScreenPoint: screenPoint, windowFrame: target.frame)
        let quartzPoint = quartzWindowPoint(fromWindowLocal: localPoint, windowHeight: target.frame.height)
        guard BackgroundWindowLocalEvent.setPoint(quartzPoint, on: event) else {
            throw HelperFailure(
                code: "accessibility_unavailable",
                message: "Unable to address target window with CGEventSetWindowLocation"
            )
        }

        event.postToPid(target.pid)
    }

    func postKey(keyCode: Int, keyDown: Bool, flags: Int) throws {
        guard let event = CGEvent(
            keyboardEventSource: nil,
            virtualKey: CGKeyCode(keyCode),
            keyDown: keyDown
        ) else {
            throw HelperFailure(code: "accessibility_unavailable", message: "Unable to create keyboard event")
        }
        event.flags = CGEventFlags(rawValue: UInt64(flags))
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(target.pid))
        event.setWindowAddressingFields(windowNumber: target.windowNumber)
        event.postToPid(target.pid)
    }

    func postText(_ text: String) throws {
        for character in text {
            try postTextCharacter(character)
            usleep(5_000)
        }
    }

    private func postTextCharacter(_ character: Character) throws {
        let utf16 = Array(String(character).utf16)
        guard !utf16.isEmpty else {
            return
        }

        let keyDown = try textKeyboardEvent(keyDown: true, utf16: utf16)
        keyDown.postToPid(target.pid)

        let keyUp = try textKeyboardEvent(keyDown: false, utf16: utf16)
        keyUp.postToPid(target.pid)
    }

    private func textKeyboardEvent(keyDown: Bool, utf16: [UInt16]) throws -> CGEvent {
        guard let event = CGEvent(
            keyboardEventSource: nil,
            virtualKey: 0,
            keyDown: keyDown
        ) else {
            throw HelperFailure(code: "accessibility_unavailable", message: "Unable to create text keyboard event")
        }
        utf16.withUnsafeBufferPointer { buffer in
            event.keyboardSetUnicodeString(
                stringLength: utf16.count,
                unicodeString: buffer.baseAddress
            )
        }
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(target.pid))
        event.setWindowAddressingFields(windowNumber: target.windowNumber)
        return event
    }
}

final class BackgroundActivationSession: @unchecked Sendable {
    enum TapKind {
        case previous
        case target
    }

    private enum Phase {
        case deliveringToTarget
        case holding
        case finished
    }

    final class TapContext {
        let session: BackgroundActivationSession
        let kind: TapKind

        init(session: BackgroundActivationSession, kind: TapKind) {
            self.session = session
            self.kind = kind
        }
    }

    private static let focusSuppressionEventMask = CGEventMask.max

    private let target: WindowTarget
    private let stateLock = NSLock()
    private var phase: Phase = .deliveringToTarget
    private var taps: [CFMachPort] = []
    private var contexts: [TapContext] = []
    private var finished = false

    private init(target: WindowTarget) {
        self.target = target
    }

    static func start(target: WindowTarget) -> BackgroundActivationSession {
        let session = BackgroundActivationSession(target: target)
        session.installTapsIfPossible(previousApp: NSWorkspace.shared.frontmostApplication)
        return session
    }

    var hasFocusSuppressionTaps: Bool {
        !taps.isEmpty
    }

    func beginTargetDelivery() {
        guard hasFocusSuppressionTaps else { return }
        setPhase(.deliveringToTarget)
    }

    func holdFocusSuppressionUntilFinish() {
        guard hasFocusSuppressionTaps else { return }
        setPhase(.holding)
    }

    func activateWindow() {
        Self.postWindowActivationEvent(targetPID: target.pid, windowNumber: target.windowNumber)
        Self.postWindowCenterPrimer(target: target)
    }

    func finish() {
        stateLock.lock()
        guard !finished else {
            stateLock.unlock()
            return
        }
        finished = true
        phase = .finished
        stateLock.unlock()

        for tap in taps {
            CFMachPortInvalidate(tap)
        }
        taps.removeAll()
        contexts.removeAll()
    }

    deinit {
        finish()
    }

    private static func postWindowActivationEvent(targetPID: pid_t, windowNumber: Int) {
        guard windowNumber != 0 else { return }
        let event = NSEvent.otherEvent(
            with: .appKitDefined,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: windowNumber,
            context: nil,
            subtype: Int16(1),
            data1: 0,
            data2: 0
        )?.cgEvent
        guard let event else { return }
        event.setWindowAddressingFields(windowNumber: windowNumber)
        event.postToPid(targetPID)
        usleep(20_000)
    }

    private static func postWindowCenterPrimer(target: WindowTarget) {
        guard target.windowNumber != 0, target.frame.width > 0, target.frame.height > 0 else {
            return
        }

        let point = CGPoint(x: target.frame.midX, y: target.frame.midY)
        let dispatcher = AddressedEventDispatcher(target: target)
        try? dispatcher.postMouse(
            .leftMouseDown,
            at: point,
            button: .left,
            clickState: 1,
            pressure: 1
        )
        usleep(30_000)
        try? dispatcher.postMouse(
            .leftMouseUp,
            at: point,
            button: .left,
            clickState: 1,
            pressure: 0
        )
        usleep(20_000)
    }

    private func installTapsIfPossible(previousApp: NSRunningApplication?) {
        guard let previousApp, previousApp.processIdentifier != target.pid else { return }

        do {
            try installTap(kind: .previous, pid: previousApp.processIdentifier)
            try installTap(kind: .target, pid: target.pid)
        } catch {
            for tap in taps {
                CFMachPortInvalidate(tap)
            }
            taps.removeAll()
            contexts.removeAll()
        }
    }

    private func installTap(kind: TapKind, pid: pid_t) throws {
        let context = TapContext(session: self, kind: kind)
        let pointer = Unmanaged.passUnretained(context).toOpaque()

        guard let tap = CGEvent.tapCreateForPid(
            pid: pid,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: Self.focusSuppressionEventMask,
            callback: backgroundActivationEventTapCallback,
            userInfo: pointer
        ) else {
            throw HelperFailure(
                code: "accessibility_unavailable",
                message: "Unable to install background focus event tap for pid \(pid)"
            )
        }

        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            throw HelperFailure(
                code: "accessibility_unavailable",
                message: "Unable to install background focus event tap run loop source for pid \(pid)"
            )
        }

        HelperRunLoopThread.shared.addSource(source)
        CGEvent.tapEnable(tap: tap, enable: true)
        contexts.append(context)
        taps.append(tap)
    }

    func shouldDrop(kind: TapKind, type: CGEventType) -> Bool {
        guard isFocusMessage(type: type) else { return false }

        stateLock.lock()
        let currentPhase = phase
        stateLock.unlock()

        switch currentPhase {
        case .deliveringToTarget, .holding:
            return kind == .previous
        case .finished:
            return false
        }
    }

    private func setPhase(_ newPhase: Phase) {
        stateLock.lock()
        phase = newPhase
        stateLock.unlock()
    }

    private func isFocusMessage(type: CGEventType) -> Bool {
        type.rawValue == 13 || type.rawValue == 19 || type.rawValue == 20
    }
}

nonisolated(unsafe) private let backgroundActivationEventTapCallback: CGEventTapCallBack = { _, type, event, rawContext in
    guard let rawContext else {
        return Unmanaged.passUnretained(event)
    }

    let context = Unmanaged<BackgroundActivationSession.TapContext>
        .fromOpaque(rawContext)
        .takeUnretainedValue()

    if context.session.shouldDrop(kind: context.kind, type: type) {
        return nil
    }

    return Unmanaged.passUnretained(event)
}

func isRecord(_ value: Any) -> [String: Any]? {
    return value as? [String: Any]
}

func requiredString(_ request: [String: Any], _ key: String) throws -> String {
    guard let value = request[key] as? String else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    return trimmed
}

func requiredNumber(_ request: [String: Any], _ key: String) throws -> Double {
    guard let value = request[key] as? NSNumber else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    return value.doubleValue
}

func optionalString(_ request: [String: Any], _ key: String) -> String? {
    guard let value = request[key] as? String else {
        return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

func optionalInt(_ request: [String: Any], _ key: String) -> Int? {
    return (request[key] as? NSNumber)?.intValue
}

func optionalInt(_ request: [String: Any], _ key: String, default defaultValue: Int) -> Int {
    return (request[key] as? NSNumber)?.intValue ?? defaultValue
}

func rectPayload(_ request: [String: Any], _ key: String) throws -> CGRect {
    guard let record = request[key] as? [String: Any],
          let x = record["x"] as? NSNumber,
          let y = record["y"] as? NSNumber,
          let width = record["width"] as? NSNumber,
          let height = record["height"] as? NSNumber
    else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    let rect = CGRect(
        x: x.doubleValue,
        y: y.doubleValue,
        width: width.doubleValue,
        height: height.doubleValue
    )
    guard rect.width > 0, rect.height > 0 else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Invalid bounds payload field: \(key)"
        )
    }
    return rect
}

func optionalRectPayload(_ request: [String: Any], _ key: String) throws -> CGRect? {
    if request[key] == nil {
        return nil
    }
    return try rectPayload(request, key)
}

func findRunningApp(named appName: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications.filter { app in
        !app.isTerminated
    }

    if let exactBundle = apps.first(where: { app in
        app.bundleIdentifier == appName
    }) {
        return exactBundle
    }

    let normalized = appName.lowercased()
    if let bundleMatch = apps.first(where: { app in
        app.bundleIdentifier?.lowercased() == normalized
    }) {
        return bundleMatch
    }

    if let exactName = apps.first(where: { app in
        app.localizedName == appName
    }) {
        return exactName
    }

    return apps.first { app in
        app.localizedName?.lowercased() == normalized
    }
}

func resolveRunningApp(named appName: String) throws -> NSRunningApplication {
    guard let app = findRunningApp(named: appName) else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "App is not running: \(appName)"
        )
    }
    return app
}

func appElement(named appName: String) throws -> AXUIElement {
    let app = try resolveRunningApp(named: appName)
    return AXUIElementCreateApplication(app.processIdentifier)
}

func trimmedPipeOutput(_ pipe: Pipe) -> String {
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func appOpenFailureCode(_ stderr: String) -> String {
    let normalized = stderr.lowercased()
    if normalized.contains("unable to find application") ||
        normalized.contains("does not exist")
    {
        return "app_not_found"
    }
    return "app_open_failed"
}

func attribute(_ element: AXUIElement, _ name: CFString) -> Any? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name, &value)
    if error != .success {
        return nil
    }
    return value
}

func attributeArray(_ element: AXUIElement, _ name: CFString) -> [AXUIElement] {
    guard let value = attribute(element, name) else {
        return []
    }
    if let elements = value as? [AXUIElement] {
        return elements
    }
    if let elements = value as? [Any] {
        return elements.compactMap { entry in
            axElementValue(entry)
        }
    }
    return []
}

func axElementValue(_ value: Any?) -> AXUIElement? {
    guard let value else {
        return nil
    }
    let cfValue = value as CFTypeRef
    if CFGetTypeID(cfValue) != AXUIElementGetTypeID() {
        return nil
    }
    return (value as! AXUIElement)
}

func axValueValue(_ value: Any?) -> AXValue? {
    guard let value else {
        return nil
    }
    let cfValue = value as CFTypeRef
    if CFGetTypeID(cfValue) != AXValueGetTypeID() {
        return nil
    }
    return (value as! AXValue)
}

func stringValue(_ value: Any?) -> String? {
    if let string = value as? String {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    if let number = value as? NSNumber {
        return number.stringValue
    }
    return nil
}

func stringArrayValue(_ value: Any?) -> [String] {
    if let strings = value as? [String] {
        return strings.compactMap { entry in
            stringValue(entry)
        }
    }
    if let entries = value as? [Any] {
        return entries.compactMap { entry in
            stringValue(entry)
        }
    }
    if let string = stringValue(value) {
        return [string]
    }
    return []
}

func urlStringValue(_ value: Any?) -> String? {
    if let url = value as? URL {
        return stringValue(url.absoluteString)
    }
    if let url = value as? NSURL {
        return stringValue(url.absoluteString)
    }
    return stringValue(value)
}

func boolValue(_ value: Any?) -> Bool? {
    return (value as? NSNumber)?.boolValue
}

func numberValue(_ value: Any?) -> Double? {
    if let number = value as? NSNumber {
        return number.doubleValue
    }
    if let string = value as? String {
        return Double(string)
    }
    return nil
}

func pointValue(_ value: Any?) -> CGPoint? {
    guard let axValue = axValueValue(value), AXValueGetType(axValue) == .cgPoint else {
        return nil
    }
    var point = CGPoint.zero
    AXValueGetValue(axValue, .cgPoint, &point)
    return point
}

func sizeValue(_ value: Any?) -> CGSize? {
    guard let axValue = axValueValue(value), AXValueGetType(axValue) == .cgSize else {
        return nil
    }
    var size = CGSize.zero
    AXValueGetValue(axValue, .cgSize, &size)
    return size
}

func role(_ element: AXUIElement) -> String? {
    return stringValue(attribute(element, kAXRoleAttribute as CFString))
}

func elementFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = pointValue(attribute(element, kAXPositionAttribute as CFString)),
          let size = sizeValue(attribute(element, kAXSizeAttribute as CFString))
    else {
        return nil
    }
    return CGRect(origin: position, size: size)
}

func boundsRecord(_ frame: CGRect) -> [String: Double] {
    return [
        "x": Double(frame.minX),
        "y": Double(frame.minY),
        "width": Double(frame.width),
        "height": Double(frame.height),
    ]
}

func bounds(_ element: AXUIElement) -> [String: Double]? {
    guard let frame = elementFrame(element) else {
        return nil
    }
    return boundsRecord(frame)
}

func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let error = AXUIElementCopyActionNames(element, &names)
    if error != .success {
        return []
    }
    return ((names as? [String]) ?? []).prefix(limits.maxActions).map { name in
        name
    }
}

let axPressActionName = "AXPress"
let axPickActionName = "AXPick"
let selectableRoles: Set<String> = ["AXCell", "AXColumn", "AXRow", "AXTab"]
let selectableSubroles: Set<String> = ["AXOutlineRow"]

enum ElementClickStrategy: String {
    case mouse
    case pick
    case press
}

struct ElementClickCapabilities {
    let role: String?
    let subrole: String?
    let frame: CGRect?
    let pressable: Bool
    let pickable: Bool
    let selectable: Bool
    let mouseClickable: Bool
    let webAreaMouseClick: Bool

    var clickableKind: String? {
        if webAreaMouseClick, frame != nil {
            return "mouse"
        }
        if pressable {
            return "press"
        }
        if pickable {
            return "pick"
        }
        if selectable, frame != nil {
            return "select"
        }
        if mouseClickable {
            return "mouse"
        }
        return nil
    }
}

struct ElementClickTarget {
    let element: AXUIElement
    let capabilities: ElementClickCapabilities
    let promotedDepth: Int
    let strategy: ElementClickStrategy
}

func clickableFrame(_ element: AXUIElement) -> CGRect? {
    guard let frame = elementFrame(element),
          frame.width > 0,
          frame.height > 0
    else {
        return nil
    }
    return frame
}

func isSelectableElement(role roleName: String?, subrole: String?, selected: Bool?) -> Bool {
    if let roleName, selectableRoles.contains(roleName), selected != nil {
        return true
    }
    if let subrole, selectableSubroles.contains(subrole), selected != nil {
        return true
    }
    return false
}

func clickCapabilities(
    _ element: AXUIElement,
    actions actionList: [String]? = nil,
    selected selectedValue: Bool? = nil
) -> ElementClickCapabilities {
    let elementRole = role(element)
    let elementSubrole = stringValue(attribute(element, kAXSubroleAttribute as CFString))
    let elementActions = Set(actionList ?? actionNames(element))
    let elementSelected = selectedValue ?? boolValue(attribute(element, kAXSelectedAttribute as CFString))
    let frame = clickableFrame(element)
    let selectable = isSelectableElement(role: elementRole, subrole: elementSubrole, selected: elementSelected)
    let webAreaMouseClick = shouldUseMouseClickForElement(element)
    let mouseClickable = frame != nil && (webAreaMouseClick || selectable)
    return ElementClickCapabilities(
        role: elementRole,
        subrole: elementSubrole,
        frame: frame,
        pressable: elementActions.contains(axPressActionName),
        pickable: elementActions.contains(axPickActionName),
        selectable: selectable,
        mouseClickable: mouseClickable,
        webAreaMouseClick: webAreaMouseClick
    )
}

func preferredClickStrategy(_ capabilities: ElementClickCapabilities) -> ElementClickStrategy? {
    if capabilities.webAreaMouseClick, capabilities.frame != nil {
        return .mouse
    }
    if capabilities.pressable {
        return .press
    }
    if capabilities.pickable {
        return .pick
    }
    if capabilities.mouseClickable {
        return .mouse
    }
    return nil
}

func setClickCapabilityFields(_ node: inout [String: Any], capabilities: ElementClickCapabilities) {
    if capabilities.pressable {
        node["pressable"] = true
    }
    if capabilities.pickable {
        node["pickable"] = true
    }
    if capabilities.selectable {
        node["selectable"] = true
    }
    if capabilities.mouseClickable {
        node["mouseClickable"] = true
    }
    if let clickableKind = capabilities.clickableKind {
        node["clickableKind"] = clickableKind
    }
}

func attributeIsSettable(_ element: AXUIElement, _ name: CFString) -> Bool? {
    var settable = DarwinBoolean(false)
    let error = AXUIElementIsAttributeSettable(element, name, &settable)
    if error != .success {
        return nil
    }
    return settable.boolValue
}

func valueTypeDescription(_ value: Any?) -> String? {
    guard let value else {
        return nil
    }
    if value is String {
        return "string"
    }
    if value is URL || value is NSURL {
        return "url"
    }
    if let number = value as? NSNumber {
        if CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() {
            return "boolean"
        }
        return "number"
    }
    if let axValue = axValueValue(value) {
        switch AXValueGetType(axValue) {
        case .cgPoint:
            return "point"
        case .cgSize:
            return "size"
        case .cgRect:
            return "rect"
        case .cfRange:
            return "range"
        default:
            return "value"
        }
    }
    if axElementValue(value) != nil {
        return "element"
    }
    if value is [Any] {
        return "array"
    }
    return nil
}

func axElementsEqual(_ left: AXUIElement?, _ right: AXUIElement) -> Bool {
    guard let left else { return false }
    return CFEqual(left, right)
}

func axWindowInfos(root: AXUIElement) -> [AXWindowInfo] {
    let focusedWindow = axElementValue(attribute(root, kAXFocusedWindowAttribute as CFString))
    let mainWindow = axElementValue(attribute(root, kAXMainWindowAttribute as CFString))
    return attributeArray(root, kAXWindowsAttribute as CFString).map { window in
        AXWindowInfo(
            title: stringValue(attribute(window, kAXTitleAttribute as CFString)),
            frame: elementFrame(window),
            isFocused: axElementsEqual(focusedWindow, window) ||
                boolValue(attribute(window, kAXFocusedAttribute as CFString)) == true,
            isMain: axElementsEqual(mainWindow, window)
        )
    }
}

func cgWindowBounds(_ value: Any?) -> CGRect? {
    guard let dictionary = value as? [String: Any] else {
        return nil
    }
    return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
}

func cgWindowCandidates(pid: pid_t) -> [CGWindowCandidate] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let rawList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    return rawList.compactMap { record in
        guard (record[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (record[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let windowNumber = (record[kCGWindowNumber as String] as? NSNumber)?.intValue,
              let frame = cgWindowBounds(record[kCGWindowBounds as String]),
              frame.width > 0,
              frame.height > 0
        else {
            return nil
        }
        let title = stringValue(record[kCGWindowName as String])
        return CGWindowCandidate(
            windowNumber: windowNumber,
            title: title,
            frame: frame,
            area: Double(frame.width * frame.height)
        )
    }
}

func rectDistance(_ left: CGRect, _ right: CGRect) -> Double {
    let x = abs(left.minX - right.minX)
    let y = abs(left.minY - right.minY)
    let width = abs(left.width - right.width)
    let height = abs(left.height - right.height)
    return Double(x + y + width + height)
}

func pointDistanceToRect(_ point: CGPoint, _ rect: CGRect) -> Double {
    if rect.contains(point) {
        return 0
    }
    let clampedX = min(max(point.x, rect.minX), rect.maxX)
    let clampedY = min(max(point.y, rect.minY), rect.maxY)
    return Double(hypot(point.x - clampedX, point.y - clampedY))
}

func titlePenalty(candidate: String?, axTitle: String?) -> Double {
    guard let candidate = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
          let axTitle = axTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
          !candidate.isEmpty,
          !axTitle.isEmpty
    else {
        return 0
    }
    if candidate == axTitle {
        return -100
    }
    let candidateLower = candidate.lowercased()
    let axLower = axTitle.lowercased()
    if candidateLower.contains(axLower) || axLower.contains(candidateLower) {
        return -25
    }
    return 100
}

func scoreWindowCandidate(
    _ candidate: CGWindowCandidate,
    axWindows: [AXWindowInfo],
    preferredScreenPoint: CGPoint?
) -> Double {
    var score = -candidate.area / 1_000_000
    if let preferredScreenPoint {
        score += candidate.frame.contains(preferredScreenPoint)
            ? -10_000
            : 5_000 + pointDistanceToRect(preferredScreenPoint, candidate.frame)
    }
    guard !axWindows.isEmpty else {
        return score
    }

    let axScore = axWindows.map { info -> Double in
        var current = 0.0
        if let frame = info.frame {
            current += rectDistance(candidate.frame, frame)
        }
        current += titlePenalty(candidate: candidate.title, axTitle: info.title)
        if info.isFocused {
            current -= 2_000
        }
        if info.isMain {
            current -= 1_000
        }
        return current
    }.min() ?? 0
    return score + axScore
}

func resolveWindowTarget(
    app: NSRunningApplication,
    root: AXUIElement? = nil,
    preferredScreenPoint: CGPoint? = nil
) -> WindowTarget? {
    let pid = app.processIdentifier
    let candidates = cgWindowCandidates(pid: pid)
    guard !candidates.isEmpty else {
        return nil
    }
    let appRoot = root ?? AXUIElementCreateApplication(pid)
    let axWindows = axWindowInfos(root: appRoot)
    let best = candidates.min { left, right in
        scoreWindowCandidate(left, axWindows: axWindows, preferredScreenPoint: preferredScreenPoint) <
            scoreWindowCandidate(right, axWindows: axWindows, preferredScreenPoint: preferredScreenPoint)
    }
    guard let best else {
        return nil
    }
    return WindowTarget(pid: pid, windowNumber: best.windowNumber, title: best.title, frame: best.frame)
}

func waitForWindowTarget(app: NSRunningApplication, timeout: TimeInterval = 3) -> WindowTarget? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let target = resolveWindowTarget(app: app) {
            return target
        }
        usleep(100_000)
    } while Date() < deadline
    return resolveWindowTarget(app: app)
}

func backgroundTargetUnavailableMessage(appName: String) -> String {
    return "Unable to resolve a background window target for \(appName)"
}

func windowTargetUnavailableFailure(appName: String) -> HelperFailure {
    return HelperFailure(
        code: "window_unavailable",
        message: backgroundTargetUnavailableMessage(appName: appName)
    )
}

func roundScreenCoordinate(_ value: CGFloat) -> Double {
    return (Double(value) * 100).rounded() / 100
}

func screenPointFromScreenshotPoint(
    x: Double,
    y: Double,
    screenshotWidth: Double,
    screenshotHeight: Double,
    sourceBounds: CGRect
) throws -> CGPoint {
    guard screenshotWidth > 0, screenshotHeight > 0 else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Snapshot dimensions are invalid"
        )
    }
    return CGPoint(
        x: roundScreenCoordinate(
            sourceBounds.minX + (x / screenshotWidth) * sourceBounds.width
        ),
        y: roundScreenCoordinate(
            sourceBounds.minY + (y / screenshotHeight) * sourceBounds.height
        )
    )
}

func snapshotWindowTarget(
    appName: String,
    snapshotId: String,
    preferredScreenPoint: CGPoint,
    windowId: Int?,
    windowFrame: CGRect?
) throws -> WindowTarget {
    let app = try resolveRunningApp(named: appName)
    if let windowId {
        guard let candidate = cgWindowCandidates(pid: app.processIdentifier).first(where: { candidate in
            candidate.windowNumber == windowId
        }) else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Snapshot target window is no longer available: \(snapshotId)"
            )
        }
        if let windowFrame, rectDistance(candidate.frame, windowFrame) > 4 {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Snapshot target window moved or resized: \(snapshotId)"
            )
        }
        return WindowTarget(
            pid: app.processIdentifier,
            windowNumber: candidate.windowNumber,
            title: candidate.title,
            frame: candidate.frame
        )
    }

    guard let target = resolveWindowTarget(app: app, preferredScreenPoint: preferredScreenPoint) else {
        throw windowTargetUnavailableFailure(appName: appName)
    }
    return target
}

func performWithRequiredBackgroundTarget<T>(
    appName: String,
    preferredScreenPoint: CGPoint? = nil,
    _ action: (WindowTarget) throws -> T
) throws -> T {
    let app = try resolveRunningApp(named: appName)
    guard let target = resolveWindowTarget(app: app, preferredScreenPoint: preferredScreenPoint) else {
        throw windowTargetUnavailableFailure(appName: appName)
    }

    return try action(target)
}

func waitForRunningApp(named appName: String, timeout: TimeInterval = 5) -> NSRunningApplication? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let app = findRunningApp(named: appName) {
            return app
        }
        usleep(100_000)
    } while Date() < deadline
    return findRunningApp(named: appName)
}

func applicationSearchRoots() -> [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return [
        URL(fileURLWithPath: "/Applications", isDirectory: true),
        URL(fileURLWithPath: "/System/Applications", isDirectory: true),
        URL(fileURLWithPath: "/System/Library/CoreServices/Applications", isDirectory: true),
        home.appendingPathComponent("Applications", isDirectory: true),
    ]
}

func discoveredApplicationURLs() -> [URL] {
    var urls: [URL] = []
    var seen = Set<String>()
    for root in applicationSearchRoots() where FileManager.default.fileExists(atPath: root.path) {
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .isPackageKey],
            options: [.skipsHiddenFiles]
        ) else {
            continue
        }

        for case let url as URL in enumerator {
            guard url.pathExtension.localizedCaseInsensitiveCompare("app") == .orderedSame else {
                continue
            }
            let path = url.standardizedFileURL.path
            if seen.insert(path).inserted {
                urls.append(url)
            }
            enumerator.skipDescendants()
        }
    }
    return urls
}

func applicationNames(for url: URL) -> [String] {
    let bundle = Bundle(url: url)
    let values = [
        bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
        bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String,
        url.deletingPathExtension().lastPathComponent,
    ]
    var names: [String] = []
    for value in values {
        guard let name = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty,
              !names.contains(name)
        else {
            continue
        }
        names.append(name)
    }
    return names
}

func applicationURL(named appName: String) -> URL? {
    let trimmed = appName.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        return nil
    }
    if trimmed.hasPrefix("/") || trimmed.hasPrefix("~") {
        let expanded = (trimmed as NSString).expandingTildeInPath
        if FileManager.default.fileExists(atPath: expanded) {
            return URL(fileURLWithPath: expanded)
        }
    }
    if trimmed.contains("."),
       let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: trimmed)
    {
        return url
    }

    let candidates = discoveredApplicationURLs()
    if let exactBundleID = candidates.first(where: { url in
        Bundle(url: url)?.bundleIdentifier?.localizedCaseInsensitiveCompare(trimmed) == .orderedSame
    }) {
        return exactBundleID
    }
    if let exactName = candidates.first(where: { url in
        applicationNames(for: url).contains { name in
            name.localizedCaseInsensitiveCompare(trimmed) == .orderedSame
        }
    }) {
        return exactName
    }
    return candidates.first { url in
        applicationNames(for: url).contains { name in
            name.localizedCaseInsensitiveContains(trimmed)
        }
    }
}

func applicationURL(for app: NSRunningApplication, fallbackName: String) -> URL? {
    if let bundleURL = app.bundleURL {
        return bundleURL
    }
    if let bundleIdentifier = app.bundleIdentifier,
       let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
    {
        return url
    }
    return applicationURL(named: fallbackName)
}

func openWithCommandInBackground(named appName: String) throws {
    let process = Process()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-g", "-a", appName]
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    do {
        try process.run()
    } catch {
        throw HelperFailure(
            code: "app_open_failed",
            message: "Unable to request opening \(appName): \(error)"
        )
    }
    process.waitUntilExit()
    _ = trimmedPipeOutput(stdoutPipe)
    if process.terminationStatus != 0 {
        let stderr = trimmedPipeOutput(stderrPipe)
        let detail = stderr.isEmpty ? "" : ": \(stderr)"
        throw HelperFailure(
            code: appOpenFailureCode(stderr),
            message: "Unable to open \(appName)\(detail)"
        )
    }
}

func openApplication(at url: URL, named appName: String, activates: Bool) throws -> NSRunningApplication? {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = activates
    let semaphore = DispatchSemaphore(value: 0)
    let launchResult = LaunchResultBox()
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        launchResult.app = app
        launchResult.error = error
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 5)
    if let launchError = launchResult.error {
        throw HelperFailure(
            code: "app_open_failed",
            message: "Unable to open \(appName): \(launchError.localizedDescription)"
        )
    }
    return launchResult.app
}

func openApplicationWithoutActivation(named appName: String) throws -> NSRunningApplication? {
    guard let url = applicationURL(named: appName) else {
        try openWithCommandInBackground(named: appName)
        return nil
    }

    return try openApplication(at: url, named: appName, activates: false)
}

@discardableResult
func restorePreviousFrontmostIfNeeded(previousApp: NSRunningApplication?, targetPID: pid_t) -> Bool {
    guard let previousApp, previousApp.processIdentifier != targetPID else {
        return false
    }
    var restored = false
    var cleanChecks = 0
    var attempts = 0
    while cleanChecks < 2, attempts < 5 {
        attempts += 1
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID {
            _ = previousApp.activate(options: [.activateIgnoringOtherApps])
            restored = true
            cleanChecks = 0
        } else {
            cleanChecks += 1
        }
        if cleanChecks < 2, attempts < 5 {
            usleep(50_000)
        }
    }
    return restored
}

func runningAppRecord(_ app: NSRunningApplication?) -> [String: Any]? {
    guard let app else {
        return nil
    }
    var record: [String: Any] = [
        "pid": app.processIdentifier,
    ]
    if let localizedName = app.localizedName, !localizedName.isEmpty {
        record["localizedName"] = localizedName
    }
    if let bundleIdentifier = app.bundleIdentifier, !bundleIdentifier.isEmpty {
        record["bundleIdentifier"] = bundleIdentifier
    }
    return record
}

@discardableResult
func restorePreviousFrontmostIfChanged(previousApp: NSRunningApplication?) -> Bool {
    guard let previousApp,
          NSWorkspace.shared.frontmostApplication?.processIdentifier != previousApp.processIdentifier
    else {
        return false
    }
    _ = previousApp.activate(options: [.activateIgnoringOtherApps])
    return true
}

func nativeActionResult(
    dispatchMode: String,
    dispatchTarget: String,
    inputRisk: String,
    extra: [String: Any] = [:]
) -> [String: Any] {
    var result = extra
    result["dispatchMode"] = dispatchMode
    result["dispatchTarget"] = dispatchTarget
    result["inputRisk"] = inputRisk
    return result
}

func withFrontmostPreservation(
    dispatchMode: String,
    dispatchTarget: String,
    inputRisk: String,
    _ action: () throws -> (targetPID: pid_t?, result: [String: Any])
) throws -> [String: Any] {
    let before = NSWorkspace.shared.frontmostApplication
    let actionResult: (targetPID: pid_t?, result: [String: Any])
    do {
        actionResult = try action()
    } catch {
        restorePreviousFrontmostIfChanged(previousApp: before)
        throw error
    }
    let afterAction = NSWorkspace.shared.frontmostApplication
    let restored = actionResult.targetPID.map { targetPID in
        restorePreviousFrontmostIfNeeded(previousApp: before, targetPID: targetPID)
    } ?? false
    let after = NSWorkspace.shared.frontmostApplication

    var result = nativeActionResult(
        dispatchMode: dispatchMode,
        dispatchTarget: dispatchTarget,
        inputRisk: inputRisk,
        extra: actionResult.result
    )
    if let frontmostBefore = runningAppRecord(before) {
        result["frontmostBefore"] = frontmostBefore
    }
    if let frontmostAfterAction = runningAppRecord(afterAction) {
        result["frontmostAfterAction"] = frontmostAfterAction
    }
    if let frontmostAfter = runningAppRecord(after) {
        result["frontmostAfter"] = frontmostAfter
    }
    result["frontmostRestored"] = restored
    return result
}

func titleElementText(_ element: AXUIElement) -> String? {
    guard let titleElement = axElementValue(attribute(element, kAXTitleUIElementAttribute as CFString)) else {
        return nil
    }
    return stringValue(attribute(titleElement, kAXTitleAttribute as CFString)) ??
        stringValue(attribute(titleElement, kAXValueAttribute as CFString)) ??
        stringValue(attribute(titleElement, kAXDescriptionAttribute as CFString))
}

func setAttribute(_ element: AXUIElement, _ name: CFString, _ value: CFTypeRef) throws {
    let error = AXUIElementSetAttributeValue(element, name, value)
    if error != .success {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Unable to set accessibility attribute \(name): \(error.rawValue)"
        )
    }
}

func bestEffortSetAttribute(_ element: AXUIElement, _ name: String, _ value: Bool) {
    _ = AXUIElementSetAttributeValue(element, name as CFString, NSNumber(value: value))
}

func enableBestEffortAccessibilityModes(_ element: AXUIElement) {
    bestEffortSetAttribute(element, "AXManualAccessibility", true)
    bestEffortSetAttribute(element, "AXEnhancedUserInterface", true)
}

func childFingerprint(_ element: AXUIElement) -> String {
    guard let bounds = bounds(element) else {
        return ""
    }
    let x = bounds["x"] ?? 0
    let y = bounds["y"] ?? 0
    let width = bounds["width"] ?? 0
    let height = bounds["height"] ?? 0
    let boundsText = "\(x),\(y),\(width),\(height)"
    return [
        role(element) ?? "",
        stringValue(attribute(element, kAXTitleAttribute as CFString)) ?? "",
        stringValue(attribute(element, kAXValueAttribute as CFString)) ?? "",
        boundsText,
    ].joined(separator: "|")
}

func prefixedChildren(
    _ element: AXUIElement,
    _ attributeName: CFString,
    _ prefix: String
) -> [ChildEntry] {
    return attributeArray(element, attributeName)
        .prefix(limits.maxChildrenPerSource)
        .enumerated()
        .map { index, child in
            ChildEntry(element: child, segment: "\(prefix)\(index)")
        }
}

func elementUsesVisibleCollectionSources(_ element: AXUIElement) -> Bool {
    guard let role = role(element),
          role == "AXList" || role == "AXOutline" || role == "AXTable"
    else {
        return false
    }
    return !attributeArray(element, "AXVisibleRows" as CFString).isEmpty ||
        !attributeArray(element, "AXVisibleCells" as CFString).isEmpty ||
        !attributeArray(element, "AXVisibleColumns" as CFString).isEmpty ||
        !attributeArray(element, "AXSelectedChildren" as CFString).isEmpty ||
        !attributeArray(element, "AXSelectedRows" as CFString).isEmpty ||
        !attributeArray(element, "AXSelectedCells" as CFString).isEmpty
}

func collectChildren(_ element: AXUIElement) -> [ChildEntry] {
    let sources = elementUsesVisibleCollectionSources(element)
        ? visibleCollectionChildSources
        : childSources
    let candidates = sources.flatMap { source in
        prefixedChildren(element, source.attribute as CFString, source.prefix)
    }

    var seenElements = Set<CFHashCode>()
    var seen = Set<String>()
    var children: [ChildEntry] = []
    for candidate in candidates {
        let elementHash = CFHash(candidate.element)
        if seenElements.contains(elementHash) {
            continue
        }
        seenElements.insert(elementHash)

        let fingerprint = childFingerprint(candidate.element)
        if !fingerprint.isEmpty {
            if seen.contains(fingerprint) {
                continue
            }
            seen.insert(fingerprint)
        }
        children.append(candidate)
    }
    return children
}

func markTruncated(_ reasons: inout [String], _ reason: String) {
    if !reasons.contains(reason) {
        reasons.append(reason)
    }
}

func describe(
    _ element: AXUIElement,
    id: String,
    depth: Int,
    nodeCount: inout Int,
    truncationReasons: inout [String]
) -> [String: Any]? {
    if nodeCount >= limits.maxNodes {
        markTruncated(&truncationReasons, "max_nodes")
        return nil
    }
    if depth > limits.maxDepth {
        markTruncated(&truncationReasons, "max_depth")
        return nil
    }
    nodeCount += 1

    var node: [String: Any] = ["id": id]
    if let role = role(element) {
        node["role"] = role
    }
    if let roleDescription = stringValue(attribute(element, kAXRoleDescriptionAttribute as CFString)) {
        node["roleDescription"] = roleDescription
    }
    if let subrole = stringValue(attribute(element, kAXSubroleAttribute as CFString)) {
        node["subrole"] = subrole
    }
    if let name = stringValue(attribute(element, kAXTitleAttribute as CFString)) {
        node["name"] = name
    }
    let rawValue = attribute(element, kAXValueAttribute as CFString)
    if let value = stringValue(rawValue) {
        node["value"] = value
    }
    if let valueType = valueTypeDescription(rawValue) {
        node["valueType"] = valueType
    }
    if let valueSettable = attributeIsSettable(element, kAXValueAttribute as CFString), valueSettable {
        node["valueSettable"] = valueSettable
    }
    if let description = stringValue(attribute(element, kAXDescriptionAttribute as CFString)) {
        node["description"] = description
    }
    if let help = stringValue(attribute(element, kAXHelpAttribute as CFString)) {
        node["help"] = help
    }
    if let placeholderValue = stringValue(attribute(element, kAXPlaceholderValueAttribute as CFString)) {
        node["placeholderValue"] = placeholderValue
    }
    if let visibleText = stringValue(attribute(element, kAXVisibleTextAttribute as CFString)) {
        node["visibleText"] = visibleText
    }
    if let text = stringValue(attribute(element, kAXTextAttribute as CFString)) {
        node["text"] = text
    }
    if let titleElementText = titleElementText(element) {
        node["titleElementText"] = titleElementText
    }
    let columnTitles = stringArrayValue(attribute(element, kAXColumnTitlesAttribute as CFString))
    if !columnTitles.isEmpty {
        node["columnTitles"] = columnTitles
    }
    if let identifier = stringValue(attribute(element, kAXIdentifierAttribute as CFString)) {
        node["identifier"] = identifier
    }
    if let url = urlStringValue(attribute(element, kAXURLAttribute as CFString)) {
        node["url"] = url
    }
    if let focused = boolValue(attribute(element, kAXFocusedAttribute as CFString)) {
        node["focused"] = focused
    }
    if let enabled = boolValue(attribute(element, kAXEnabledAttribute as CFString)) {
        node["enabled"] = enabled
    }
    let selected = boolValue(attribute(element, kAXSelectedAttribute as CFString))
    if let selected {
        node["selected"] = selected
    }
    if let expanded = boolValue(attribute(element, kAXExpandedAttribute as CFString)) {
        node["expanded"] = expanded
    }
    if let hidden = boolValue(attribute(element, "AXHidden" as CFString)) {
        node["hidden"] = hidden
    }
    let actions = actionNames(element)
    if !actions.isEmpty {
        node["actions"] = actions
    }
    if let bounds = bounds(element) {
        node["bounds"] = bounds
    }
    setClickCapabilityFields(&node, capabilities: clickCapabilities(element, actions: actions, selected: selected))

    if depth >= limits.maxDepth {
        markTruncated(&truncationReasons, "max_depth")
        return node
    }

    let children = collectChildren(element).compactMap { child in
        describe(
            child.element,
            id: "\(id).\(child.segment)",
            depth: depth + 1,
            nodeCount: &nodeCount,
            truncationReasons: &truncationReasons
        )
    }
    if !children.isEmpty {
        node["children"] = children
    }
    return node
}

func resolveIndex(_ segment: Substring) throws -> Int {
    let indexText = segment.drop(while: { character in
        !character.isNumber
    })
    guard !indexText.isEmpty,
          let index = Int(indexText),
          index >= 0
    else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Invalid element id segment: \(segment)"
        )
    }
    return index
}

func childForSegment(_ element: AXUIElement, _ segment: Substring) throws -> AXUIElement {
    let index = try resolveIndex(segment)
    guard let source = childSources.first(where: { source in
        segment.hasPrefix(source.prefix)
    }) else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Invalid element id segment: \(segment)"
        )
    }
    let children = attributeArray(element, source.attribute as CFString)

    guard index < children.count else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Element not found: \(segment)"
        )
    }
    return children[index]
}

func resolveElement(appName: String, elementId: String) throws -> AXUIElement {
    let root = try appElement(named: appName)
    let parts = elementId.split(separator: ".")
    var current: AXUIElement?

    for part in parts {
        if part.hasPrefix("w") {
            let index = try resolveIndex(part)
            let windows = attributeArray(root, kAXWindowsAttribute as CFString)
            guard index < windows.count else {
                throw HelperFailure(
                    code: "accessibility_unavailable",
                    message: "Element not found: \(elementId)"
                )
            }
            current = windows[index]
        } else if part.hasPrefix("m") {
            let index = try resolveIndex(part)
            guard index == 0,
                  let menuBar = axElementValue(attribute(root, kAXMenuBarAttribute as CFString))
            else {
                throw HelperFailure(
                    code: "accessibility_unavailable",
                    message: "Element not found: \(elementId)"
                )
            }
            current = menuBar
        } else {
            guard let element = current else {
                throw HelperFailure(
                    code: "unsupported_command",
                    message: "Invalid element id: \(elementId)"
                )
            }
            current = try childForSegment(element, part)
        }
    }

    guard let resolved = current else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Element not found: \(elementId)"
        )
    }
    return resolved
}

func indexedSnapshotElements(_ elements: [[String: Any]]) -> (
    elements: [[String: Any]],
    elementIdsByIndex: [String],
    focusedElementIndex: Int?
) {
    var nextIndex = 0
    var elementIdsByIndex: [String] = []
    var focusedElementIndex: Int?

    func indexElement(_ element: [String: Any]) -> [String: Any] {
        let index = nextIndex
        nextIndex += 1
        elementIdsByIndex.append((element["id"] as? String) ?? "")
        if focusedElementIndex == nil,
           let focused = element["focused"] as? Bool,
           focused
        {
            focusedElementIndex = index
        }

        var indexed = element
        indexed["index"] = index
        if let children = element["children"] as? [[String: Any]], !children.isEmpty {
            indexed["children"] = children.map { child in
                indexElement(child)
            }
        }
        return indexed
    }

    return (
        elements.map { element in
            indexElement(element)
        },
        elementIdsByIndex,
        focusedElementIndex
    )
}

func resolveElementId(
    _ request: [String: Any],
    session: ComputerUseRuntimeSession?,
    commandName: String
) throws -> String {
    if let elementId = optionalString(request, "elementId") {
        return elementId
    }
    guard let elementIndex = optionalInt(request, "elementIndex") else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "\(commandName) requires elementId or elementIndex"
        )
    }
    guard let session else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "\(commandName) with elementIndex requires a runtime session snapshot"
        )
    }
    let appName = try requiredString(request, "app")
    return try session.elementId(
        appName: appName,
        snapshotId: optionalString(request, "snapshotId"),
        elementIndex: elementIndex,
        commandName: commandName
    )
}

func handleAppsList() -> [String: Any] {
    func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else {
            return nil
        }
        return trimmed
    }

    func appRecordKey(
        name: String,
        bundleId: String?,
        appPath: String?,
        pid: pid_t?
    ) -> String {
        if let bundleId = nonEmpty(bundleId) {
            return "bundle:\(bundleId.lowercased())"
        }
        if let appPath = nonEmpty(appPath) {
            return "path:\(appPath.lowercased())"
        }
        if let pid {
            return "pid:\(pid)"
        }
        return "name:\(name.lowercased())"
    }

    func mergeAppRecord(
        _ record: [String: Any],
        into recordsByKey: inout [String: [String: Any]],
        key: String
    ) {
        guard var existing = recordsByKey[key] else {
            recordsByKey[key] = record
            return
        }

        if existing["bundleId"] == nil, let bundleId = record["bundleId"] {
            existing["bundleId"] = bundleId
        }
        if existing["appPath"] == nil, let appPath = record["appPath"] {
            existing["appPath"] = appPath
        }
        if record["running"] as? Bool == true {
            existing["running"] = true
            if let pid = record["pid"] {
                existing["pid"] = pid
            }
            if let name = record["name"] {
                existing["name"] = name
            }
        }
        recordsByKey[key] = existing
    }

    var recordsByKey: [String: [String: Any]] = [:]

    for url in discoveredApplicationURLs() {
        guard let name = applicationNames(for: url).first else {
            continue
        }
        let bundleId = nonEmpty(Bundle(url: url)?.bundleIdentifier)
        let appPath = nonEmpty(url.standardizedFileURL.path)
        var record: [String: Any] = [
            "name": name,
            "running": false,
        ]
        if let bundleId {
            record["bundleId"] = bundleId
        }
        if let appPath {
            record["appPath"] = appPath
        }
        mergeAppRecord(
            record,
            into: &recordsByKey,
            key: appRecordKey(name: name, bundleId: bundleId, appPath: appPath, pid: nil)
        )
    }

    for app in NSWorkspace.shared.runningApplications {
        if app.activationPolicy == .regular,
           let name = nonEmpty(app.localizedName)
        {
            let bundleId = nonEmpty(app.bundleIdentifier)
            let appPath = nonEmpty(app.bundleURL?.standardizedFileURL.path)
            var record: [String: Any] = [
                "name": name,
                "running": true,
                "pid": Int(app.processIdentifier),
            ]
            if let bundleId {
                record["bundleId"] = bundleId
            }
            if let appPath {
                record["appPath"] = appPath
            }
            mergeAppRecord(
                record,
                into: &recordsByKey,
                key: appRecordKey(
                    name: name,
                    bundleId: bundleId,
                    appPath: appPath,
                    pid: app.processIdentifier
                )
            )
        }
    }

    let records = recordsByKey.values.sorted { lhs, rhs in
        let leftName = (lhs["name"] as? String ?? "").localizedCaseInsensitiveCompare(
            rhs["name"] as? String ?? ""
        )
        if leftName != .orderedSame {
            return leftName == .orderedAscending
        }
        return (lhs["bundleId"] as? String ?? "").localizedCaseInsensitiveCompare(
            rhs["bundleId"] as? String ?? ""
        ) == .orderedAscending
    }
    return ["apps": records]
}

func computerUsePermissionState() -> [String: Any] {
    return [
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
    ]
}

func handlePermissionsState() -> [String: Any] {
    return computerUsePermissionState()
}

func handlePermissionsRequestAccessibility() -> [String: Any] {
    let options = [
        "AXTrustedCheckOptionPrompt": true,
    ] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    return computerUsePermissionState()
}

func handlePermissionsRequestScreenRecording() -> [String: Any] {
    _ = CGRequestScreenCaptureAccess()
    return computerUsePermissionState()
}

func handleAppState(_ request: [String: Any], session: ComputerUseRuntimeSession?) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let snapshotId = optionalString(request, "snapshotId") ?? UUID().uuidString.lowercased()

    guard let runningApp = findRunningApp(named: appName) else {
        throw HelperFailure(
            code: "app_not_found",
            message: "App is not running: \(appName)"
        )
    }

    let root = AXUIElementCreateApplication(runningApp.processIdentifier)
    enableBestEffortAccessibilityModes(root)

    var nodeCount = 0
    var truncationReasons: [String] = []
    let windows = attributeArray(root, kAXWindowsAttribute as CFString)
        .prefix(limits.maxWindows)
        .enumerated()
        .compactMap { index, window in
            describe(
                window,
                id: "w\(index)",
                depth: 0,
                nodeCount: &nodeCount,
                truncationReasons: &truncationReasons
            )
        }

    var elements = Array(windows)
    if let menuBar = axElementValue(attribute(root, kAXMenuBarAttribute as CFString)),
       let menuBarSnapshot = describe(
           menuBar,
           id: "m0",
           depth: 0,
           nodeCount: &nodeCount,
           truncationReasons: &truncationReasons
       )
    {
        elements.append(menuBarSnapshot)
    }
    let indexed = indexedSnapshotElements(elements)
    elements = indexed.elements

    var response: [String: Any] = [
        "app": appName,
        "appDisplayName": runningApp.localizedName ?? appName,
        "pid": Int(runningApp.processIdentifier),
        "snapshotId": snapshotId,
        "elements": elements,
        "elementIdsByIndex": indexed.elementIdsByIndex,
        "nodeCount": nodeCount,
        "truncated": !truncationReasons.isEmpty,
        "truncationReasons": truncationReasons,
    ]
    if let focusedElementIndex = indexed.focusedElementIndex {
        response["focusedElementIndex"] = focusedElementIndex
    }
    if let bundleId = runningApp.bundleIdentifier {
        response["bundleId"] = bundleId
    }
    if let appPath = runningApp.bundleURL?.path {
        response["appPath"] = appPath
    }
    if let windowTitle = elements.first?["name"] as? String {
        response["windowTitle"] = windowTitle
    }
    guard let target = resolveWindowTarget(app: runningApp, root: root) else {
        throw windowTargetUnavailableFailure(appName: appName)
    }
    let screenshot = try BackgroundWindowScreenshot.capture(windowNumber: target.windowNumber)
    let sourceName = target.title ??
        (elements.first?["name"] as? String) ??
        runningApp.localizedName ??
        appName
    let sourceBounds = boundsRecord(target.frame)
    response["windowId"] = target.windowNumber
    response["windowFrame"] = sourceBounds
    response["screenshot"] = screenshot.dataUrl
    response["screenshotMimeType"] = "image/png"
    response["screenshotSource"] = "window"
    response["screenshotSourceName"] = sourceName
    response["screenshotWidth"] = screenshot.width
    response["screenshotHeight"] = screenshot.height
    response["screenshotSourceBounds"] = sourceBounds
    session?.recordSnapshot(response)
    return response
}

func handleAppOpen(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    return try withFrontmostPreservation(
        dispatchMode: "background_app_open",
        dispatchTarget: "target_app",
        inputRisk: "background_app_launch"
    ) {
        let runningApp = findRunningApp(named: appName)
        if let runningApp, resolveWindowTarget(app: runningApp) != nil {
            return (targetPID: runningApp.processIdentifier, result: ["windowReady": true])
        }

        let appURL = runningApp.flatMap { app in
            applicationURL(for: app, fallbackName: appName)
        } ?? applicationURL(named: appName)

        var targetApp: NSRunningApplication?
        if let appURL {
            targetApp = try openApplication(at: appURL, named: appName, activates: false) ??
                runningApp ??
                waitForRunningApp(named: appName)
        } else {
            try openWithCommandInBackground(named: appName)
            targetApp = runningApp ?? waitForRunningApp(named: appName)
        }

        guard let launchedApp = targetApp else {
            throw HelperFailure(code: "app_open_failed", message: "Unable to find launched app: \(appName)")
        }

        if waitForWindowTarget(app: launchedApp, timeout: 2) == nil {
            if let appURL {
                targetApp = try openApplication(at: appURL, named: appName, activates: true) ?? launchedApp
            } else {
                _ = launchedApp.activate(options: [.activateIgnoringOtherApps])
            }
        }

        guard let appWithWindow = targetApp,
              waitForWindowTarget(app: appWithWindow, timeout: 3) != nil
        else {
            throw windowTargetUnavailableFailure(appName: appName)
        }

        return (targetPID: appWithWindow.processIdentifier, result: ["windowReady": true])
    }
}

func handleElementClick(_ request: [String: Any], session: ComputerUseRuntimeSession?) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let hasElementTarget = optionalString(request, "elementId") != nil || optionalInt(request, "elementIndex") != nil
    if !hasElementTarget, request["x"] != nil || request["y"] != nil {
        return try handleElementClickPoint(request, session: session)
    }
    let elementId = try resolveElementId(request, session: session, commandName: "element.click")
    let clickCount = max(1, min(optionalInt(request, "clickCount", default: 1), 3))
    let button = optionalString(request, "button") ?? "left"
    let app = try resolveRunningApp(named: appName)
    let element = try resolveElement(appName: appName, elementId: elementId)
    guard let clickTarget = resolveElementClickTarget(element) else {
        throw HelperFailure(
            code: "element_action_unsupported",
            message: "Element is visible but does not support a primary click action: \(elementId)"
        )
    }
    if clickTarget.strategy != .mouse && button != "left" {
        throw HelperFailure(
            code: "unsupported_command",
            message: "element.click with element target only supports the left button"
        )
    }

    if clickTarget.strategy == .mouse {
        let config = try mouseEventConfig(button: button)
        let mode = clickTarget.capabilities.webAreaMouseClick
            ? "web_area_mouse_fallback"
            : "capability_mouse_fallback"
        return try performElementMouseClick(
            app: app,
            appName: appName,
            clickTarget: clickTarget,
            config: config,
            clickCount: clickCount,
            mode: mode
        )
    }

    do {
        return try performElementAccessibilityClick(
            app: app,
            elementId: elementId,
            clickTarget: clickTarget,
            clickCount: clickCount
        )
    } catch let unsupported as UnsupportedClickAction {
        guard clickTarget.capabilities.frame != nil else {
            throw HelperFailure(
                code: "element_action_unsupported",
                message: "Primary click action \(unsupported.actionName) is unsupported for \(elementId): \(unsupported.error.rawValue)"
            )
        }
        let config = try mouseEventConfig(button: button)
        return try performElementMouseClick(
            app: app,
            appName: appName,
            clickTarget: clickTarget,
            config: config,
            clickCount: clickCount,
            mode: "unsupported_action_mouse_fallback",
            extra: [
                "unsupportedAction": unsupported.actionName,
                "unsupportedActionError": unsupported.error.rawValue,
            ]
        )
    }
}

func mouseEventConfig(button: String) throws -> (
    down: CGEventType,
    up: CGEventType,
    button: CGMouseButton
) {
    if button == "left" {
        return (.leftMouseDown, .leftMouseUp, .left)
    }
    if button == "right" {
        return (.rightMouseDown, .rightMouseUp, .right)
    }
    if button == "middle" {
        return (.otherMouseDown, .otherMouseUp, .center)
    }
    throw HelperFailure(
        code: "unsupported_command",
        message: "Unsupported mouse button: \(button)"
    )
}

func performBackgroundMouseClick(
    target: WindowTarget,
    point: CGPoint,
    config: (down: CGEventType, up: CGEventType, button: CGMouseButton),
    clickCount: Int
) throws -> [String: Any] {
    ComputerUseVisualPointer.shared.show(at: point)
    let activation = BackgroundActivationSession.start(target: target)
    defer { activation.finish() }

    activation.beginTargetDelivery()
    activation.activateWindow()

    let dispatcher = AddressedEventDispatcher(target: target)
    for index in 1...clickCount {
        try dispatcher.postMouse(
            config.down,
            at: point,
            button: config.button,
            clickState: Int64(index),
            pressure: 1
        )
        usleep(30_000)
        try dispatcher.postMouse(
            config.up,
            at: point,
            button: config.button,
            clickState: Int64(index),
            pressure: 0
        )
        if index < clickCount {
            usleep(50_000)
        }
    }

    activation.holdFocusSuppressionUntilFinish()
    usleep(200_000)

    return [
        "screenX": point.x,
        "screenY": point.y,
        "targetWindowId": target.windowNumber,
        "backgroundActivation": true,
        "focusSuppression": activation.hasFocusSuppressionTaps,
    ]
}

func hasRoleInElementAncestry(_ element: AXUIElement, roleName: String) -> Bool {
    var current: AXUIElement? = element
    var depth = 0
    while let node = current, depth <= limits.maxDepth {
        if role(node) == roleName {
            return true
        }
        current = axElementValue(attribute(node, kAXParentAttribute as CFString))
        depth += 1
    }
    return false
}

func shouldUseMouseClickForElement(_ element: AXUIElement) -> Bool {
    let elementRole = role(element)
    if elementRole == "AXMenuBarItem" || elementRole == "AXMenuItem" {
        return false
    }
    return hasRoleInElementAncestry(element, roleName: "AXWebArea")
}

struct UnsupportedClickAction: Error {
    let actionName: String
    let error: AXError
}

func isUnsupportedActionError(_ error: AXError) -> Bool {
    return error == .actionUnsupported || error == .attributeUnsupported
}

func resolveElementClickTarget(_ element: AXUIElement) -> ElementClickTarget? {
    var current: AXUIElement? = element
    var depth = 0
    while let node = current, depth <= limits.maxDepth {
        let capabilities = clickCapabilities(node)
        if !(depth > 0 && capabilities.role == "AXWebArea"),
           let strategy = preferredClickStrategy(capabilities)
        {
            return ElementClickTarget(
                element: node,
                capabilities: capabilities,
                promotedDepth: depth,
                strategy: strategy
            )
        }
        current = axElementValue(attribute(node, kAXParentAttribute as CFString))
        depth += 1
    }
    return nil
}

func elementClickResultMetadata(clickTarget: ElementClickTarget) -> [String: Any] {
    var result: [String: Any] = [
        "clickStrategy": clickTarget.strategy.rawValue,
    ]
    if clickTarget.promotedDepth > 0 {
        result["clickTargetPromoted"] = true
        result["clickTargetPromotedDepth"] = clickTarget.promotedDepth
    }
    if let role = clickTarget.capabilities.role {
        result["clickTargetRole"] = role
    }
    if let subrole = clickTarget.capabilities.subrole {
        result["clickTargetSubrole"] = subrole
    }
    if let clickableKind = clickTarget.capabilities.clickableKind {
        result["clickableKind"] = clickableKind
    }
    return result
}

func performElementMouseClick(
    app: NSRunningApplication,
    appName: String,
    clickTarget: ElementClickTarget,
    config: (down: CGEventType, up: CGEventType, button: CGMouseButton),
    clickCount: Int,
    mode: String,
    extra: [String: Any] = [:]
) throws -> [String: Any] {
    guard let frame = clickTarget.capabilities.frame else {
        throw HelperFailure(
            code: "element_action_unsupported",
            message: "Element does not have a usable frame for a mouse click"
        )
    }
    let point = CGPoint(x: frame.midX, y: frame.midY)
    return try withFrontmostPreservation(
        dispatchMode: "background_mouse_event",
        dispatchTarget: "element_point",
        inputRisk: "background_app_pointer"
    ) {
        guard let target = resolveWindowTarget(app: app, preferredScreenPoint: point) else {
            throw windowTargetUnavailableFailure(appName: appName)
        }
        var result = try performBackgroundMouseClick(
            target: target,
            point: point,
            config: config,
            clickCount: clickCount
        )
        result["elementClickMode"] = mode
        for (key, value) in elementClickResultMetadata(clickTarget: clickTarget) {
            result[key] = value
        }
        for (key, value) in extra {
            result[key] = value
        }
        return (targetPID: target.pid, result: result)
    }
}

func performElementAccessibilityClick(
    app: NSRunningApplication,
    elementId: String,
    clickTarget: ElementClickTarget,
    clickCount: Int
) throws -> [String: Any] {
    let actionName = clickTarget.strategy == .pick ? axPickActionName : axPressActionName
    return try withFrontmostPreservation(
        dispatchMode: "accessibility_action",
        dispatchTarget: "element",
        inputRisk: "targeted_app_action"
    ) {
        if let frame = clickTarget.capabilities.frame {
            ComputerUseVisualPointer.shared.show(at: CGPoint(x: frame.midX, y: frame.midY))
        }
        for index in 0..<clickCount {
            let error = AXUIElementPerformAction(clickTarget.element, actionName as CFString)
            if error != .success {
                if index == 0, isUnsupportedActionError(error) {
                    throw UnsupportedClickAction(actionName: actionName, error: error)
                }
                throw HelperFailure(
                    code: "accessibility_unavailable",
                    message: "Unable to perform \(actionName) on \(elementId): \(error.rawValue)"
                )
            }
            if index + 1 < clickCount {
                usleep(50_000)
            }
        }
        var result = elementClickResultMetadata(clickTarget: clickTarget)
        result["clickAction"] = actionName
        return (targetPID: app.processIdentifier, result: result)
    }
}

func normalizeKeyToken(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count == 1 {
        return trimmed.lowercased()
    }
    return trimmed
        .lowercased()
        .filter { character in
            !character.isWhitespace && character != "_" && character != "-"
        }
}

func canonicalKeyToken(_ token: String) -> String {
    return keyAliases[token] ?? token
}

func displayKeyToken(_ token: String) -> String {
    if let displayName = keyDisplayNames[token] {
        return displayName
    }
    if token.first == "f",
       token.count <= 3,
       Int(token.dropFirst()) != nil
    {
        return token.uppercased()
    }
    if token.count == 1 {
        return token.uppercased()
    }
    return token
}

func parseKeyPress(_ key: String) throws -> ParsedKeyPress {
    let rawParts = key.split(separator: "+", omittingEmptySubsequences: false).map { part in
        String(part).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if rawParts.isEmpty || rawParts.contains(where: { part in part.isEmpty }) {
        throw HelperFailure(
            code: "unsupported_command",
            message: "keyboard.press_key requires a non-empty key or key combination"
        )
    }

    var modifierNames = Set<String>()
    var keyCode: Int?
    var displayKey: String?

    for rawPart in rawParts {
        let token = normalizeKeyToken(rawPart)
        if let modifierName = keyModifierAliases[token] {
            modifierNames.insert(modifierName)
            continue
        }
        let keyToken = canonicalKeyToken(token)
        guard let code = keyCodes[keyToken] else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Unsupported key specification: \(rawPart). \(keySyntaxHint)"
            )
        }
        if keyCode != nil {
            throw HelperFailure(
                code: "unsupported_command",
                message: "keyboard.press_key supports exactly one non-modifier key"
            )
        }
        keyCode = code
        displayKey = displayKeyToken(keyToken)
    }

    guard let keyCode, let displayKey else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "keyboard.press_key requires a non-modifier key"
        )
    }

    let activeModifiers = keyModifierDefinitions.filter { definition in
        modifierNames.contains(definition.name)
    }
    let flags = activeModifiers.reduce(0) { partial, definition in
        partial | definition.flag
    }
    let normalizedKey = (
        activeModifiers.map { definition in definition.displayName } + [displayKey]
    ).joined(separator: "+")

    return ParsedKeyPress(
        keyCode: keyCode,
        modifiers: activeModifiers,
        flags: flags,
        normalizedKey: normalizedKey
    )
}

func handleElementClickPoint(
    _ request: [String: Any],
    session: ComputerUseRuntimeSession?
) throws -> [String: Any] {
    let preparedRequest = try session?.requestWithPointMetadata(request) ?? request
    let appName = try requiredString(preparedRequest, "app")
    let snapshotId = try requiredString(preparedRequest, "snapshotId")
    let x = try requiredNumber(preparedRequest, "x")
    let y = try requiredNumber(preparedRequest, "y")
    let screenshotSource = try requiredString(preparedRequest, "screenshotSource")
    guard screenshotSource == "window" else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Snapshot is not a target-window screenshot: \(snapshotId)"
        )
    }
    let screenshotWidth = try requiredNumber(preparedRequest, "screenshotWidth")
    let screenshotHeight = try requiredNumber(preparedRequest, "screenshotHeight")
    let sourceBounds = try rectPayload(preparedRequest, "sourceBounds")
    let windowFrame = try optionalRectPayload(preparedRequest, "windowFrame")
    let windowId = optionalInt(preparedRequest, "windowId")
    let button = optionalString(preparedRequest, "button") ?? "left"
    let clickCount = max(1, min(optionalInt(preparedRequest, "clickCount", default: 1), 3))
    let config = try mouseEventConfig(button: button)
    let point = try screenPointFromScreenshotPoint(
        x: x,
        y: y,
        screenshotWidth: screenshotWidth,
        screenshotHeight: screenshotHeight,
        sourceBounds: sourceBounds
    )
    return try withFrontmostPreservation(
        dispatchMode: "background_mouse_event",
        dispatchTarget: "app_process",
        inputRisk: "background_app_pointer"
    ) {
        let target = try snapshotWindowTarget(
            appName: appName,
            snapshotId: snapshotId,
            preferredScreenPoint: point,
            windowId: windowId,
            windowFrame: windowFrame
        )

        let result = try performBackgroundMouseClick(
            target: target,
            point: point,
            config: config,
            clickCount: clickCount
        )
        return (
            targetPID: target.pid,
            result: result
        )
    }
}

func handleElementSetValue(_ request: [String: Any], session: ComputerUseRuntimeSession?) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try resolveElementId(request, session: session, commandName: "element.set_value")
    let value = try requiredString(request, "value")
    let app = try resolveRunningApp(named: appName)
    return try withFrontmostPreservation(
        dispatchMode: "accessibility_value",
        dispatchTarget: "element",
        inputRisk: "targeted_app_text"
    ) {
        let element = try resolveElement(appName: appName, elementId: elementId)
        if let frame = clickableFrame(element) {
            ComputerUseVisualPointer.shared.show(at: CGPoint(x: frame.midX, y: frame.midY))
        }
        try setAttribute(element, kAXValueAttribute as CFString, value as CFString)
        return (targetPID: app.processIdentifier, result: [:])
    }
}

func handleElementPerformAction(_ request: [String: Any], session: ComputerUseRuntimeSession?) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try resolveElementId(request, session: session, commandName: "element.perform_action")
    let action = try requiredString(request, "action")
    let app = try resolveRunningApp(named: appName)
    return try withFrontmostPreservation(
        dispatchMode: "accessibility_action",
        dispatchTarget: "element",
        inputRisk: "targeted_app_action"
    ) {
        let element = try resolveElement(appName: appName, elementId: elementId)
        if let frame = clickableFrame(element) {
            ComputerUseVisualPointer.shared.show(at: CGPoint(x: frame.midX, y: frame.midY))
        }
        let error = AXUIElementPerformAction(element, action as CFString)
        if error != .success {
            throw HelperFailure(
                code: "accessibility_unavailable",
                message: "Unable to perform \(action) on \(elementId): \(error.rawValue)"
            )
        }
        return (targetPID: app.processIdentifier, result: [:])
    }
}

func handleTypeText(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let inputText = try requiredString(request, "text")
    return try withFrontmostPreservation(
        dispatchMode: "background_keyboard_text",
        dispatchTarget: "app_process",
        inputRisk: "background_app_text"
    ) {
        let targetPID = try performWithRequiredBackgroundTarget(appName: appName) { target in
            let dispatcher = AddressedEventDispatcher(target: target)
            try dispatcher.postText(inputText)
            return target.pid
        }
        return (targetPID: targetPID, result: ["characterCount": inputText.count])
    }
}

func handlePressKey(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let key = try requiredString(request, "key")
    let parsed = try parseKeyPress(key)

    return try withFrontmostPreservation(
        dispatchMode: "background_keyboard_event",
        dispatchTarget: "app_process",
        inputRisk: "background_app_shortcut"
    ) {
        let targetPID = try performWithRequiredBackgroundTarget(appName: appName) { target in
            let dispatcher = AddressedEventDispatcher(target: target)
            var activeFlags = 0
            for modifier in parsed.modifiers {
                activeFlags |= modifier.flag
                try dispatcher.postKey(keyCode: modifier.keyCode, keyDown: true, flags: activeFlags)
            }
            try dispatcher.postKey(keyCode: parsed.keyCode, keyDown: true, flags: parsed.flags)
            try dispatcher.postKey(keyCode: parsed.keyCode, keyDown: false, flags: parsed.flags)
            for modifier in parsed.modifiers.reversed() {
                activeFlags &= ~modifier.flag
                try dispatcher.postKey(keyCode: modifier.keyCode, keyDown: false, flags: activeFlags)
            }
            return target.pid
        }
        return (targetPID: targetPID, result: ["normalizedKey": parsed.normalizedKey])
    }
}

func handleScrollElement(_ request: [String: Any], session: ComputerUseRuntimeSession?) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try resolveElementId(request, session: session, commandName: "element.scroll")
    let direction = try requiredString(request, "direction")
    let pages = request["pages"] as? NSNumber
    let step = pages?.doubleValue ?? 1
    let axis = direction == "left" || direction == "right"
        ? "AXHorizontalScrollBar"
        : "AXVerticalScrollBar"
    let sign = direction == "up" || direction == "left" ? -1.0 : 1.0
    let app = try resolveRunningApp(named: appName)
    return try withFrontmostPreservation(
        dispatchMode: "accessibility_action",
        dispatchTarget: "element",
        inputRisk: "targeted_app_action"
    ) {
        let element = try resolveElement(appName: appName, elementId: elementId)
        if let frame = clickableFrame(element) {
            ComputerUseVisualPointer.shared.show(at: CGPoint(x: frame.midX, y: frame.midY))
        }
        guard let scrollBar = attributeArray(element, kAXChildrenAttribute as CFString).first(where: { child in
            role(child) == axis
        }) else {
            return (targetPID: app.processIdentifier, result: [:])
        }
        if let current = numberValue(attribute(scrollBar, kAXValueAttribute as CFString)) {
            try setAttribute(
                scrollBar,
                kAXValueAttribute as CFString,
                NSNumber(value: current + sign * step)
            )
        }
        return (targetPID: app.processIdentifier, result: [:])
    }
}

func commandRequest(from request: [String: Any]) throws -> [String: Any] {
    var command = (request["payload"] as? [String: Any]) ?? request
    if let kind = request["kind"] {
        command["kind"] = kind
    }
    guard command["kind"] != nil else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Native Computer Use helper requires a command kind"
        )
    }
    return command
}

func handle(_ request: [String: Any], session: ComputerUseRuntimeSession?) throws -> [String: Any] {
    let kind = try requiredString(request, "kind")
    switch kind {
    case "permissions.state":
        return handlePermissionsState()
    case "permissions.request_accessibility":
        return handlePermissionsRequestAccessibility()
    case "permissions.request_screen_recording":
        return handlePermissionsRequestScreenRecording()
    case "apps.list":
        return handleAppsList()
    case "app.state":
        return try handleAppState(request, session: session)
    case "app.open":
        return try handleAppOpen(request)
    case "element.click":
        return try handleElementClick(request, session: session)
    case "element.click_point":
        return try handleElementClickPoint(request, session: session)
    case "element.set_value":
        return try handleElementSetValue(request, session: session)
    case "element.perform_action":
        return try handleElementPerformAction(request, session: session)
    case "keyboard.type_text":
        return try handleTypeText(request)
    case "keyboard.press_key":
        return try handlePressKey(request)
    case "element.scroll":
        return try handleScrollElement(request, session: session)
    default:
        throw HelperFailure(
            code: "unsupported_command",
            message: "Unsupported native Computer Use command: \(kind)"
        )
    }
}

func writeJSONObject(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func responseObject(for request: [String: Any], session: ComputerUseRuntimeSession?) -> [String: Any] {
    var response: [String: Any]
    do {
        let command = try commandRequest(from: request)
        let result = try handle(command, session: session)
        response = [
            "status": "succeeded",
            "result": result,
        ]
    } catch let failure as HelperFailure {
        response = [
            "status": "failed",
            "error": [
                "code": failure.code,
                "message": failure.message,
            ],
        ]
    } catch {
        response = [
            "status": "failed",
            "error": [
                "code": "accessibility_unavailable",
                "message": String(describing: error),
            ],
        ]
    }

    if let id = request["id"] {
        response["id"] = id
    }
    return response
}

func parseRequestData(_ data: Data) throws -> [String: Any] {
    let parsed = try JSONSerialization.jsonObject(with: data, options: [])
    guard let request = isRecord(parsed) else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Native Computer Use helper requires a JSON object request"
        )
    }
    return request
}

func runOneShot() {
    do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let request = try parseRequestData(input)
        try writeJSONObject(responseObject(for: request, session: nil))
    } catch let failure as HelperFailure {
        try? writeJSONObject([
            "status": "failed",
            "error": [
                "code": failure.code,
                "message": failure.message,
            ],
        ])
    } catch {
        try? writeJSONObject([
            "status": "failed",
            "error": [
                "code": "accessibility_unavailable",
                "message": String(describing: error),
            ],
        ])
    }
}

func runStdioSession() {
    let session = ComputerUseRuntimeSession()
    let mainRunLoop = RunLoopReference(CFRunLoopGetCurrent())
    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                continue
            }
            do {
                let request = try parseRequestData(Data(trimmed.utf8))
                try writeJSONObject(responseObject(for: request, session: session))
            } catch let failure as HelperFailure {
                try? writeJSONObject([
                    "status": "failed",
                    "error": [
                        "code": failure.code,
                        "message": failure.message,
                    ],
                ])
            } catch {
                try? writeJSONObject([
                    "status": "failed",
                    "error": [
                        "code": "accessibility_unavailable",
                        "message": String(describing: error),
                    ],
                ])
            }
        }
        ComputerUseVisualPointer.shared.hide()
        CFRunLoopStop(mainRunLoop.runLoop)
    }
    CFRunLoopRun()
}

func run() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments.contains("serve") || arguments.contains("--stdio") {
        runStdioSession()
        return
    }
    runOneShot()
}

run()
