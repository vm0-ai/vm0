#if canImport(AppKit)
import Combine
import Foundation
import OkouDesktopKit

/// Observable state the SwiftUI shell renders; the counterpart of the
/// renderer's bridge state.
@MainActor
final class DesktopShellState: ObservableObject {
    let identity: DesktopIdentity
    let platformUrl: String
    let environment: DesktopEnvironment
    let deviceName: String?

    @Published var auth: DesktopAuthState? = nil
    @Published var authLoading = true
    @Published var authError: String? = nil
    @Published var signingIn = false
    @Published var permissions: ComputerUsePermissionState = .none
    @Published var host: ComputerUseHostRuntimeState = .offline
    @Published var keepAwake = DesktopKeepAwakeState(enabled: false, active: false)
    @Published var developerTools = DesktopDeveloperToolsState(available: false, enabled: false)
    @Published var plugins: DesktopComputerUsePluginsState? = nil
    @Published var busyAction: String? = nil
    @Published var lastActionError: String? = nil

    init(identity: DesktopIdentity, platformUrl: String, environment: DesktopEnvironment, deviceName: String?) {
        self.identity = identity
        self.platformUrl = platformUrl
        self.environment = environment
        self.deviceName = deviceName
    }

    var authReady: Bool {
        auth?.isReady ?? false
    }

    var permissionsReady: Bool {
        permissions.hasRequired
    }
}
#endif
