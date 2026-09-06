#if canImport(AppKit)
import OkouDesktopKit
import SwiftUI

/// SwiftUI port of the renderer: header, the setup wizard (account and
/// permissions steps), the ready hero, and the developer-tools panels.
struct DesktopShellView: View {
    @ObservedObject var state: DesktopShellState
    let runtime: DesktopAppRuntime

    private var brandName: String { state.identity.brandName.rawValue }

    private var brand: Color {
        state.identity.product == .zero ? Color(red: 0xed / 255, green: 0x4e / 255, blue: 0x01 / 255)
            : Color(red: 1, green: 0xa5 / 255, blue: 0)
    }

    private static let ink = Color(red: 0x26 / 255, green: 0x22 / 255, blue: 0x1d / 255)
    private static let background = Color(red: 0xfa / 255, green: 0xf5 / 255, blue: 0xf3 / 255)
    private static let border = Color(red: 30 / 255, green: 38 / 255, blue: 52 / 255).opacity(0.1)
    private static let online = Color(red: 0x15 / 255, green: 0xa0 / 255, blue: 0x6b / 255)

    static let statusLabels: [ComputerUseHostRuntimeStatus: String] = [
        .offline: "Offline", .connecting: "Connecting", .online: "Online", .recovering: "Recovering",
        .unauthenticated: "Signed out", .needsOrganization: "Select workspace", .disabled: "Disabled", .error: "Error",
    ]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if state.authLoading && state.auth == nil {
                        loadingPanel
                    } else if state.authReady && state.permissionsReady {
                        readyExperience
                    } else {
                        accountStep
                        permissionsStep
                    }
                    if let error = state.lastActionError {
                        inlineAlert(error)
                    }
                    if state.developerTools.available && state.developerTools.enabled {
                        filesystemPluginPanel
                        McpServersPanel(state: state, runtime: runtime)
                        runtimePanel
                        commandLogPanel
                    }
                }
                .frame(maxWidth: 1120, alignment: .leading)
                .padding(EdgeInsets(top: 18, leading: 20, bottom: 32, trailing: 20))
                .frame(maxWidth: .infinity)
            }
        }
        .frame(minWidth: 1024, minHeight: 700)
        .background(Self.background)
        .foregroundStyle(Self.ink)
        .task { await runtime.refreshComputerUsePermissions() }
    }

    // MARK: Header

    private var header: some View {
        HStack {
            Text(state.identity.displayName)
                .font(.system(size: 14, weight: .semibold))
            Spacer()
            Text(state.environment == .production ? state.platformUrl : "\(state.environment.rawValue) · \(state.platformUrl)")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .padding(.leading, 92)
        .padding(.trailing, 20)
        .frame(height: 52)
        .background(Color(red: 0xf8 / 255, green: 0xf9 / 255, blue: 0xfb / 255).opacity(0.82))
    }

    private var loadingPanel: some View {
        VStack(spacing: 12) {
            brandMark(size: 92)
            Text("Preparing").font(.system(size: 17, weight: .semibold))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 120)
    }

    private func brandMark(size: CGFloat) -> some View {
        ZStack {
            Circle().fill(brand.opacity(0.14))
            Text(String(brandName.prefix(1)))
                .font(.system(size: size * 0.42, weight: .bold))
                .foregroundStyle(brand)
        }
        .frame(width: size, height: size)
    }

    // MARK: Setup wizard

    private var accountStep: some View {
        Group {
            if case let .signedIn(user, organization?) = state.auth {
                panel(kicker: "✓", title: "Signed in") {
                    Text("\(user.email) - \(organization.name)").font(.system(size: 13)).foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        secondaryButton("Switch workspace") { Task { await runtime.selectOrganization() } }
                        secondaryButton("Sign out", danger: true) { Task { await runtime.signOut() } }
                    }
                }
            } else {
                panel(kicker: "1", title: accountHeading) {
                    Text(accountDescription).font(.system(size: 13)).foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        if case .signedIn(_, nil) = state.auth {
                            primaryButton("Select workspace") { Task { await runtime.selectOrganization() } }
                            secondaryButton("Sign out", danger: true) { Task { await runtime.signOut() } }
                        } else {
                            primaryButton(state.signingIn ? "Signing in..." : "Sign in", disabled: state.authLoading || state.signingIn) {
                                runtime.openSignIn()
                            }
                        }
                    }
                }
            }
        }
    }

    private var accountHeading: String {
        if state.authLoading { return "Checking sign-in" }
        if case .signedIn(_, nil) = state.auth { return "Select a workspace" }
        if state.signingIn { return "Finish signing in" }
        return "Sign in to \(brandName)"
    }

    private var accountDescription: String {
        if case .signedIn(_, nil) = state.auth {
            return "Choose the workspace that should receive this Mac as a Computer Use runtime."
        }
        return "Connect this Mac to a \(brandName) account before Computer Use can register a runtime."
    }

    private var permissionsStep: some View {
        Group {
            if state.permissionsReady {
                EmptyView()
            } else if !state.authReady {
                panel(kicker: "2", title: "Allow Computer Use permissions", pending: true) {
                    Text("Sign in and select a workspace first.").font(.system(size: 13)).foregroundStyle(.secondary)
                }
            } else {
                panel(kicker: "2", title: "Allow Computer Use permissions") {
                    Text(permissionsDescription).font(.system(size: 13)).foregroundStyle(.secondary)
                    permissionRow(
                        title: "Accessibility", detail: "Required for clicking, typing, and reading UI structure",
                        granted: state.permissions.accessibility,
                        request: { Task { await runtime.requestAccessibilityPermission() } },
                        settings: { DesktopSystemSettings.open(.accessibility) }
                    )
                    permissionRow(
                        title: "Screen Recording", detail: "Required for screenshots and visual context",
                        granted: state.permissions.screenRecording,
                        request: { Task { await runtime.requestScreenRecordingPermission() } },
                        settings: { DesktopSystemSettings.open(.screenRecording) }
                    )
                    automationRow
                }
            }
        }
    }

    private var permissionsDescription: String {
        var text = "\(brandName) needs macOS permission to inspect the screen and control UI elements on this Mac."
        if state.identity.product == .okou {
            text += " Okou is a separate app from Zero, so these permissions must be granted again."
        }
        return text
    }

    private func permissionRow(title: String, detail: String, granted: Bool, request: @escaping () -> Void, settings: @escaping () -> Void) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(granted ? "Granted" : detail).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            if granted {
                pill("✓ Ready", tint: Self.online)
            } else {
                secondaryButton("Request", action: request)
            }
            secondaryButton("Settings", action: settings)
        }
    }

    private static let automationPills: [ComputerUseAutomationPermissionStatus: String] = [
        .unknown: "Not tested", .granted: "Ready", .denied: "Needs approval", .notInstalled: "Not installed", .notRunning: "Open browser",
    ]

    private var automationRow: some View {
        let automation = state.permissions.automation
        let ready = ComputerUseAutomationPermissionTarget.allCases.filter { automation[$0].status == .granted }
        let denied = ComputerUseAutomationPermissionTarget.allCases.contains { automation[$0].status == .denied }
        let meta: String
        if !ready.isEmpty {
            meta = "\(joinedLabels(ready.map(\.label))) ready. Other browsers can be approved later."
        } else if denied {
            meta = "Allow \(brandName) to control the browser you use in System Settings"
        } else {
            meta = "Optional for browser control. Test only the browser you use."
        }
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Browser Automation").font(.system(size: 13, weight: .semibold))
                Text(meta).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            if ready.isEmpty {
                ForEach(ComputerUseAutomationPermissionTarget.allCases, id: \.self) { target in
                    secondaryButton("Test \(target == .chrome ? "Chrome" : "Safari")") {
                        Task { await runtime.probeAutomationPermission(target) }
                    }
                }
            } else {
                pill(Self.automationPills[.granted] ?? "Ready", tint: Self.online)
            }
            if denied {
                secondaryButton("Settings") { DesktopSystemSettings.open(.automation) }
            }
        }
    }

    private func joinedLabels(_ labels: [String]) -> String {
        guard labels.count > 1 else { return labels.first ?? "" }
        return labels.dropLast().joined(separator: ", ") + " and " + labels.last!
    }

    // MARK: Ready experience

    private var running: Bool {
        [.online, .connecting, .recovering].contains(state.host.status)
    }

    private var readyExperience: some View {
        VStack(spacing: 20) {
            if running {
                onlineHero
            } else {
                offlineHero
            }
            heroFooter
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    private var onlineHero: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle().stroke(brand.opacity(0.35), lineWidth: 2).frame(width: 214, height: 214)
                Circle().stroke(brand.opacity(0.25), lineWidth: 2).frame(width: 166, height: 166)
                Circle().stroke(brand.opacity(0.18), lineWidth: 2).frame(width: 118, height: 118)
                brandMark(size: 104)
            }
            .frame(width: 240, height: 240)
            Text(state.deviceName ?? statusLabel).font(.system(size: 20, weight: .semibold))
            if state.deviceName != nil {
                HStack(spacing: 6) {
                    Circle().fill(state.host.status == .online ? Self.online : brand).frame(width: 7, height: 7)
                    Text(statusLabel).font(.system(size: 13)).foregroundStyle(.secondary)
                }
            }
            secondaryButton("Stop", danger: true, disabled: !(state.host.status == .online || state.host.status == .recovering)) {
                Task { await runtime.stopComputerUse() }
            }
        }
    }

    private var offlineHero: some View {
        VStack(spacing: 14) {
            brandMark(size: 108).opacity(0.7)
            Text("Offline").font(.system(size: 20, weight: .semibold))
            primaryButton("Go online", disabled: state.host.status == .disabled) {
                Task { await runtime.startComputerUse(userInitiated: true) }
            }
            if let error = state.host.lastError {
                Text(error).font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
        }
    }

    private var statusLabel: String {
        Self.statusLabels[state.host.status] ?? state.host.status.rawValue
    }

    private var heroFooter: some View {
        HStack(spacing: 12) {
            if case let .signedIn(user, organization) = state.auth {
                Text("\(user.email.isEmpty ? "Signed in" : user.email) · \(organization?.name ?? "")")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 6) {
                Circle().fill(state.permissionsReady ? Self.online : brand).frame(width: 7, height: 7)
                Text(state.permissionsReady ? "Accessibility and screen recording granted" : "Accessibility and screen recording needed")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Toggle("Keep Mac awake", isOn: Binding(
                get: { state.keepAwake.enabled },
                set: { runtime.setKeepAwakeEnabled($0) }
            ))
            .toggleStyle(.checkbox)
            .font(.system(size: 12))
            secondaryButton("Switch workspace") { Task { await runtime.selectOrganization() } }
            secondaryButton("Sign out", danger: true) { Task { await runtime.signOut() } }
        }
        .padding(.horizontal, 12)
    }

    // MARK: Developer panels

    private static let pluginStatusLabels: [DesktopComputerUsePluginStatus: String] = [
        .disabled: "Disabled", .starting: "Starting", .running: "Ready", .restarting: "Restarting", .error: "Error",
    ]

    private var filesystemPluginPanel: some View {
        let plugin = state.plugins?.filesystem
        return panel(title: "Filesystem plugin") {
            HStack(alignment: .top, spacing: 24) {
                metric("Status", Self.pluginStatusLabels[plugin?.status ?? .disabled] ?? "Disabled")
                metric("Directories", "\(plugin?.allowedDirectories.count ?? 0)")
                metric("Tools", "\(plugin?.capabilities.filter { $0.hasPrefix("plugin.filesystem.") }.count ?? 0)")
                metric("Version", plugin?.version ?? "")
            }
            Toggle(isOn: Binding(get: { plugin?.enabled ?? false }, set: { runtime.setFilesystemPluginEnabled($0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Enable filesystem").font(.system(size: 13, weight: .semibold))
                    Text("Allow authorized Computer Use sessions to use selected folders.").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.checkbox)
            if let directories = plugin?.allowedDirectories, !directories.isEmpty {
                ForEach(directories, id: \.self) { directory in
                    HStack {
                        Text(directory).font(.system(size: 12, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Button(action: { runtime.removeFilesystemPluginAllowedDirectory(directory) }) {
                            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).frame(width: 22, height: 22)
                        }
                        .buttonStyle(.plain).accessibilityLabel("Remove \(directory)").help("Remove directory")
                    }
                }
            } else {
                Text("No directories added.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if let error = plugin?.lastError {
                inlineAlert(error)
            }
            secondaryButton("Add directory") { Task { await runtime.addFilesystemPluginAllowedDirectory() } }
        }
    }

    private var runtimePanel: some View {
        panel(title: "Runtime") {
            HStack(alignment: .top, spacing: 24) {
                metric("Status", statusLabel)
                metric("Host ID", state.host.hostId ?? "Not registered")
                metric("Last heartbeat", formatTimestamp(state.host.lastHeartbeatAt))
                metric("Last command", formatTimestamp(state.host.lastCommandAt))
            }
            if let recovery = state.host.recovery {
                inlineAlert("\(recovery.phase == .start ? "Start" : recovery.phase == .heartbeat ? "Heartbeat" : "Command poll") retry attempt \(recovery.attempt); next retry in \(formatRecoveryDelay(recovery)).")
            }
            if let error = state.host.lastError {
                inlineAlert(error)
            }
            HStack(spacing: 10) {
                primaryButton("Start") { Task { await runtime.startComputerUse(userInitiated: true) } }
                secondaryButton("Stop", danger: true) { Task { await runtime.stopComputerUse() } }
                secondaryButton("Refresh") { Task { await runtime.refreshComputerUsePermissions() } }
            }
        }
    }

    private var commandLogPanel: some View {
        panel(title: "Command Log") {
            if state.host.localCommandLog.isEmpty {
                Text("No local native commands have run.").font(.system(size: 13)).foregroundStyle(.secondary)
            } else {
                ForEach(state.host.localCommandLog, id: \.commandId) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(entry.kind).font(.system(size: 13, weight: .semibold))
                            Spacer()
                            pill(DesktopTrayMenu.commandStatusLabels[entry.status] ?? entry.status.rawValue, tint: entry.status == .failed ? .red : entry.status == .running ? brand : Self.online)
                        }
                        Text("\(entry.app ?? "No target app") - \(formatTimestamp(entry.startedAt)) - \(formatDuration(entry.durationMs))")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                        if let summary = entry.result?["summary"]?.stringValue ?? entry.result?["action"]?["summary"]?.stringValue {
                            Text(summary).font(.system(size: 12))
                        }
                        if let error = entry.error {
                            Text(JSONValue.object(error).serialized()).font(.system(size: 11, design: .monospaced)).foregroundStyle(.red)
                        }
                    }
                    .padding(.vertical, 6)
                    Divider()
                }
            }
        }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 13, weight: .medium))
        }
    }

    private func formatTimestamp(_ value: String?) -> String {
        guard let value else { return "Never" }
        guard let date = ISOTimestamp.date(from: value) else { return value }
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, hh:mm a"
        return formatter.string(from: date)
    }

    private func formatDuration(_ value: Double?) -> String {
        guard let value else { return "In progress" }
        if value < 1000 { return "\(Int(value)) ms" }
        return String(format: "%.1f s", value / 1000)
    }

    private func formatRecoveryDelay(_ recovery: ComputerUseRuntimeRecoveryState) -> String {
        let seconds = recovery.retryDelayMs / 1000
        if seconds < 1 { return "now" }
        if seconds < 60 { return "\(Int(seconds))s" }
        return "\(Int(seconds / 60))m"
    }

    // MARK: Controls

    private func inlineAlert(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 12))
            .foregroundStyle(.red)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private func pill(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tint.opacity(0.14), in: Capsule())
            .foregroundStyle(tint)
    }

    private func primaryButton(_ title: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 32)
        }
        .buttonStyle(.plain)
        .background(brand.opacity(disabled ? 0.5 : 1), in: RoundedRectangle(cornerRadius: 9))
        .foregroundStyle(Color(red: 0x24 / 255, green: 0x21 / 255, blue: 0x21 / 255))
        .disabled(disabled)
    }

    private func secondaryButton(_ title: String, danger: Bool = false, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .frame(minHeight: 28)
        }
        .buttonStyle(.plain)
        .background(Color.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Self.border, lineWidth: 1))
        .foregroundStyle(danger ? Color.red : Self.ink)
        .opacity(disabled ? 0.5 : 1)
        .disabled(disabled)
    }

    private func panel<Content: View>(
        kicker: String? = nil, title: String, pending: Bool = false, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if let kicker {
                    Text(kicker)
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 22, height: 22)
                        .background((pending ? Color.gray : brand).opacity(0.14), in: Circle())
                }
                Text(title).font(.system(size: 17, weight: .semibold))
            }
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Self.border, lineWidth: 1))
    }
}
/// The MCP servers developer panel: per-server toggles and the import box.
struct McpServersPanel: View {
    @ObservedObject var state: DesktopShellState
    let runtime: DesktopAppRuntime
    @State private var draft = ""
    @State private var importError: String? = nil
    @State private var importing = false

    static let sampleConfig = """
        {
          "mcpServers": {
            "apple-notes": { "command": "npx", "args": ["-y", "mcp-apple-notes"] },
            "figma": { "url": "http://127.0.0.1:3845/mcp" }
          }
        }
        """

    private static let statusLabels: [DesktopComputerUsePluginStatus: String] = [
        .disabled: "Disabled", .starting: "Starting", .running: "Ready", .restarting: "Restarting", .error: "Error",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("MCP servers").font(.system(size: 17, weight: .semibold))
            let servers = state.plugins?.mcp.servers ?? []
            if servers.isEmpty {
                Text("No MCP servers configured.").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                ForEach(servers, id: \.name) { server in
                    HStack(spacing: 10) {
                        Toggle(isOn: Binding(get: { server.enabled }, set: { runtime.setMcpPluginServerEnabled(server.name, $0) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(server.name).font(.system(size: 13, weight: .semibold))
                                Text(serverMeta(server)).font(.system(size: 12)).foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.checkbox)
                        Spacer()
                        Text(Self.statusLabels[server.status] ?? server.status.rawValue).font(.system(size: 12)).foregroundStyle(.secondary)
                        Button(action: { runtime.removeMcpPluginServer(server.name) }) {
                            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).frame(width: 22, height: 22)
                        }
                        .buttonStyle(.plain).accessibilityLabel("Remove \(server.name)").help("Remove server")
                    }
                    if let error = server.lastError {
                        Text(error).font(.system(size: 11)).foregroundStyle(.red)
                    }
                }
            }
            TextEditor(text: $draft)
                .font(.system(size: 12, design: .monospaced))
                .frame(minHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(red: 30 / 255, green: 38 / 255, blue: 52 / 255).opacity(0.1), lineWidth: 1))
                .overlay(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(Self.sampleConfig).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary.opacity(0.6))
                            .padding(6).allowsHitTesting(false)
                    }
                }
            if let importError {
                Text(importError).font(.system(size: 12)).foregroundStyle(.red)
            }
            HStack(spacing: 10) {
                Button("Use sample") { draft = Self.sampleConfig }.buttonStyle(.bordered)
                Button("Import servers") {
                    importing = true
                    importError = runtime.importMcpPluginServers(draft)
                    if importError == nil { draft = "" }
                    importing = false
                }
                .buttonStyle(.borderedProminent)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || importing)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(red: 30 / 255, green: 38 / 255, blue: 52 / 255).opacity(0.1), lineWidth: 1))
    }

    private func serverMeta(_ server: DesktopComputerUseMcpServerState) -> String {
        var meta = server.transport == .http ? "Streamable HTTP" : "stdio"
        if server.status == .running {
            meta += " · \(server.tools.count) tools"
        }
        return meta
    }
}
#endif
