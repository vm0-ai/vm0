import ClerkKit
import ClerkKitUI
import SwiftUI

struct RootView: View {
    @Environment(Clerk.self) private var clerk
    @State private var authIsPresented = false
    @StateObject private var controller: VoiceChatController

    init(environment: AppEnvironment) {
        _controller = StateObject(
            wrappedValue: VoiceChatController(
                apiClient: environment.apiClient,
                audioSession: environment.audioSession,
                makeRealtimeTransport: environment.makeRealtimeTransport
            )
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                if clerk.user == nil {
                    signedOutView
                } else {
                    VoiceChatView(controller: controller)
                }
            }
            .navigationTitle("Zero")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    UserButton(signedOutContent: {
                        Button("Sign in") {
                            authIsPresented = true
                        }
                    })
                }
            }
        }
        .prefetchClerkImages()
        .sheet(isPresented: $authIsPresented) {
            AuthView()
        }
    }

    private var signedOutView: some View {
        VStack(spacing: 16) {
            Button("Sign in") {
                authIsPresented = true
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
