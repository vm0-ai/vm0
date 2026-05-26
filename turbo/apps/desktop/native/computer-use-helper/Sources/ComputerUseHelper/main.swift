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

final class LaunchResultBox: @unchecked Sendable {
    var app: NSRunningApplication?
    var error: Error?
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

func requiredInt(_ request: [String: Any], _ key: String) throws -> Int {
    guard let value = request[key] as? NSNumber else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "Missing required payload field: \(key)"
        )
    }
    return value.intValue
}

func optionalString(_ request: [String: Any], _ key: String) -> String? {
    guard let value = request[key] as? String else {
        return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

func optionalInt(_ request: [String: Any], _ key: String, default defaultValue: Int) -> Int {
    return (request[key] as? NSNumber)?.intValue ?? defaultValue
}

func findRunningApp(named appName: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications.filter { app in
        !app.isTerminated
    }

    if let exact = apps.first(where: { app in
        app.localizedName == appName || app.bundleIdentifier == appName
    }) {
        return exact
    }

    let normalized = appName.lowercased()
    return apps.first { app in
        app.localizedName?.lowercased() == normalized ||
            app.bundleIdentifier?.lowercased() == normalized
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

func performWithRequiredBackgroundTarget<T>(
    appName: String,
    preferredScreenPoint: CGPoint? = nil,
    _ action: (WindowTarget) throws -> T
) throws -> T {
    let app = try resolveRunningApp(named: appName)
    guard let target = resolveWindowTarget(app: app, preferredScreenPoint: preferredScreenPoint) else {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: backgroundTargetUnavailableMessage(appName: appName)
        )
    }

    return try action(target)
}

func applicationURL(named appName: String) -> URL? {
    if appName.hasPrefix("/") || appName.hasPrefix("~") {
        let expanded = (appName as NSString).expandingTildeInPath
        if FileManager.default.fileExists(atPath: expanded) {
            return URL(fileURLWithPath: expanded)
        }
    }
    if appName.contains("."),
       let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appName)
    {
        return url
    }
    return nil
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

func openApplicationWithoutActivation(named appName: String) throws -> NSRunningApplication? {
    guard let url = applicationURL(named: appName) else {
        try openWithCommandInBackground(named: appName)
        return nil
    }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
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

func restorePreviousFrontmostIfNeeded(previousApp: NSRunningApplication?, targetPID: pid_t) {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID,
          let previousApp,
          previousApp.processIdentifier != targetPID
    else {
        return
    }
    _ = previousApp.activate(options: [.activateIgnoringOtherApps])
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
    if let selected = boolValue(attribute(element, kAXSelectedAttribute as CFString)) {
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

func handleAppsList() -> [String: Any] {
    var names = Set<String>()
    for app in NSWorkspace.shared.runningApplications {
        if app.activationPolicy == .regular,
           let name = app.localizedName,
           !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            names.insert(name)
        }
    }
    return ["apps": Array(names).sorted()]
}

func handleAppState(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let snapshotId = try requiredString(request, "snapshotId")

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

    var response: [String: Any] = [
        "app": appName,
        "appDisplayName": runningApp.localizedName ?? appName,
        "pid": Int(runningApp.processIdentifier),
        "snapshotId": snapshotId,
        "elements": elements,
        "nodeCount": nodeCount,
        "truncated": !truncationReasons.isEmpty,
        "truncationReasons": truncationReasons,
    ]
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
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: backgroundTargetUnavailableMessage(appName: appName)
        )
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
    return response
}

func handleAppOpen(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let previousApp = NSWorkspace.shared.frontmostApplication
    if findRunningApp(named: appName) != nil {
        return [:]
    }

    let launchedApp = try openApplicationWithoutActivation(named: appName) ??
        waitForRunningApp(named: appName)
    guard let launchedApp else {
        throw HelperFailure(code: "app_open_failed", message: "Unable to find launched app: \(appName)")
    }
    restorePreviousFrontmostIfNeeded(previousApp: previousApp, targetPID: launchedApp.processIdentifier)
    return [:]
}

func handleElementClick(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let clickCount = max(1, min(optionalInt(request, "clickCount", default: 1), 3))
    let element = try resolveElement(appName: appName, elementId: elementId)
    for index in 0..<clickCount {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if error != .success {
            throw HelperFailure(
                code: "accessibility_unavailable",
                message: "Unable to press \(elementId): \(error.rawValue)"
            )
        }
        if index + 1 < clickCount {
            usleep(50_000)
        }
    }
    return [:]
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

func handleElementClickPoint(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let x = try requiredNumber(request, "x")
    let y = try requiredNumber(request, "y")
    let button = optionalString(request, "button") ?? "left"
    let clickCount = max(1, min(optionalInt(request, "clickCount", default: 1), 3))
    let config = try mouseEventConfig(button: button)
    let point = CGPoint(x: x, y: y)

    try performWithRequiredBackgroundTarget(appName: appName, preferredScreenPoint: point) { target in
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
    }

    return [:]
}

func handleElementSetValue(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let value = try requiredString(request, "value")
    let element = try resolveElement(appName: appName, elementId: elementId)
    try setAttribute(element, kAXValueAttribute as CFString, value as CFString)
    return [:]
}

func handleElementPerformAction(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let action = try requiredString(request, "action")
    let element = try resolveElement(appName: appName, elementId: elementId)
    let error = AXUIElementPerformAction(element, action as CFString)
    if error != .success {
        throw HelperFailure(
            code: "accessibility_unavailable",
            message: "Unable to perform \(action) on \(elementId): \(error.rawValue)"
        )
    }
    return [:]
}

func handleTypeText(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let inputText = try requiredString(request, "text")
    let root = try appElement(named: appName)
    guard let element = axElementValue(attribute(root, kAXFocusedUIElementAttribute as CFString)) else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "keyboard.type_text requires a focused editable text element in \(appName)"
        )
    }
    let role = role(element)
    let editableRoles = Set([
        "AXComboBox",
        "AXSearchField",
        "AXTextArea",
        "AXTextField",
        "AXTextView",
    ])
    guard let role, editableRoles.contains(role) else {
        throw HelperFailure(
            code: "unsupported_command",
            message: "keyboard.type_text requires a focused editable text element in \(appName)"
        )
    }

    let currentValue = stringValue(attribute(element, kAXValueAttribute as CFString)) ?? ""
    try setAttribute(element, kAXValueAttribute as CFString, (currentValue + inputText) as CFString)
    var result: [String: Any] = ["role": role]
    if let description = stringValue(attribute(element, kAXDescriptionAttribute as CFString)) {
        result["description"] = description
    }
    return result
}

func handlePressKey(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let keyCode = try requiredInt(request, "keyCode")
    let flags = try requiredInt(request, "flags")
    let modifierRecords = (request["modifiers"] as? [[String: Any]]) ?? []
    let modifiers = try modifierRecords.map { record -> (keyCode: Int, flag: Int) in
        guard let keyCode = record["keyCode"] as? NSNumber,
              let flag = record["flag"] as? NSNumber
        else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Invalid keyboard modifier payload"
            )
        }
        return (keyCode: keyCode.intValue, flag: flag.intValue)
    }

    try performWithRequiredBackgroundTarget(appName: appName) { target in
        let dispatcher = AddressedEventDispatcher(target: target)
        var activeFlags = 0
        for modifier in modifiers {
            activeFlags |= modifier.flag
            try dispatcher.postKey(keyCode: modifier.keyCode, keyDown: true, flags: activeFlags)
        }
        try dispatcher.postKey(keyCode: keyCode, keyDown: true, flags: flags)
        try dispatcher.postKey(keyCode: keyCode, keyDown: false, flags: flags)
        for modifier in modifiers.reversed() {
            activeFlags &= ~modifier.flag
            try dispatcher.postKey(keyCode: modifier.keyCode, keyDown: false, flags: activeFlags)
        }
    }
    return [:]
}

func handleScrollElement(_ request: [String: Any]) throws -> [String: Any] {
    let appName = try requiredString(request, "app")
    let elementId = try requiredString(request, "elementId")
    let direction = try requiredString(request, "direction")
    let pages = request["pages"] as? NSNumber
    let step = pages?.doubleValue ?? 1
    let axis = direction == "left" || direction == "right"
        ? "AXHorizontalScrollBar"
        : "AXVerticalScrollBar"
    let sign = direction == "up" || direction == "left" ? -1.0 : 1.0
    let element = try resolveElement(appName: appName, elementId: elementId)
    guard let scrollBar = attributeArray(element, kAXChildrenAttribute as CFString).first(where: { child in
        role(child) == axis
    }) else {
        return [:]
    }
    if let current = numberValue(attribute(scrollBar, kAXValueAttribute as CFString)) {
        try setAttribute(
            scrollBar,
            kAXValueAttribute as CFString,
            NSNumber(value: current + sign * step)
        )
    }
    return [:]
}

func handle(_ request: [String: Any]) throws -> [String: Any] {
    let kind = try requiredString(request, "kind")
    switch kind {
    case "apps.list":
        return handleAppsList()
    case "app.state":
        return try handleAppState(request)
    case "app.open":
        return try handleAppOpen(request)
    case "element.click":
        return try handleElementClick(request)
    case "element.click_point":
        return try handleElementClickPoint(request)
    case "element.set_value":
        return try handleElementSetValue(request)
    case "element.perform_action":
        return try handleElementPerformAction(request)
    case "keyboard.type_text":
        return try handleTypeText(request)
    case "keyboard.press_key":
        return try handlePressKey(request)
    case "element.scroll":
        return try handleScrollElement(request)
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

func run() {
    do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let parsed = try JSONSerialization.jsonObject(with: input, options: [])
        guard let request = isRecord(parsed) else {
            throw HelperFailure(
                code: "unsupported_command",
                message: "Native Computer Use helper requires a JSON object request"
            )
        }
        let result = try handle(request)
        try writeJSONObject([
            "status": "succeeded",
            "result": result,
        ])
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

run()
