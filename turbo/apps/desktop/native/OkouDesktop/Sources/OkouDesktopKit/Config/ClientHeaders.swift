import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The five `X-Client-*` headers every desktop request carries. Port of
/// `desktop-client-headers.ts` over the `client-headers.ts` contract.
public struct DesktopClientHeaders: Sendable {
    public static let versionHeader = "X-Client-Version"
    public static let typeHeader = "X-Client-Type"
    public static let productHeader = "X-Client-Product"
    public static let sessionIdHeader = "X-Client-Session-Id"
    public static let requestIdHeader = "X-Client-Request-Id"
    public static let clientTypeDesktop = "Desktop"
    public static let forceUpgradeStatus = 426

    public let clientVersion: String
    public let product: DesktopProduct?
    public let sessionId: String
    private let createUuid: @Sendable () -> String

    public init(
        clientVersion: String,
        product: DesktopProduct? = nil,
        createUuid: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.clientVersion = clientVersion
        self.product = product
        self.createUuid = createUuid
        self.sessionId = createUuid()
    }

    /// A fresh header set for one request. Always overwrites caller-supplied
    /// values for these names, like the Electron injector.
    public func headers() -> [String: String] {
        [
            Self.versionHeader: clientVersion,
            Self.typeHeader: Self.clientTypeDesktop,
            // The injector defaults to `zero`; `main.ts` always passes the
            // configured product so the header matches the packaged identity.
            Self.productHeader: (product ?? .zero).rawValue,
            Self.sessionIdHeader: sessionId,
            Self.requestIdHeader: createUuid(),
        ]
    }

    public func apply(to request: inout URLRequest) {
        for (name, value) in headers() {
            request.setValue(value, forHTTPHeaderField: name)
        }
    }
}
