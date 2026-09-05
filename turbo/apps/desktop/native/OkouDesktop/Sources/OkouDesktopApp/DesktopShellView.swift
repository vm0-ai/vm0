#if canImport(AppKit)
import OkouDesktopKit
import SwiftUI

/// First SwiftUI pass of the renderer: header, account step and permissions
/// step. The ready hero, command log and developer panels follow with the
/// Computer Use runtime port.
struct DesktopShellView: View {
    @ObservedObject var state: DesktopShellState
    let runtime: DesktopAppRuntime

    private var brand: Color {
        state.identity.product == .zero ? Color(red: 0xed / 255, green: 0x4e / 255, blue: 0x01 / 255)
            : Color(red: 1, green: 0xa5 / 255, blue: 0)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    accountStep
                    permissionsStep
                    if let handoffId = state.lastAuthCallbackHandoffId {
                        panel(title: "Sign-in callback received") {
                            Text("Handoff id: \(handoffId)")
                                .font(.system(size: 13))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: 1120, alignment: .leading)
                .padding(EdgeInsets(top: 18, leading: 20, bottom: 32, trailing: 20))
            }
        }
        .frame(minWidth: 1024, minHeight: 700)
        .background(Color(red: 0xfa / 255, green: 0xf5 / 255, blue: 0xf3 / 255))
        .foregroundStyle(Color(red: 0x26 / 255, green: 0x22 / 255, blue: 0x1d / 255))
    }

    private var header: some View {
        HStack {
            Text(state.identity.displayName)
                .font(.system(size: 14, weight: .semibold))
            Spacer()
            Text(environmentLabel)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .padding(.leading, 92)
        .padding(.trailing, 20)
        .frame(height: 52)
        .background(Color(red: 0xf8 / 255, green: 0xf9 / 255, blue: 0xfb / 255).opacity(0.82))
    }

    private var environmentLabel: String {
        state.environment == .production ? state.platformUrl : "\(state.environment.rawValue) · \(state.platformUrl)"
    }

    private var accountStep: some View {
        panel(kicker: "1", title: accountHeading) {
            Text(accountDescription)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button(action: { runtime.openSignIn() }) {
                    Text("Sign in")
                        .font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 32)
                }
                .buttonStyle(.plain)
                .background(brand, in: RoundedRectangle(cornerRadius: 9))
                .foregroundStyle(Color(red: 0x24 / 255, green: 0x21 / 255, blue: 0x21 / 255))
            }
        }
    }

    private var accountHeading: String {
        switch state.auth {
        case .signedIn(_, let organization) where organization == nil:
            return "Select a workspace"
        case .signingIn:
            return "Finish signing in"
        default:
            return "Sign in to \(state.identity.brandName.rawValue)"
        }
    }

    private var accountDescription: String {
        if case .signedIn(_, nil) = state.auth {
            return "Choose the workspace that should receive this Mac as a Computer Use runtime."
        }
        return "Connect this Mac to a \(state.identity.brandName.rawValue) account before Computer Use can register a runtime."
    }

    private var permissionsStep: some View {
        panel(kicker: "2", title: "Allow Computer Use permissions") {
            if state.auth?.isReady != true {
                Text("Sign in and select a workspace first.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            } else {
                permissionRow(
                    title: "Accessibility",
                    detail: "Required for clicking, typing, and reading UI structure",
                    granted: state.permissions.accessibility
                )
                permissionRow(
                    title: "Screen Recording",
                    detail: "Required for screenshots and visual context",
                    granted: state.permissions.screenRecording
                )
            }
        }
    }

    private func permissionRow(title: String, detail: String, granted: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(granted ? "Granted" : detail).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            Text(granted ? "✓ Ready" : "Request")
                .font(.system(size: 12, weight: .semibold))
        }
    }

    private func panel<Content: View>(
        kicker: String? = nil, title: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if let kicker {
                    Text(kicker)
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 22, height: 22)
                        .background(brand.opacity(0.14), in: Circle())
                }
                Text(title).font(.system(size: 17, weight: .semibold))
            }
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(red: 30 / 255, green: 38 / 255, blue: 52 / 255).opacity(0.1), lineWidth: 1)
        )
    }
}
#endif
