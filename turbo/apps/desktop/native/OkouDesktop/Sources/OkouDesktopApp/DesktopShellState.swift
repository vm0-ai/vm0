#if canImport(AppKit)
import Combine
import Foundation
import OkouDesktopKit

/// Observable state the SwiftUI shell renders. Auth and host fields are
/// placeholders until the session and runtime ports land.
@MainActor
final class DesktopShellState: ObservableObject {
    let identity: DesktopIdentity
    let platformUrl: String
    let environment: DesktopEnvironment
    let deviceName: String?

    @Published var auth: DesktopAuthState? = nil
    @Published var permissions: ComputerUsePermissionState = .none
    @Published var host: ComputerUseHostRuntimeState = .offline
    @Published var keepAwake = DesktopKeepAwakeState(enabled: false, active: false)
    @Published var lastAuthCallbackHandoffId: String? = nil

    init(identity: DesktopIdentity, platformUrl: String, environment: DesktopEnvironment, deviceName: String?) {
        self.identity = identity
        self.platformUrl = platformUrl
        self.environment = environment
        self.deviceName = deviceName
    }
}
#endif
