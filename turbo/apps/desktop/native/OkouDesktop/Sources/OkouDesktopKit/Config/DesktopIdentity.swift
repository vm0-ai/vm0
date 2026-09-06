import Foundation

public enum DesktopProduct: String, CaseIterable, Sendable, Codable {
    case zero
    case okou
}

public enum DesktopBrandName: String, Sendable, Codable {
    case zero = "Zero"
    case okou = "Okou"
}

/// Every update line the API's `:product` routes accept. Only `ai-okou-desktop`
/// is still served; the other two answer 404 but stay representable so a
/// retired identity can be described truthfully.
public enum DesktopUpdateLine: String, Sendable, Codable {
    case zero
    case legacyOkou = "okou"
    case okou = "ai-okou-desktop"
}

public enum DesktopIdentityKind: String, Sendable {
    case production
    case development
}

public struct DesktopIdentity: Equatable, Sendable {
    public let product: DesktopProduct
    public let brandName: DesktopBrandName
    public let displayName: String
    public let userDataDirectoryName: String
    public let updateLine: DesktopUpdateLine
    public let bundleId: String
    public let authProtocolName: String
    public let authScheme: String

    public init(
        product: DesktopProduct,
        brandName: DesktopBrandName,
        displayName: String,
        userDataDirectoryName: String,
        updateLine: DesktopUpdateLine,
        bundleId: String,
        authProtocolName: String,
        authScheme: String
    ) {
        self.product = product
        self.brandName = brandName
        self.displayName = displayName
        self.userDataDirectoryName = userDataDirectoryName
        self.updateLine = updateLine
        self.bundleId = bundleId
        self.authProtocolName = authProtocolName
        self.authScheme = authScheme
    }
}

/// Mirror of `src/desktop-identities.json`; a test keeps the two in sync.
public enum DesktopIdentities {
    public static func defaultPlatformUrl(for product: DesktopProduct) -> String {
        switch product {
        case .zero: return "https://app.vm0.ai"
        case .okou: return "https://app.okou.ai"
        }
    }

    public static func identity(product: DesktopProduct, kind: DesktopIdentityKind) -> DesktopIdentity {
        switch (product, kind) {
        case (.zero, .production):
            return DesktopIdentity(
                product: .zero,
                brandName: .zero,
                displayName: "Zero Computer Use",
                userDataDirectoryName: "Zero Computer Use",
                updateLine: .zero,
                bundleId: "ai.vm0.zero.desktop",
                authProtocolName: "Zero Desktop Auth",
                authScheme: "ai.vm0.zero.desktop"
            )
        case (.zero, .development):
            return DesktopIdentity(
                product: .zero,
                brandName: .zero,
                displayName: "Zero CU Dev",
                userDataDirectoryName: "Zero CU Dev",
                updateLine: .zero,
                bundleId: "ai.vm0.zero.desktop.dev",
                authProtocolName: "Zero CU Dev Desktop Auth",
                authScheme: "ai.vm0.zero.desktop.dev"
            )
        case (.okou, .production):
            return DesktopIdentity(
                product: .okou,
                brandName: .okou,
                displayName: "Okou",
                userDataDirectoryName: "Okou",
                updateLine: .okou,
                bundleId: "ai.okou.desktop",
                authProtocolName: "Okou Auth",
                authScheme: "ai.okou.desktop"
            )
        case (.okou, .development):
            return DesktopIdentity(
                product: .okou,
                brandName: .okou,
                displayName: "Okou Dev",
                userDataDirectoryName: "Okou Dev",
                updateLine: .okou,
                bundleId: "ai.okou.desktop.dev",
                authProtocolName: "Okou Dev Auth",
                authScheme: "ai.okou.desktop.dev"
            )
        }
    }
}

public struct DesktopBrandAssets: Equatable, Sendable {
    public let appIconBaseName: String
    public let appIconFileName: String
    public let trayIconFileName: String
    public let trayIconDisabledFileName: String
    public let trayIconRunningFileName: String

    /// Mirror of `src/desktop-brand-assets.json`.
    public static func assets(for product: DesktopProduct) -> DesktopBrandAssets {
        switch product {
        case .zero:
            return DesktopBrandAssets(
                appIconBaseName: "icon-zero",
                appIconFileName: "icon-zero.png",
                trayIconFileName: "zero-tray-iconTemplate.png",
                trayIconDisabledFileName: "zero-tray-iconDisabled.png",
                trayIconRunningFileName: "zero-tray-iconRunning.png"
            )
        case .okou:
            return DesktopBrandAssets(
                appIconBaseName: "icon",
                appIconFileName: "icon.png",
                trayIconFileName: "tray-iconTemplate.png",
                trayIconDisabledFileName: "tray-iconDisabled.png",
                trayIconRunningFileName: "tray-iconRunning.png"
            )
        }
    }
}
