#if canImport(AppKit)
import AppKit
import OkouDesktopKit
import SwiftUI

/// What the overlay views can ask the runtime to do; the counterpart of the
/// `vm0DesktopRecorder` bridge.
@MainActor
protocol RecorderWindowBridge: AnyObject {
    var uiState: RecorderUIState { get }
    func getCapabilities() async throws -> DesktopRecorderCapabilities
    func startCapture(_ request: DesktopRecorderCaptureRequest) async throws
    func beginAreaSelection(_ audio: DesktopRecorderAudioChoice)
    func completeAreaSelection(_ selection: DesktopRecorderAreaSelection?)
    func selectWindow() async -> DesktopRecorderWindowChoice?
    func listWindowOptions() async throws -> [DesktopRecorderWindowOption]
    func completeWindowSelection(_ choice: DesktopRecorderWindowChoice?)
    func pause() async throws
    func resume() async throws
    func discard() async throws
    func stop() async throws
    func cancel()
    func openScreenRecordingSettings()
}

@MainActor
final class RecorderUIState: ObservableObject {
    @Published var state = DesktopRecorderState.unavailable
}

private enum RecorderPalette {
    static let surface = Color(red: 0x1c / 255, green: 0x1c / 255, blue: 0x1e / 255).opacity(0.94)
    static let text = Color(red: 0xf5 / 255, green: 0xf5 / 255, blue: 0xf7 / 255)
    static let muted = Color(red: 0xf5 / 255, green: 0xf5 / 255, blue: 0xf7 / 255).opacity(0.45)
    static let accent = Color(red: 0xe8 / 255, green: 0x59 / 255, blue: 0x0c / 255)
    static let border = Color.white.opacity(0.12)
}

// MARK: - Bar

enum RecorderSourceChoice: Equatable {
    case display
    case window(sourceId: String, title: String)
}

@MainActor
final class RecorderBarModel: ObservableObject {
    @Published var choice: RecorderSourceChoice = .display
    @Published var systemAudio = true
    @Published var microphone = false
    @Published var microphoneSupported = false
    @Published var busy = false
    @Published var error: String? = nil
    let bridge: RecorderWindowBridge

    init(bridge: RecorderWindowBridge) {
        self.bridge = bridge
        Task { await loadCapabilities() }
    }

    /// Only capabilities are read on open; listing sources would raise the
    /// Screen Recording prompt before the user chose anything.
    private func loadCapabilities() async {
        do {
            microphoneSupported = try await bridge.getCapabilities().supportsMicrophone
        } catch {
            microphoneSupported = false
        }
    }

    func chooseDisplay() {
        choice = .display
    }

    func chooseWindow() {
        Task {
            if let chosen = await bridge.selectWindow() {
                choice = .window(sourceId: chosen.sourceId, title: chosen.title)
            }
        }
    }

    func chooseArea() {
        bridge.beginAreaSelection(DesktopRecorderAudioChoice(systemAudio: systemAudio, microphone: microphone))
    }

    func start() {
        guard !busy else { return }
        busy = true
        error = nil
        let target: DesktopRecorderCaptureTarget
        switch choice {
        case .display: target = .display
        case let .window(sourceId, _): target = .window(sourceId: sourceId)
        }
        Task {
            do {
                try await bridge.startCapture(DesktopRecorderCaptureRequest(target: target, audio: DesktopRecorderAudioChoice(systemAudio: systemAudio, microphone: microphone)))
            } catch {
                self.error = String(describing: error)
            }
            busy = false
        }
    }
}

struct RecorderBarView: View {
    @ObservedObject var model: RecorderBarModel

    private var windowTitle: String? {
        if case let .window(_, title) = model.choice { return title }
        return nil
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                sourceButton("Display", systemImage: "display", selected: model.choice == .display) { model.chooseDisplay() }
                sourceButton("Window", systemImage: "macwindow", selected: windowTitle != nil, caption: windowTitle) { model.chooseWindow() }
                sourceButton("Area", systemImage: "rectangle.dashed", selected: false) { model.chooseArea() }
                Divider().frame(height: 28).overlay(RecorderPalette.border)
                toggleButton(model.systemAudio ? "System audio" : "No system audio", systemImage: model.systemAudio ? "speaker.wave.2" : "speaker.slash", on: model.systemAudio) {
                    model.systemAudio.toggle()
                }
                toggleButton(model.microphone ? "Microphone" : "No microphone", systemImage: model.microphone ? "mic" : "mic.slash", on: model.microphone, disabled: !model.microphoneSupported, help: model.microphoneSupported ? nil : "Needs macOS 15 or later") {
                    model.microphone.toggle()
                }
                Spacer()
                Button(action: { model.start() }) {
                    Text(model.busy ? "Starting…" : "Start recording")
                        .font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 16)
                        .frame(height: 34)
                }
                .buttonStyle(.plain)
                .background(RecorderPalette.accent, in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(.white)
                .disabled(model.busy)
                Button(action: { model.bridge.cancel() }) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .foregroundStyle(RecorderPalette.muted)
                .accessibilityLabel("Close")
            }
            if let error = model.error {
                HStack {
                    Text(error).font(.system(size: 11)).foregroundStyle(RecorderPalette.accent).lineLimit(1)
                    Spacer()
                    Button("Open settings") { model.bridge.openScreenRecordingSettings() }
                        .buttonStyle(.plain).font(.system(size: 11, weight: .semibold)).foregroundStyle(RecorderPalette.text)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(width: RecorderOverlayGeometry.barSize.width, height: RecorderOverlayGeometry.barSize.height)
        .background(RecorderPalette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(RecorderPalette.border, lineWidth: 1))
        .foregroundStyle(RecorderPalette.text)
    }

    private func sourceButton(_ title: String, systemImage: String, selected: Bool, caption: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: systemImage).font(.system(size: 13))
                    Text(title).font(.system(size: 12, weight: .semibold))
                }
                if let caption {
                    Text(caption).font(.system(size: 10)).foregroundStyle(RecorderPalette.muted).lineLimit(1).frame(maxWidth: 110)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(selected ? Color.white.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
    }

    private func toggleButton(_ label: String, systemImage: String, on: Bool, disabled: Bool = false, help: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.system(size: 14)).frame(width: 34, height: 34)
                .background(on ? Color.white.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .help(help ?? label)
        .accessibilityLabel(label)
    }
}

// MARK: - Area selector

@MainActor
final class RecorderAreaSelectorModel: ObservableObject {
    @Published var start: OverlayPoint? = nil
    @Published var current: OverlayPoint? = nil
    let displayId: UInt32
    let bridge: RecorderWindowBridge

    init(displayId: UInt32, bridge: RecorderWindowBridge) {
        self.displayId = displayId
        self.bridge = bridge
    }

    var selection: DesktopRecorderArea? {
        guard let start, let current else { return nil }
        return RecorderOverlayGeometry.areaFromDrag(start: start, end: current)
    }

    var canCommit: Bool {
        guard let selection else { return false }
        return selection.width >= 2 && selection.height >= 2
    }

    func commit() {
        guard let selection, canCommit else { return }
        bridge.completeAreaSelection(DesktopRecorderAreaSelection(displayId: displayId, area: selection))
    }
}

struct RecorderAreaSelectorView: View {
    @ObservedObject var model: RecorderAreaSelectorModel
    static let startButtonHeight: CGFloat = 52

    var body: some View {
        GeometryReader { _ in
            ZStack(alignment: .topLeading) {
                Color.black.opacity(0.28)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0, coordinateSpace: .local)
                            .onChanged { value in
                                if model.start == nil {
                                    model.start = OverlayPoint(x: value.startLocation.x, y: value.startLocation.y)
                                }
                                model.current = OverlayPoint(x: value.location.x, y: value.location.y)
                            }
                    )
                if let selection = model.selection, selection.width > 0, selection.height > 0 {
                    Rectangle()
                        .fill(Color.clear)
                        .overlay(Rectangle().stroke(RecorderPalette.accent, lineWidth: 2))
                        .frame(width: selection.width, height: selection.height)
                        .offset(x: selection.x, y: selection.y)
                        .allowsHitTesting(false)
                    Text("\(Int(selection.width)) × \(Int(selection.height))")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(RecorderPalette.surface, in: RoundedRectangle(cornerRadius: 6))
                        .foregroundStyle(RecorderPalette.text)
                        .offset(x: selection.x, y: max(0, selection.y - 26))
                        .allowsHitTesting(false)
                    if model.canCommit {
                        let top = selection.y >= 64 ? selection.y - Self.startButtonHeight - 12 : selection.y + 12
                        Button(action: { model.commit() }) {
                            Text("Start recording")
                                .font(.system(size: 14, weight: .semibold))
                                .padding(.horizontal, 20)
                                .frame(height: Self.startButtonHeight)
                        }
                        .buttonStyle(.plain)
                        .background(RecorderPalette.accent, in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(.white)
                        .offset(x: selection.x + selection.width / 2 - 80, y: top)
                    }
                } else {
                    VStack {
                        Spacer()
                        Text("Drag to choose what to record · Esc to cancel")
                            .font(.system(size: 14, weight: .medium))
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .background(RecorderPalette.surface, in: Capsule())
                            .foregroundStyle(RecorderPalette.text)
                        Spacer().frame(height: 120)
                    }
                    .frame(maxWidth: .infinity)
                    .allowsHitTesting(false)
                }
            }
        }
    }
}

// MARK: - Window picker

@MainActor
final class RecorderWindowPickerModel: ObservableObject {
    @Published var options: [DesktopRecorderWindowOption] = []
    @Published var loading = true
    @Published var error: String? = nil
    let bridge: RecorderWindowBridge

    init(bridge: RecorderWindowBridge) {
        self.bridge = bridge
        Task { await load() }
    }

    private func load() async {
        do {
            options = try await bridge.listWindowOptions()
        } catch {
            self.error = String(describing: error)
        }
        loading = false
    }

    func choose(_ option: DesktopRecorderWindowOption) {
        bridge.completeWindowSelection(DesktopRecorderWindowChoice(sourceId: option.id, title: option.title))
    }
}

struct RecorderWindowPickerView: View {
    @ObservedObject var model: RecorderWindowPickerModel
    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Choose a window").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button(action: { model.bridge.completeWindowSelection(nil) }) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain).foregroundStyle(RecorderPalette.muted).accessibilityLabel("Close")
            }
            .padding(.horizontal, 18).padding(.vertical, 12)
            Divider().overlay(RecorderPalette.border)
            if let error = model.error {
                VStack(spacing: 12) {
                    Text(error).font(.system(size: 13)).foregroundStyle(RecorderPalette.accent)
                    Button("Open Screen Recording settings") { model.bridge.openScreenRecordingSettings() }
                        .buttonStyle(.plain).font(.system(size: 13, weight: .semibold)).foregroundStyle(RecorderPalette.text)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.loading {
                Text("Looking for open windows…").font(.system(size: 13)).foregroundStyle(RecorderPalette.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.options.isEmpty {
                Text("No window is open to record. Try Display instead.").font(.system(size: 13)).foregroundStyle(RecorderPalette.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(model.options) { option in
                            Button(action: { model.choose(option) }) {
                                VStack(alignment: .leading, spacing: 6) {
                                    previewImage(option.previewDataUrl)
                                        .frame(height: 132)
                                        .frame(maxWidth: .infinity)
                                        .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                                    Text(option.appName).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                                    Text(option.title).font(.system(size: 11)).foregroundStyle(RecorderPalette.muted).lineLimit(1)
                                }
                                .padding(10)
                                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(18)
                }
            }
        }
        .frame(width: RecorderOverlayGeometry.windowPickerSize.width, height: RecorderOverlayGeometry.windowPickerSize.height)
        .background(RecorderPalette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(RecorderPalette.border, lineWidth: 1))
        .foregroundStyle(RecorderPalette.text)
    }

    @ViewBuilder
    private func previewImage(_ dataUrl: String) -> some View {
        if let comma = dataUrl.firstIndex(of: ","), let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])),
            let image = NSImage(data: data)
        {
            Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
        } else {
            Color.clear
        }
    }
}

// MARK: - Controller

struct RecorderControllerView: View {
    @ObservedObject var model: RecorderUIState
    let bridge: RecorderWindowBridge
    @State private var busy = false
    @State private var error: String? = nil

    private var state: DesktopRecorderState { model.state }

    private var finishing: String? {
        switch state.status {
        case .finalizing: return "Finishing…"
        case .delivering: return "Uploading…"
        default: return nil
        }
    }

    private var controlsDisabled: Bool {
        busy || finishing != nil
    }

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 10) {
                Circle()
                    .fill(state.status == .recording ? RecorderPalette.accent : RecorderPalette.muted)
                    .frame(width: 10, height: 10)
                Text(finishing ?? DesktopTrayMenu.formatRecordingElapsed(state.elapsedMs))
                    .font(.system(size: 14, weight: .semibold, design: .monospaced))
                    .frame(minWidth: 70, alignment: .leading)
                Spacer()
                control(state.status == .paused ? "play.fill" : "pause.fill", label: state.status == .paused ? "Resume" : "Pause") {
                    run(state.status == .paused ? "Could not resume" : "Could not pause") {
                        if state.status == .paused { try await bridge.resume() } else { try await bridge.pause() }
                    }
                }
                control("stop.fill", label: "Finish recording") {
                    run("Could not finish the recording") { try await bridge.stop() }
                }
                control("trash", label: "Delete recording") {
                    run("Could not delete the recording") { try await bridge.discard() }
                }
            }
            if let error {
                Text(error).font(.system(size: 10)).foregroundStyle(RecorderPalette.accent).lineLimit(1)
            }
        }
        .padding(.horizontal, 14)
        .frame(width: RecorderOverlayGeometry.controllerSize.width, height: RecorderOverlayGeometry.controllerSize.height)
        .background(RecorderPalette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(RecorderPalette.border, lineWidth: 1))
        .foregroundStyle(RecorderPalette.text)
    }

    private func control(_ systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.system(size: 13, weight: .semibold)).frame(width: 30, height: 30)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(controlsDisabled)
        .opacity(controlsDisabled ? 0.5 : 1)
        .accessibilityLabel(label)
    }

    private func run(_ failure: String, _ operation: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do {
                try await operation()
            } catch {
                self.error = failure
            }
            busy = false
        }
    }
}
#endif
