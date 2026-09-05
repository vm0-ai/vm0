#if canImport(AppKit)
import AppKit

let delegate = OkouAppDelegate()
let application = NSApplication.shared
application.delegate = delegate
application.run()
#else
import Foundation

FileHandle.standardError.write(Data("okou-desktop only runs on macOS.\n".utf8))
exit(1)
#endif
