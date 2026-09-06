#if canImport(AppKit)
import AppKit
import Carbon.HIToolbox

/// A Carbon hot key, which works without Accessibility access and from any
/// application; used for the ⌃⇧R stop-recording shortcut.
final class GlobalHotKey {
    private var hotKeyRef: EventHotKeyRef? = nil
    private var handlerRef: EventHandlerRef? = nil
    private let handler: () -> Void

    init?(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) {
        self.handler = handler
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let userData = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData -> OSStatus in
                guard let userData else { return noErr }
                Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue().fire()
                return noErr
            },
            1, &eventType, userData, &handlerRef
        )
        guard installStatus == noErr else { return nil }
        let hotKeyID = EventHotKeyID(signature: 0x4F4B_4F55, id: 1)
        let registerStatus = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        guard registerStatus == noErr else {
            if let handlerRef {
                RemoveEventHandler(handlerRef)
            }
            return nil
        }
    }

    private func fire() {
        handler()
    }

    func unregister() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let handlerRef {
            RemoveEventHandler(handlerRef)
            self.handlerRef = nil
        }
    }

    deinit {
        unregister()
    }

    /// `Control+Shift+R`.
    static func stopRecording(handler: @escaping () -> Void) -> GlobalHotKey? {
        GlobalHotKey(keyCode: UInt32(kVK_ANSI_R), modifiers: UInt32(controlKey | shiftKey), handler: handler)
    }
}
#endif
