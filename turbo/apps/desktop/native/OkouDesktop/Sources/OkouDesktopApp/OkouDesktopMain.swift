#if canImport(AppKit)
import AppKit

@main
struct OkouDesktopMain {
    // Keeps the delegate alive for the whole run; NSApplication only holds it weakly.
    @MainActor private static var delegate: OkouAppDelegate?

    @MainActor
    static func main() {
        let delegate = OkouAppDelegate()
        Self.delegate = delegate
        let application = NSApplication.shared
        application.delegate = delegate
        application.run()
    }
}
#else
import Foundation

@main
struct OkouDesktopMain {
    static func main() {
        FileHandle.standardError.write(Data("okou-desktop only runs on macOS.\n".utf8))
        exit(1)
    }
}
#endif
