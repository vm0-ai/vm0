import DesktopCore
import SwiftUI

struct PreviewEnvironmentView: View {
  let settings: DesktopPreviewSettings
  let active: DesktopConfiguration
  @State private var enabled = false
  @State private var address = ""
  @State private var apiAddress = ""
  @State private var authAddress = ""
  @State private var bypass = ""
  @State private var saved = false
  @State private var error: String?

  var body: some View {
    Form {
      Section {
        Toggle("Use a preview environment", isOn: $enabled)
        Text(
          "Quit and reopen the app to apply changes. Each preview has a separate sign-in and settings."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      if enabled {
        Section("Preview") {
          TextField("App URL", text: $address)
            .autocorrectionDisabled()
            .onChange(of: address) { _, value in extractBypass(value) }
          SecureField("Vercel bypass token", text: $bypass)
          Text(
            "You can paste a preview URL containing x-vercel-protection-bypass. Its token is stored in the field above."
          )
          .font(.caption).foregroundStyle(.secondary)
          DisclosureGroup("Service addresses") {
            TextField("API URL (optional)", text: $apiAddress).autocorrectionDisabled()
            TextField("Sign-in URL (optional)", text: $authAddress).autocorrectionDisabled()
            Text(
              "The API defaults to the matching PR API. Sign-in defaults to the App URL. Override these with the addresses reported by the deployment when needed."
            )
            .font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      Section("Current environment") {
        LabeledContent("App", value: active.platformURL.host ?? "")
        LabeledContent("API", value: active.apiURL.host ?? "")
        LabeledContent("Sign-in", value: active.webURL.host ?? "")
      }
      Section {
        Button("Save for Next Launch") { save() }.buttonStyle(.borderedProminent)
        if saved {
          Text("Saved. Quit and reopen to use this environment.").foregroundStyle(.secondary)
        }
        if let error { Text(error).foregroundStyle(.orange) }
      }
    }
    .formStyle(.grouped)
    .onAppear {
      enabled = settings.value != nil
      if let value = settings.value {
        address = value.platformURL
        apiAddress = value.apiURL ?? ""
        authAddress = value.authURL ?? ""
        bypass = value.bypass ?? ""
        extractBypass(address)
      }
    }
    .onChange(of: enabled) { saved = false }
    .onChange(of: address) { saved = false }
    .onChange(of: apiAddress) { saved = false }
    .onChange(of: authAddress) { saved = false }
    .onChange(of: bypass) { saved = false }
  }

  private func extractBypass(_ value: String) {
    guard var parts = URLComponents(string: value),
      let token = parts.queryItems?.first(where: { $0.name == "x-vercel-protection-bypass" })?.value
    else { return }
    // Leave duplicate tokens for the configuration validator to reject.
    guard parts.queryItems?.filter({ $0.name == "x-vercel-protection-bypass" }).count == 1 else {
      return
    }
    bypass = token
    parts.queryItems = parts.queryItems?.filter {
      !["x-vercel-protection-bypass", "x-vercel-set-bypass-cookie"].contains($0.name)
    }
    if parts.queryItems?.isEmpty == true { parts.queryItems = nil }
    if let url = parts.url { address = url.absoluteString }
  }

  private func save() {
    do {
      let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
      let api = apiAddress.trimmingCharacters(in: .whitespacesAndNewlines)
      let auth = authAddress.trimmingCharacters(in: .whitespacesAndNewlines)
      let previous = settings.value
      let unchanged =
        previous?.platformURL == trimmed && previous?.apiURL == (api.isEmpty ? nil : api)
        && previous?.authURL == (auth.isEmpty ? nil : auth)
        && previous?.bypass == (bypass.isEmpty ? nil : bypass)
      let environment =
        enabled
        ? DesktopPreviewEnvironment(
          id: unchanged ? previous!.id : UUID(), platformURL: trimmed,
          apiURL: api.isEmpty ? nil : api, authURL: auth.isEmpty ? nil : auth,
          bypass: bypass.isEmpty ? nil : bypass) : nil
      try settings.save(environment)
      error = nil
      saved = true
    } catch {
      self.error = error.localizedDescription
      saved = false
    }
  }
}
