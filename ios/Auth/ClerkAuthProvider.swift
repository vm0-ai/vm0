import ClerkKit
import Foundation

protocol AuthTokenProvider: Sendable {
    func bearerToken() async throws -> String
}

enum AuthProviderError: LocalizedError, Equatable {
    case signedOut

    var errorDescription: String? {
        switch self {
        case .signedOut:
            return "Sign in before starting voice chat."
        }
    }
}

struct ClerkAuthProvider: AuthTokenProvider {
    func bearerToken() async throws -> String {
        guard let token = try await Clerk.shared.auth.getToken() else {
            throw AuthProviderError.signedOut
        }
        return token
    }
}
