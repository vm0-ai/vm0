import SwiftUI

struct VoiceChatView: View {
    @ObservedObject var controller: VoiceChatController
    @State private var agentIdText = ""

    private var parsedAgentId: UUID? {
        UUID(uuidString: agentIdText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var isActive: Bool {
        switch controller.state {
        case .connecting, .connected:
            return true
        case .idle, .disconnected, .failed:
            return false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Agent ID", text: $agentIdText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(isActive)

                    HStack {
                        Button {
                            if let parsedAgentId {
                                controller.start(agentId: parsedAgentId)
                            }
                        } label: {
                            Label("Start", systemImage: "mic.fill")
                        }
                        .disabled(parsedAgentId == nil || isActive)

                        Button {
                            controller.end()
                        } label: {
                            Label("End", systemImage: "phone.down.fill")
                        }
                        .disabled(!isActive)

                        Toggle(isOn: $controller.isMuted) {
                            Label("Mute", systemImage: "mic.slash.fill")
                        }
                        .disabled(!isActive)
                    }
                }

                Section("Status") {
                    HStack {
                        Text(controller.state.label)
                        Spacer()
                        if case .connecting = controller.state {
                            ProgressView()
                        }
                    }

                    if let sessionId = controller.sessionId {
                        Text(sessionId.uuidString)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    }

                    if case .failed(let message) = controller.state {
                        Text(message)
                            .foregroundStyle(.red)
                    }
                }

                Section("Conversation") {
                    TranscriptRow(
                        title: "You",
                        text: controller.lastUserTranscript
                    )
                    TranscriptRow(
                        title: "Zero",
                        text: controller.lastAssistantTranscript
                    )
                }

                Section("Tasks") {
                    if controller.tasks.isEmpty {
                        Text("No active tasks")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(controller.tasks) { task in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(task.status.rawValue.capitalized)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Text(String(task.id.uuidString.prefix(8)))
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                                Text(task.prompt)
                                    .font(.body)
                                if let result = task.result,
                                    !result.isEmpty
                                {
                                    Text(result)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
        }
    }
}

private struct TranscriptRow: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(text.isEmpty ? "..." : text)
                .textSelection(.enabled)
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
