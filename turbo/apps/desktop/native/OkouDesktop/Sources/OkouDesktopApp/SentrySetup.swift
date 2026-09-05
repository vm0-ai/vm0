#if canImport(AppKit)
import Foundation
import OkouDesktopKit
import Sentry

/// Sentry for the Swift shell, mirroring `sentry-main.ts`: the DSN comes from
/// the packaged `desktop-sentry.json` or the environment, the release is
/// `desktop@<version>`, and the helpers inherit the same settings.
enum SentrySetup {
    static let configFileName = "desktop-sentry.json"

    struct Settings {
        let dsn: String
        let environment: String
    }

    static func settings(resources: URL, environment: [String: String] = ProcessInfo.processInfo.environment) -> Settings? {
        var dsn = environment["OKOU_DESKTOP_SENTRY_DSN"] ?? environment["SENTRY_DSN_DESKTOP"]
        var sentryEnvironment = environment["OKOU_DESKTOP_SENTRY_ENVIRONMENT"] ?? environment["SENTRY_ENVIRONMENT"]
        if dsn == nil, let data = try? Data(contentsOf: resources.appendingPathComponent(configFileName)),
            let json = try? JSONValue.parse(data)
        {
            dsn = json["dsn"]?.stringValue
            sentryEnvironment = sentryEnvironment ?? json["environment"]?.stringValue
        }
        guard let dsn, !dsn.isEmpty else { return nil }
        return Settings(dsn: dsn, environment: sentryEnvironment ?? "production")
    }

    @discardableResult
    static func start(resources: URL, version: String) -> Settings? {
        guard let settings = settings(resources: resources) else { return nil }
        let release = "desktop@\(version)"
        // The native helpers read these when they start.
        setenv("OKOU_DESKTOP_SENTRY_DSN", settings.dsn, 1)
        setenv("OKOU_DESKTOP_SENTRY_RELEASE", release, 1)
        setenv("OKOU_DESKTOP_SENTRY_ENVIRONMENT", settings.environment, 1)
        SentrySDK.start { options in
            options.dsn = settings.dsn
            options.releaseName = release
            options.environment = settings.environment
            options.sendDefaultPii = false
            options.tracesSampleRate = 0
            options.enableAutoPerformanceTracing = false
        }
        SentrySDK.configureScope { scope in
            scope.setTag(value: "desktop", key: "app")
            scope.setTag(value: "swift-main", key: "component")
        }
        return settings
    }

    /// Native helper failures with the same tags the Electron main process used.
    static func captureNativeHelperError(_ error: ComputerUseNativeHelperError, context: [String: String]) {
        guard SentrySDK.isEnabled else { return }
        SentrySDK.capture(message: error.message) { scope in
            for (key, value) in context {
                scope.setTag(value: value, key: "nativeHelper\(key.prefix(1).uppercased())\(key.dropFirst())")
            }
            scope.setContext(value: context, key: "computerUseHelper")
        }
    }
}
#endif
