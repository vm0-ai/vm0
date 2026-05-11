import Foundation

enum VoiceChatConnectionState: Equatable {
    case idle
    case connecting
    case connected
    case disconnected
    case failed(String)

    var label: String {
        switch self {
        case .idle:
            return "Idle"
        case .connecting:
            return "Connecting"
        case .connected:
            return "Connected"
        case .disconnected:
            return "Disconnected"
        case .failed:
            return "Failed"
        }
    }
}

@MainActor
final class VoiceChatController: NSObject, ObservableObject {
    @Published private(set) var state: VoiceChatConnectionState = .idle
    @Published private(set) var sessionId: UUID?
    @Published private(set) var lastUserTranscript = ""
    @Published private(set) var lastAssistantTranscript = ""
    @Published private(set) var tasks: [VoiceChatTask] = []
    @Published var isMuted = false {
        didSet {
            transport?.setMicrophoneMuted(isMuted)
        }
    }

    private let apiClient: ZeroAPIClient
    private let audioSession: AudioSessionControlling
    private let makeRealtimeTransport: () -> RealtimeTransport
    private let parser = RealtimeEventParser()
    private let supportedToolNames = Set([
        "inform_slow_brain",
        "feel_confused",
        "feel_unable",
        "want_to_ask_user",
        "want_to_reject",
        "want_to_apologize",
    ])

    private var audioConfig = VoiceChatAudioConfig(
        noiseReduction: .farField,
        bargeInMode: .speechStarted
    )
    private var transport: RealtimeTransport?
    private var connectTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var relaySessionId: UUID?
    private var lastTalkerInstructions = ""
    private var currentAssistantAudio: AssistantAudioState?

    init(
        apiClient: ZeroAPIClient,
        audioSession: AudioSessionControlling,
        makeRealtimeTransport: @escaping () -> RealtimeTransport
    ) {
        self.apiClient = apiClient
        self.audioSession = audioSession
        self.makeRealtimeTransport = makeRealtimeTransport
    }

    func start(agentId: UUID) {
        endLocalResources()
        state = .connecting
        lastUserTranscript = ""
        lastAssistantTranscript = ""
        tasks = []
        sessionId = nil
        relaySessionId = nil
        isMuted = false

        connectTask = Task { [weak self] in
            guard let self else {
                return
            }
            await self.connect(agentId: agentId)
        }
    }

    func end() {
        let currentSessionId = sessionId
        let currentRelaySessionId = relaySessionId
        endLocalResources()
        state = .idle
        sessionId = nil
        relaySessionId = nil
        currentAssistantAudio = nil

        Task { [apiClient, audioSession] in
            if let currentSessionId, let currentRelaySessionId {
                try? await apiClient.sessionEnded(
                    sessionId: currentSessionId,
                    relaySessionId: currentRelaySessionId
                )
            }
            await audioSession.deactivate()
        }
    }

    private func connect(agentId: UUID) async {
        do {
            audioConfig = try await audioSession.prepareForVoiceChat()

            let sessionResponse = try await apiClient.createSession(
                agentId: agentId
            )
            sessionId = sessionResponse.session.id
            lastTalkerInstructions = sessionResponse.talkerInstructions

            let tokenResponse = try await apiClient.mintRealtimeToken(
                sessionId: sessionResponse.session.id,
                noiseReduction: audioConfig.noiseReduction
            )

            let started = try? await apiClient.sessionStarted(
                sessionId: sessionResponse.session.id
            )
            relaySessionId = started?.id

            let transport = makeRealtimeTransport()
            transport.delegate = self
            self.transport = transport
            transport.setMicrophoneMuted(isMuted)
            try await transport.connect(
                clientSecret: tokenResponse.clientSecret.value
            )

            startPolling()
        } catch is CancellationError {
            state = .idle
        } catch {
            state = .failed(error.localizedDescription)
            try? await apiClient.sessionEndedIfPossible(
                sessionId: sessionId,
                relaySessionId: relaySessionId
            )
            await audioSession.deactivate()
            endLocalResources()
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else {
                return
            }
            await self.refreshServerState()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                await self.refreshServerState()
            }
        }
    }

    private func refreshServerState() async {
        guard let sessionId, state == .connected else {
            return
        }

        async let session = apiClient.getSession(id: sessionId)
        async let taskList = apiClient.listTasks(sessionId: sessionId)

        if let response = try? await session {
            await pushInstructionsIfNeeded(response.talkerInstructions)
        }
        if let taskList = try? await taskList {
            tasks = taskList
        }
    }

    private func pushInstructionsIfNeeded(_ instructions: String) async {
        guard
            instructions != lastTalkerInstructions,
            let transport
        else {
            return
        }
        lastTalkerInstructions = instructions
        let event = RealtimeClientEvents.SessionUpdate(
            session: .init(instructions: instructions)
        )
        if let json = try? RealtimeClientEvents.encode(event) {
            try? transport.send(jsonString: json)
        }
    }

    private func handleRealtimeMessage(_ text: String) async {
        guard let action = try? parser.parse(text) else {
            return
        }

        switch action {
        case .assistantMessageStarted(let itemId):
            currentAssistantAudio = AssistantAudioState(
                itemId: itemId,
                startedAt: Date(),
                transcript: ""
            )

        case .assistantTranscriptDelta(let delta):
            currentAssistantAudio?.transcript += delta

        case .assistantTranscriptDone(let itemId, let transcript):
            let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, let sessionId else {
                return
            }
            lastAssistantTranscript = transcript
            try? await apiClient.appendItem(
                sessionId: sessionId,
                role: .assistant,
                content: transcript,
                realtimeItemId: itemId
            )

        case .userTranscriptCompleted(let itemId, let transcript, let usage):
            if audioConfig.bargeInMode == .transcriptConfirmed,
                !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                await truncateCurrentAssistantAudio()
            }
            guard let sessionId else {
                return
            }
            if !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                lastUserTranscript = transcript
                try? await apiClient.appendItem(
                    sessionId: sessionId,
                    role: .user,
                    content: transcript,
                    realtimeItemId: itemId
                )
            }
            if let usage {
                await postUsage(usage)
            }

        case .speechStarted:
            if audioConfig.bargeInMode == .speechStarted {
                await truncateCurrentAssistantAudio()
            }

        case .functionCall(let name, let callId, let arguments):
            await handleToolCall(name: name, callId: callId, arguments: arguments)

        case .responseDone(let usage):
            await postUsage(usage)
        }
    }

    private func handleToolCall(
        name: String,
        callId: String,
        arguments: String
    ) async {
        guard supportedToolNames.contains(name), let sessionId else {
            return
        }

        let prompt: String
        do {
            let payload = try JSONDecoder().decode(
                TalkerToolArguments.self,
                from: Data(arguments.utf8)
            )
            prompt = payload.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            sendFunctionOutput(
                callId: callId,
                output: "Inform failed: invalid args."
            )
            return
        }

        guard !prompt.isEmpty else {
            sendFunctionOutput(callId: callId, output: "Inform failed: empty prompt.")
            return
        }

        do {
            let task = try await apiClient.createTask(
                sessionId: sessionId,
                prompt: prompt,
                callId: callId
            )
            upsertTask(task)
            sendFunctionOutput(
                callId: callId,
                output:
                    "Slow brain informed: '\(shortPrompt(prompt))'. It will decide what to do and report back."
            )
        } catch {
            sendFunctionOutput(
                callId: callId,
                output: "Failed to reach the slow brain. Please try again or rephrase."
            )
        }
    }

    private func sendFunctionOutput(callId: String, output: String) {
        let event = RealtimeClientEvents.FunctionOutput(
            item: .init(callId: callId, output: output)
        )
        guard let json = try? RealtimeClientEvents.encode(event) else {
            return
        }
        try? transport?.send(jsonString: json)
    }

    private func truncateCurrentAssistantAudio() async {
        guard let currentAssistantAudio, let transport else {
            return
        }
        let playedMs = max(
            0,
            Int(Date().timeIntervalSince(currentAssistantAudio.startedAt) * 1000)
        )
        let truncate = RealtimeClientEvents.TruncateAssistantAudio(
            itemId: currentAssistantAudio.itemId,
            contentIndex: 0,
            audioEndMs: playedMs
        )
        if let json = try? RealtimeClientEvents.encode(truncate) {
            try? transport.send(jsonString: json)
        }

        if let sessionId {
            let note = AssistantInterruptedNote(
                assistantRealtimeItemId: currentAssistantAudio.itemId,
                heardText: currentAssistantAudio.transcript
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                audioEndMs: playedMs
            )
            if let noteData = try? JSONEncoder().encode(note),
                let noteJSON = String(data: noteData, encoding: .utf8)
            {
                try? await apiClient.appendItem(
                    sessionId: sessionId,
                    role: .systemNote,
                    content: noteJSON,
                    realtimeItemId: "truncate:\(currentAssistantAudio.itemId)"
                )
            }
        }

        self.currentAssistantAudio = nil
    }

    private func postUsage(_ usage: VoiceChatUsageEvent) async {
        guard let sessionId else {
            return
        }
        let response = try? await apiClient.postUsageEvent(
            sessionId: sessionId,
            event: usage
        )
        if response?.creditsExhausted == true {
            let message = "Voice-chat credits exhausted; the session has ended."
            end()
            state = .failed(message)
        }
    }

    private func upsertTask(_ task: VoiceChatTask) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.insert(task, at: 0)
        }
    }

    private func endLocalResources() {
        connectTask?.cancel()
        connectTask = nil
        pollTask?.cancel()
        pollTask = nil
        transport?.close()
        transport = nil
    }

    private func shortPrompt(_ prompt: String, max: Int = 60) -> String {
        if prompt.count <= max {
            return prompt
        }
        return "\(prompt.prefix(max - 1))..."
    }
}

extension VoiceChatController: RealtimeTransportDelegate {
    nonisolated func realtimeTransportDidOpen(_ transport: RealtimeTransport) {
        Task { @MainActor in
            state = .connected
        }
    }

    nonisolated func realtimeTransportDidClose(_ transport: RealtimeTransport) {
        Task { @MainActor in
            if state == .connected {
                state = .disconnected
            }
        }
    }

    nonisolated func realtimeTransport(
        _ transport: RealtimeTransport,
        didReceive text: String
    ) {
        Task { @MainActor in
            await handleRealtimeMessage(text)
        }
    }

    nonisolated func realtimeTransport(
        _ transport: RealtimeTransport,
        didFail error: Error
    ) {
        Task { @MainActor in
            state = .failed(error.localizedDescription)
        }
    }
}

private extension ZeroAPIClient {
    func sessionEndedIfPossible(
        sessionId: UUID?,
        relaySessionId: UUID?
    ) async throws {
        guard let sessionId, let relaySessionId else {
            return
        }
        try await sessionEnded(sessionId: sessionId, relaySessionId: relaySessionId)
    }
}

private struct AssistantAudioState {
    let itemId: String
    let startedAt: Date
    var transcript: String
}

private struct TalkerToolArguments: Decodable {
    let prompt: String
}

private struct AssistantInterruptedNote: Encodable {
    let type = "assistant_interrupted"
    let assistantRealtimeItemId: String
    let heardText: String
    let audioEndMs: Int
}
