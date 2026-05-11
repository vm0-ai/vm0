import Foundation

struct AppEnvironment {
    let apiClient: ZeroAPIClient
    let audioSession: AudioSessionControlling
    let makeRealtimeTransport: () -> RealtimeTransport

    static func live(config: AppConfig) -> AppEnvironment {
        let authProvider = ClerkAuthProvider()
        return AppEnvironment(
            apiClient: ZeroAPIClient(
                baseURL: config.apiBaseURL,
                authTokenProvider: authProvider
            ),
            audioSession: AudioSessionController(),
            makeRealtimeTransport: {
                OpenAIRealtimeWebRTCClient()
            }
        )
    }
}
