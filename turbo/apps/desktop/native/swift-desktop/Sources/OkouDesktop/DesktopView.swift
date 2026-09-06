import AppKit
import DesktopCore
import SwiftUI

struct DesktopView: View {
  @ObservedObject var model: DesktopModel
  @State private var tab = 0
  @State private var mcpJSON = ""

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 36, height: 36)
        Text(model.configuration.name).font(.title2.weight(.semibold))
        Spacer()
        Text("v\(model.configuration.version)").foregroundStyle(.secondary).font(.caption)
      }.padding(22)
      if let error = model.error {
        HStack(alignment: .top) {
          Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
          Text(error).textSelection(.enabled)
          Spacer()
          Button {
            model.error = nil
          } label: {
            Image(systemName: "xmark")
          }.buttonStyle(.plain)
        }.padding().background(.orange.opacity(0.12))
      }
      TabView(selection: $tab) {
        overview.tabItem { Label("Computer Use", systemImage: "desktopcomputer") }.tag(0)
        if model.recorder.available {
          RecorderView(model: model, recorder: model.recorder).tabItem {
            Label("Record", systemImage: "record.circle")
          }.tag(1)
        }
        if model.pluginsAvailable {
          plugins.tabItem { Label("Plugins", systemImage: "puzzlepiece.extension") }.tag(2)
        }
        if model.debugAvailable && model.debugEnabled {
          diagnostics.tabItem { Label("Activity", systemImage: "terminal") }.tag(3)
        }
      }.padding([.horizontal, .bottom], 16)
    }
    .frame(minWidth: 620, idealWidth: 680, minHeight: 640, idealHeight: 760)
    .background(Color(nsColor: .windowBackgroundColor))
    .tint(.orange)
  }

  private var overview: some View {
    ScrollView {
      VStack(spacing: 24) {
        Image(
          systemName: model.host.status == "online"
            ? "desktopcomputer.and.arrow.down" : "desktopcomputer"
        )
        .font(.system(size: 64, weight: .light)).foregroundStyle(.orange).padding(.top, 28)
        VStack(spacing: 8) {
          Text(model.auth.signingIn ? "Signing in…" : statusLabel).font(.title.weight(.semibold))
          Text(
            DesktopHostName.read(fallback: model.configuration.name).replacingOccurrences(
              of: #"\.local$"#, with: "", options: [.regularExpression, .caseInsensitive])
          ).foregroundStyle(.secondary)
          if let error = model.host.lastError {
            Text(error).foregroundStyle(.orange).textSelection(.enabled)
          }
        }
        if !model.auth.signedIn {
          Text("Sign in to connect this Mac to your workspace.").foregroundStyle(.secondary)
          Button("Sign In") { model.run { try model.auth.signIn() } }.buttonStyle(
            .borderedProminent
          ).controlSize(.large).disabled(model.changingAccount)
        } else {
          GroupBox {
            VStack(alignment: .leading, spacing: 12) {
              LabeledContent("Account", value: model.auth.user["email"].string ?? "")
              HStack {
                Text("Workspace")
                Spacer()
                Text(model.auth.organization["name"].string ?? "Select a workspace")
                  .foregroundStyle(.secondary)
                Button("Switch") { model.run { try await model.switchOrganization() } }
                  .disabled(model.changingAccount)
              }
              HStack {
                Button("Open Okou") { NSWorkspace.shared.open(model.configuration.platformPage()) }
                Spacer()
                Button("Sign Out") { model.run { try await model.signOut() } }
                  .disabled(model.changingAccount)
              }
            }.padding(8)
          }
          HStack {
            if ["online", "connecting", "recovering"].contains(model.host.status) {
              Button("Stop Computer Use", role: .destructive) {
                model.run { await model.host.stop() }
              }
            } else {
              Button("Start Computer Use") { model.host.start() }.disabled(!model.ready)
                .buttonStyle(.borderedProminent)
            }
            Button("Refresh Status") { model.run { try await model.refresh() } }
              .disabled(model.changingAccount)
          }.controlSize(.large)
        }
        GroupBox("Permissions") {
          VStack(spacing: 12) {
            permissionRow("Accessibility", key: "accessibility", settings: "Privacy_Accessibility")
            Divider()
            permissionRow(
              "Screen Recording", key: "screenRecording", settings: "Privacy_ScreenCapture")
            Divider()
            HStack {
              Text("Browser Automation")
              Spacer()
              Button("Chrome") { model.run { try await model.requestPermission("chrome") } }
              Button("Safari") { model.run { try await model.requestPermission("safari") } }
              Button("Settings") { openPrivacy("Privacy_Automation") }
            }
          }.padding(8)
        }
        Toggle(
          "Keep this Mac awake",
          isOn: Binding(
            get: { model.keepAwake }, set: { value in model.run { try model.setKeepAwake(value) } })
        )
        .toggleStyle(.switch)
        Text("Closing this window keeps Computer Use available in the menu bar.").font(.caption)
          .foregroundStyle(.secondary)
      }.padding(20)
    }
  }

  private var statusLabel: String {
    if !model.auth.signedIn { return "Connect your Mac" }
    if model.auth.organization["id"].string == nil { return "Choose a workspace" }
    switch model.host.status {
    case "online": return "Your Mac is online"
    case "connecting": return "Connecting…"
    case "recovering": return "Reconnecting…"
    case "disabled": return "Computer Use is unavailable"
    default: return model.ready ? "Ready to connect" : "Finish setup"
    }
  }

  private func permissionRow(_ label: String, key: String, settings: String) -> some View {
    HStack {
      Image(systemName: model.permissions[key].bool ? "checkmark.circle.fill" : "circle")
        .foregroundStyle(model.permissions[key].bool ? .green : .secondary)
      Text(label)
      Spacer()
      if !model.permissions[key].bool {
        Button("Grant Access") { model.run { try await model.requestPermission(key) } }
      }
      Button("Settings") { openPrivacy(settings) }
    }
  }

  private var plugins: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        GroupBox("Filesystem") {
          VStack(alignment: .leading, spacing: 12) {
            Toggle(
              "Enable access to selected folders",
              isOn: Binding(
                get: { model.filesystemEnabled },
                set: { enabled in model.run { try model.setFilesystem(enabled) } }))
            ForEach(model.allowedDirectories, id: \.self) { path in
              HStack {
                Image(systemName: "folder")
                Text(path).lineLimit(2).textSelection(.enabled)
                Spacer()
                Button(role: .destructive) {
                  model.run { try model.removeDirectory(path) }
                } label: {
                  Image(systemName: "trash")
                }
              }
            }
            Button("Add Folder…") { model.run { try model.addDirectory() } }
          }.padding(8)
        }
        GroupBox("MCP Servers") {
          VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(model.mcp.states.enumerated()), id: \.offset) { _, state in
              if let name = state["name"].string {
                VStack(alignment: .leading, spacing: 6) {
                  HStack {
                    Toggle(
                      name,
                      isOn: Binding(
                        get: { state["enabled"].bool },
                        set: { enabled in model.run { try model.mcp.setEnabled(name, enabled) } }))
                    Spacer()
                    Text(state["status"].string ?? "").foregroundStyle(.secondary)
                    Button(role: .destructive) {
                      model.run { try model.mcp.remove(name) }
                    } label: {
                      Image(systemName: "trash")
                    }
                  }
                  if let error = state["lastError"].string {
                    Text(error).foregroundStyle(.orange).font(.caption)
                  }
                  if !state["tools"].array.isEmpty {
                    Text(state["tools"].array.compactMap(\.string).joined(separator: ", ")).font(
                      .caption
                    ).foregroundStyle(.secondary)
                  }
                }
              }
            }
            Text(
              "Paste a server configuration using mcpServers, command/args/env, or a Streamable HTTP url."
            ).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $mcpJSON).font(.system(.body, design: .monospaced)).frame(height: 160)
              .border(.quaternary)
            Button("Import Servers") {
              model.run {
                try model.mcp.importJSON(mcpJSON)
                mcpJSON = ""
              }
            }.disabled(mcpJSON.isEmpty)
            Text("Imported servers remain disabled until you enable them.").font(.caption)
              .foregroundStyle(.secondary)
          }.padding(8)
        }
      }.padding(20)
    }
  }

  private var diagnostics: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        LabeledContent("Host", value: model.host.hostID ?? "Offline")
        LabeledContent("Status", value: model.host.status.capitalized)
        if let heartbeat = model.host.lastHeartbeat {
          LabeledContent("Last heartbeat", value: heartbeat.formatted())
        }
        if let command = model.host.lastCommand {
          LabeledContent("Last command", value: command.formatted())
        }
        if let recovery = model.host.recovery {
          GroupBox("Connection recovery") {
            VStack(alignment: .leading, spacing: 8) {
              LabeledContent("Phase", value: recovery.phase.rawValue)
              LabeledContent("Attempt", value: String(recovery.attempt))
              LabeledContent("Last retry", value: recovery.lastRetryAt.formatted())
              LabeledContent("Next retry", value: recovery.nextRetryAt.formatted())
              LabeledContent("Delay", value: "\(Int(recovery.retryDelay)) seconds")
            }.padding(8)
          }
        }
        ForEach(model.host.errors) { error in
          VStack(alignment: .leading, spacing: 4) {
            Text("\(error.phase.rawValue) · \(error.occurredAt.formatted())").font(.caption)
            Text(error.message).foregroundStyle(.orange)
            Text(error.hostID ?? "No registered host").font(.caption).foregroundStyle(.secondary)
          }.textSelection(.enabled)
        }
        ForEach(Array(model.host.commands.enumerated()), id: \.offset) { _, command in
          DisclosureGroup(
            "\(command["kind"].string ?? "Command") · \(command["status"].string ?? "")"
          ) {
            VStack(alignment: .leading, spacing: 8) {
              if let app = command["app"].string { LabeledContent("App", value: app) }
              LabeledContent("Started", value: command["startedAt"].string ?? "")
              if let completed = command["completedAt"].string {
                LabeledContent("Completed", value: completed)
              }
              if let duration = command["durationMs"].number {
                LabeledContent("Duration", value: "\(Int(duration)) ms")
              }
              Text((try? command.text(pretty: true)) ?? "").font(
                .system(.caption, design: .monospaced)
              ).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
      }.padding(20)
    }
  }
}

@MainActor
func openPrivacy(_ anchor: String) {
  NSWorkspace.shared.open(
    URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!)
}

struct RecorderView: View {
  @ObservedObject var model: DesktopModel
  @ObservedObject var recorder: ScreenRecorder
  @State private var sourceID = ""
  @State private var systemAudio = true
  @State private var microphone = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("Screen Recording").font(.title2.weight(.semibold))
        Text("Record a display, window, or selected area, then review it in Okou.").foregroundStyle(
          .secondary)
        if let error = recorder.error {
          Text(error).foregroundStyle(.orange).textSelection(.enabled)
        }
        if recorder.capturing || ["finalizing", "delivering"].contains(recorder.status) {
          Text(
            "\(recorder.status.capitalized) · \(Int(recorder.elapsed) / 60):\(String(format: "%02d", Int(recorder.elapsed) % 60))"
          ).font(.largeTitle.monospacedDigit())
          HStack {
            Button(recorder.status == "paused" ? "Resume" : "Pause") {
              model.run { try await recorder.pauseOrResume() }
            }.disabled(!recorder.capturing)
            Button("Stop and Review") { model.run { try await recorder.stop() } }.disabled(
              !recorder.capturing)
            Button("Discard", role: .destructive) { model.run { try await recorder.discard() } }
              .disabled(!recorder.capturing)
          }
          Text("Stop from any app with ⌃⇧R, or use the menu bar.").foregroundStyle(.secondary)
        } else {
          Button("Choose What to Record") {
            model.run {
              try await recorder.loadSources()
              sourceID = recorder.sources.first?["id"].string ?? ""
            }
          }
          if !recorder.sources.isEmpty {
            Picker("Source", selection: $sourceID) {
              ForEach(Array(recorder.sources.enumerated()), id: \.offset) { _, source in
                Text(source["title"].string ?? "Untitled").tag(source["id"].string ?? "")
              }
            }
            if let image = recorder.previews[sourceID] {
              Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 230).clipShape(
                RoundedRectangle(cornerRadius: 8))
            }
            Toggle("Record system audio", isOn: $systemAudio)
            Toggle("Record microphone", isOn: $microphone).disabled(!recorder.microphoneSupported)
            if !recorder.microphoneSupported {
              Text("Microphone capture requires macOS 15 or later.").font(.caption).foregroundStyle(
                .secondary)
            }
            HStack {
              Button("Start Recording") {
                guard let source = recorder.sources.first(where: { $0["id"].string == sourceID })
                else { return }
                NSApp.keyWindow?.orderOut(nil)
                model.run {
                  try await recorder.start(
                    source: source, systemAudio: systemAudio, microphone: microphone)
                }
              }.buttonStyle(.borderedProminent).disabled(sourceID.isEmpty)
              Button("Select an Area…") {
                NSApp.keyWindow?.orderOut(nil)
                model.areaSelector.select { source, area in
                  model.run {
                    try await recorder.start(
                      source: source, systemAudio: systemAudio, microphone: microphone, area: area)
                  }
                }
              }
            }
          }
          if recorder.status == "ready" {
            HStack {
              Button("Retry Upload") { model.run { try await recorder.deliver() } }
              Button("Show Recording in Finder") { recorder.revealRecording() }
            }
          }
        }
      }.padding(24)
    }
  }
}
