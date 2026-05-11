import Foundation

struct AppConfig: Equatable {
    enum ConfigError: LocalizedError, Equatable {
        case invalidAPIBaseURL(String)
        case missingClerkPublishableKey

        var errorDescription: String? {
            switch self {
            case .invalidAPIBaseURL(let value):
                return "Invalid ZERO_API_BASE_URL: \(value)"
            case .missingClerkPublishableKey:
                return "Missing CLERK_PUBLISHABLE_KEY build setting"
            }
        }
    }

    let apiBaseURL: URL
    let clerkPublishableKey: String

    static func load(bundle: Bundle = .main) throws -> AppConfig {
        let rawBase =
            normalized(
                bundle.object(forInfoDictionaryKey: "ZERO_API_BASE_URL")
                    as? String
            ) ?? "https://api.vm0.ai"
        guard
            let apiBaseURL = URL(string: rawBase),
            let scheme = apiBaseURL.scheme,
            let host = apiBaseURL.host,
            !scheme.isEmpty,
            !host.isEmpty
        else {
            throw ConfigError.invalidAPIBaseURL(rawBase)
        }

        guard
            let publishableKey = normalized(
                bundle.object(forInfoDictionaryKey: "CLERK_PUBLISHABLE_KEY")
                    as? String
            )
        else {
            throw ConfigError.missingClerkPublishableKey
        }

        return AppConfig(
            apiBaseURL: apiBaseURL,
            clerkPublishableKey: publishableKey
        )
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.hasPrefix("$(") {
            return nil
        }
        return trimmed
    }
}
