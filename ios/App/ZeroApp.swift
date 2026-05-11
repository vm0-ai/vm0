import ClerkKit
import SwiftUI

@main
struct ZeroApp: App {
    private let environment: AppEnvironment

    init() {
        do {
            let config = try AppConfig.load()
            Clerk.configure(publishableKey: config.clerkPublishableKey)
            environment = AppEnvironment.live(config: config)
        } catch {
            fatalError(error.localizedDescription)
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(environment: environment)
                .environment(Clerk.shared)
        }
    }
}
