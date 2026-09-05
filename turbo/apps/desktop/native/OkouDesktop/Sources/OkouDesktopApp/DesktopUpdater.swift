#if canImport(AppKit)
import AppKit
import OkouDesktopKit

/// Auto-update from the Squirrel JSON feed. Port of `desktop-auto-updates.ts`:
/// poll every thirty minutes, download silently, and install only while
/// Computer Use has been idle; a manual check reports through dialogs.
@MainActor
final class DesktopUpdater {
    static let checkIntervalSeconds: Double = 30 * 60

    private let config: DesktopConfig
    private let appVersion: String
    private let checker: DesktopUpdateChecker
    private let http: DesktopHTTPClient
    private let getComputerUseHostState: () -> ComputerUseHostRuntimeState
    private let prepareForQuitAndInstall: () async -> Void
    private var timer: Timer? = nil
    private var pendingUpdate: (version: String, appURL: URL)? = nil
    private var downloading: String? = nil
    private var installing = false

    private init(
        config: DesktopConfig, appVersion: String, feedBaseUrl: String, http: DesktopHTTPClient,
        getComputerUseHostState: @escaping () -> ComputerUseHostRuntimeState,
        prepareForQuitAndInstall: @escaping () async -> Void
    ) {
        self.config = config
        self.appVersion = appVersion
        self.checker = DesktopUpdateChecker(feedBaseUrl: feedBaseUrl, currentVersion: appVersion, http: http)
        self.http = http
        self.getComputerUseHostState = getComputerUseHostState
        self.prepareForQuitAndInstall = prepareForQuitAndInstall
    }

    static var isPackaged: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
    }

    static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }

    /// Returns nil when this build is not eligible for automatic updates.
    static func install(
        config: DesktopConfig, appVersion: String, http: DesktopHTTPClient,
        getComputerUseHostState: @escaping () -> ComputerUseHostRuntimeState,
        prepareForQuitAndInstall: @escaping () async -> Void
    ) -> DesktopUpdater? {
        let eligibility = DesktopUpdateFeed.Eligibility(environment: config.environment, isPackaged: isPackaged, platform: "darwin", arch: architecture)
        guard DesktopUpdateFeed.shouldInstallAutoUpdates(eligibility) else { return nil }
        guard let feedBaseUrl = DesktopUpdateFeed.baseUrl(apiBaseUrl: config.apiBaseUrl, updateLine: config.identity.updateLine),
            feedBaseUrl.hasPrefix("https://")
        else {
            NSLog("Desktop auto-updates require an HTTPS feed URL")
            return nil
        }
        let updater = DesktopUpdater(
            config: config, appVersion: appVersion, feedBaseUrl: feedBaseUrl, http: http,
            getComputerUseHostState: getComputerUseHostState, prepareForQuitAndInstall: prepareForQuitAndInstall
        )
        updater.start()
        return updater
    }

    private func start() {
        timer = Timer.scheduledTimer(withTimeInterval: Self.checkIntervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check(interactive: false) }
        }
        Task { await check(interactive: false) }
    }

    /// One poll: retry a deferred install first, then look for a newer release.
    func check(interactive: Bool) async {
        await installPendingUpdateWhenInactive()
        do {
            guard let candidate = try await checker.check() else {
                if interactive {
                    showNoUpdateDialog()
                }
                return
            }
            if pendingUpdate?.version != candidate.version, downloading != candidate.version {
                downloading = candidate.version
                defer { downloading = nil }
                let appURL = try await download(candidate)
                pendingUpdate = (candidate.version, appURL)
            }
            await installPendingUpdateWhenInactive()
        } catch {
            NSLog("Desktop update check failed: \(error)")
            if interactive {
                showCheckFailedDialog(error)
            }
        }
    }

    private var updatesDirectory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent(config.identity.bundleId).appendingPathComponent("updates")
    }

    /// Downloads and extracts the release, verifying it is this product at
    /// the advertised version before it is allowed to replace the app.
    private func download(_ candidate: DesktopUpdateCandidate) async throws -> URL {
        guard let url = URL(string: candidate.url), url.scheme == "https" else {
            throw DesktopConfigError("Desktop update URL must use https: \(candidate.url)")
        }
        let response = try await http.send(URLRequest.desktop(url: url))
        guard response.ok else {
            throw DesktopConfigError("Desktop update download responded with HTTP \(response.status)")
        }
        let directory = updatesDirectory.appendingPathComponent(candidate.version)
        try? FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let archive = directory.appendingPathComponent("update.zip")
        try response.body.write(to: archive)
        let extracted = directory.appendingPathComponent("extracted")
        try FileManager.default.createDirectory(at: extracted, withIntermediateDirectories: true)
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = ["-xk", archive.path, extracted.path]
        try ditto.run()
        ditto.waitUntilExit()
        guard ditto.terminationStatus == 0 else {
            throw DesktopConfigError("Desktop update archive could not be extracted")
        }
        let apps = try FileManager.default.contentsOfDirectory(at: extracted, includingPropertiesForKeys: nil).filter { $0.pathExtension == "app" }
        guard apps.count == 1, let app = apps.first else {
            throw DesktopConfigError("Desktop update archive did not contain exactly one app")
        }
        guard let bundle = Bundle(url: app), bundle.bundleIdentifier == config.identity.bundleId,
            bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == candidate.version
        else {
            throw DesktopConfigError("Desktop update archive is not \(config.identity.displayName) \(candidate.version)")
        }
        return app
    }

    private func shouldDeferDownloadedUpdate() -> Bool {
        DesktopUpdatePolicy.shouldDeferUpdate(hostState: getComputerUseHostState(), nowMs: Date().timeIntervalSince1970 * 1000)
    }

    private func installPendingUpdateWhenInactive() async {
        guard let pendingUpdate, !installing, !shouldDeferDownloadedUpdate() else { return }
        installing = true
        defer { installing = false }
        await prepareForQuitAndInstall()
        do {
            try relaunch(with: pendingUpdate.appURL)
            self.pendingUpdate = nil
        } catch {
            NSLog("Desktop update install failed: \(error)")
        }
    }

    /// Swaps the bundle after this process exits, then relaunches it; the
    /// script outlives the app the way Squirrel's ShipIt does.
    private func relaunch(with newApp: URL) throws {
        let currentApp = Bundle.main.bundleURL
        let backup = currentApp.deletingLastPathComponent().appendingPathComponent(".\(currentApp.lastPathComponent).previous")
        let script = """
            #!/bin/sh
            pid="$1"; app="$2"; new="$3"; backup="$4"
            while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
            rm -rf "$backup"
            if mv "$app" "$backup"; then
              if mv "$new" "$app"; then
                rm -rf "$backup"
              else
                mv "$backup" "$app"
              fi
            fi
            /usr/bin/open -n "$app"
            """
        let scriptURL = updatesDirectory.appendingPathComponent("install.sh")
        try Data(script.utf8).write(to: scriptURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
        let installer = Process()
        installer.executableURL = URL(fileURLWithPath: "/bin/sh")
        installer.arguments = [scriptURL.path, "\(ProcessInfo.processInfo.processIdentifier)", currentApp.path, newApp.path, backup.path]
        installer.standardInput = FileHandle.nullDevice
        installer.standardOutput = FileHandle.nullDevice
        installer.standardError = FileHandle.nullDevice
        try installer.run()
        NSApp.terminate(nil)
    }

    private func showNoUpdateDialog() {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "\(config.identity.displayName) is up to date."
        alert.addButton(withTitle: "OK")
        NSApp.activate()
        alert.runModal()
    }

    private func showCheckFailedDialog(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "\(config.identity.displayName) could not check for updates."
        alert.informativeText = String(describing: error)
        alert.addButton(withTitle: "OK")
        NSApp.activate()
        alert.runModal()
    }
}
#endif
