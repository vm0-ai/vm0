import Foundation

public struct DesktopAuthUser: Equatable, Sendable {
    public let userId: String
    public let email: String

    public init(userId: String, email: String) {
        self.userId = userId
        self.email = email
    }
}

public struct DesktopAuthOrganization: Equatable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum DesktopAuthState: Equatable, Sendable {
    case signingIn
    case signedOut
    case signedIn(user: DesktopAuthUser, organization: DesktopAuthOrganization?)

    public var status: String {
        switch self {
        case .signingIn: return "signing_in"
        case .signedOut: return "signed_out"
        case .signedIn: return "signed_in"
        }
    }

    public var user: DesktopAuthUser? {
        if case let .signedIn(user, _) = self { return user }
        return nil
    }

    public var organization: DesktopAuthOrganization? {
        if case let .signedIn(_, organization) = self { return organization }
        return nil
    }

    public var isSignedIn: Bool {
        if case .signedIn = self { return true }
        return false
    }

    /// `hasReadyDesktopAuth`: signed in with an active workspace.
    public var isReady: Bool {
        if case let .signedIn(_, organization) = self { return organization != nil }
        return false
    }
}
