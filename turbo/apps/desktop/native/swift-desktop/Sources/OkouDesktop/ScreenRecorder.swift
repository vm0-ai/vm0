import AppKit
import DesktopCore

@MainActor
final class ScreenRecorder: ObservableObject {
  @Published private(set) var status = "idle"
  @Published private(set) var elapsed: Double = 0
  @Published private(set) var error: String?
  @Published private(set) var sources: [JSON] = []
  @Published private(set) var previews: [String: NSImage] = [:]
  @Published private(set) var microphoneSupported = false
  private(set) var captureID: UUID?
  private(set) var captureSourceID: String?
  private(set) var captureArea: CGRect?
  private let helper: HelperProcess
  private let preferences: DesktopPreferences
  private let api: DesktopAPI
  private let auth: DesktopAuth
  private var sessionID: String?
  private var recording: JSON?
  private var recordingIdentity: DesktopAuth.Identity?
  private var captureHelperGeneration: Int?
  private var pollTask: Task<Void, Never>?
  private var control: (id: UUID, task: Task<Void, any Error>)?
  private var teardown: (id: UUID, task: Task<Void, any Error>)?

  private struct RecorderState: Decodable {
    enum Status: String, Decodable { case ready, recording, paused, stopped, discarded, failed }
    struct Failure: Decodable {
      let code: String
      let message: String
    }
    let status: Status
    let elapsedMs: Double
    let error: Failure?
  }
  private struct RecordingOutput: Decodable {
    let videoPath: String
    let clickTrackPath: String
    let durationMs: Int
    let sizeBytes: Int64
    let width: Int
    let height: Int
    let failure: RecorderState.Failure?
  }
  var onChange: @MainActor () -> Void = {}
  var available = false
  var capturing: Bool { ["recording", "paused"].contains(status) }
  var busy: Bool { !["idle", "ready"].contains(status) }

  init(helper: HelperProcess, preferences: DesktopPreferences, api: DesktopAPI, auth: DesktopAuth) {
    self.helper = helper
    self.preferences = preferences
    self.api = api
    self.auth = auth
  }

  private func request(_ kind: String, _ fields: JSON = .object([:]), timeout: Double = 35)
    async throws -> JSON
  {
    try await helper.request(
      "recorder." + kind, fields: .object(["payload": fields]), timeout: timeout)
  }

  func loadSources() async throws {
    guard available else {
      throw DesktopFailure("feature_disabled", "Screen recording is disabled for this account")
    }
    microphoneSupported = try await request("capabilities")["supportsMicrophone"].bool
    let permission = try await request("requestPermission")
    guard permission["granted"].bool else {
      throw DesktopFailure(
        "permission_denied", "Grant Screen Recording permission in System Settings")
    }
    sources = try await request("sources")["sources"].array
    let images = try await request("windowPreviews")["previews"].array
    previews = [:]
    for image in images {
      guard let id = image["id"].string, let url = image["previewDataUrl"].string,
        let encoded = url.split(separator: ",", maxSplits: 1).last,
        let bytes = Data(base64Encoded: String(encoded)), let picture = NSImage(data: bytes)
      else { continue }
      previews[id] = picture
    }
  }

  private func performControl(_ operation: @escaping @MainActor () async throws -> Void)
    async throws
  {
    guard control == nil, teardown == nil else { return }
    let id = UUID()
    let task = Task { try await operation() }
    control = (id, task)
    defer { if control?.id == id { control = nil } }
    try await task.value
  }

  func start(source: JSON, systemAudio: Bool, microphone: Bool, area: JSON? = nil) async throws {
    try await performControl {
      try await self.startCapture(
        source: source, systemAudio: systemAudio, microphone: microphone, area: area)
    }
  }

  private func startCapture(source: JSON, systemAudio: Bool, microphone: Bool, area: JSON?)
    async throws
  {
    guard available, !busy else {
      throw DesktopFailure("capture_failed", "A recording is already in progress or unavailable")
    }
    recording = nil
    status = "preparing"
    error = nil
    onChange()
    do {
      try await auth.refreshIdentity(api: api)
      try Task.checkCancellation()
      guard available else { throw CancellationError() }
      guard auth.signedIn, auth.organization["id"].string != nil else {
        throw DesktopFailure("signed_out", "Sign in and select a workspace before recording")
      }
      recordingIdentity = try auth.identity()
      captureID = UUID()
      captureSourceID = try source.requireString("id")
      if let area {
        guard let x = area["x"].number, let y = area["y"].number,
          let width = area["width"].number, let height = area["height"].number,
          [x, y, width, height].allSatisfy(\.isFinite), width > 0, height > 0
        else { throw DesktopFailure("capture_failed", "Select a valid recording area") }
        captureArea = CGRect(x: x, y: y, width: width, height: height)
      } else {
        captureArea = nil
      }
      var payload: JSON = .object([
        "sourceId": source["id"], "sourceKind": area == nil ? source["kind"] : .string("area"),
        "systemAudio": .bool(systemAudio), "microphone": .bool(microphone && microphoneSupported),
      ])
      if let area { payload["area"] = area }
      let prepared = try await request("prepare", payload)
      sessionID = try prepared.requireString("sessionId")
      try Task.checkCancellation()
      let directory = preferences.directory.appendingPathComponent("recordings")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let output = directory.appendingPathComponent("screen-recording-\(UUID().uuidString).mp4")
      _ = try await request(
        "start", .object(["sessionId": prepared["sessionId"], "outputPath": .string(output.path)]))
      captureHelperGeneration = helper.generation
      status = "recording"
      elapsed = 0
      onChange()
      pollTask = Task { [weak self] in await self?.poll() }
    } catch {
      await helper.stop()
      sessionID = nil
      status = "idle"
      self.error = error.localizedDescription
      onChange()
      throw error
    }
  }

  func pauseOrResume() async throws { try await performControl { try await self.changePause() } }

  private func changePause() async throws {
    guard let sessionID, capturing else { return }
    let pause = status == "recording"
    _ = try await request(pause ? "pause" : "resume", .object(["sessionId": .string(sessionID)]))
    status = pause ? "paused" : "recording"
    onChange()
  }

  func stop() async throws { try await performControl { try await self.stopCapture() } }

  private func stopCapture() async throws {
    guard let sessionID, capturing else { return }
    pollTask?.cancel()
    await pollTask?.value
    pollTask = nil
    let previousStatus = status
    status = "finalizing"
    onChange()
    do {
      try await collect(sessionID, deliver: true)
    } catch {
      // A failed stop may leave the capture alive; retain ownership so the
      // user can retry instead of losing a still-running helper session.
      status = previousStatus
      self.error = error.localizedDescription
      pollTask = Task { [weak self] in await self?.poll() }
      onChange()
      throw error
    }
  }

  private func collect(_ sessionID: String, deliver: Bool) async throws {
    let response = try await request(
      "stop", .object(["sessionId": .string(sessionID)]), timeout: 120)
    let output = try JSONDecoder().decode(RecordingOutput.self, from: response.encoded())
    guard output.videoPath.hasPrefix("/"), output.clickTrackPath.hasPrefix("/"),
      output.durationMs >= 0, output.sizeBytes >= 0, output.width > 0, output.height > 0
    else {
      throw DesktopFailure("helper_protocol", "The recorder returned invalid recording metadata")
    }
    recording = response
    self.sessionID = nil
    status = "ready"
    if let message = recording?["failure"]["message"].string {
      error = message
      onChange()
      return
    }
    onChange()
    if deliver { try await uploadRecording() }
  }

  func discard() async throws { try await performControl { try await self.discardCapture() } }

  private func discardCapture() async throws {
    guard let sessionID, capturing else { return }
    let previousStatus = status
    pollTask?.cancel()
    await pollTask?.value
    pollTask = nil
    status = "discarding"
    onChange()
    do {
      _ = try await request("discard", .object(["sessionId": .string(sessionID)]))
      self.sessionID = nil
      recording = nil
      recordingIdentity = nil
      status = "idle"
      elapsed = 0
      error = nil
      onChange()
    } catch {
      status = previousStatus
      self.error = error.localizedDescription
      pollTask = Task { [weak self] in await self?.poll() }
      onChange()
      throw error
    }
  }

  func deliver() async throws { try await performControl { try await self.uploadRecording() } }

  private func uploadRecording() async throws {
    guard let recording, let recordingIdentity else { return }
    status = "delivering"
    error = nil
    onChange()
    do {
      let delivery = DesktopAPI(configuration: api.configuration)
      delivery.tokenProvider = { [auth] force in
        try await auth.token(for: recordingIdentity, force: force)
      }
      let video = try await delivery.upload(
        file: URL(fileURLWithPath: recording.requireString("videoPath")), contentType: "video/mp4")
      let clicks = try await delivery.upload(
        file: URL(fileURLWithPath: recording.requireString("clickTrackPath")),
        contentType: "application/json")
      var url = URLComponents(url: api.configuration.platformURL, resolvingAgainstBaseURL: false)!
      url.path = "/"
      url.queryItems = [
        .init(name: "intro-video-recording", value: video.id),
        .init(name: "intro-video-recording-name", value: video.name),
        .init(name: "intro-video-recording-size", value: String(video.size)),
        .init(name: "intro-video-clicks", value: clicks.id),
        .init(name: "intro-video-clicks-name", value: clicks.name),
        .init(name: "intro-video-clicks-size", value: String(clicks.size)),
        .init(name: "intro-video-user", value: recordingIdentity.userID),
      ]
      NSWorkspace.shared.open(url.url!)
      self.recording = nil
      self.recordingIdentity = nil
      status = "idle"
      onChange()
    } catch {
      status = "ready"
      self.error = error.localizedDescription
      onChange()
    }
  }

  func revealRecording() {
    if let path = recording?["videoPath"].string {
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
  }

  private func poll() async {
    while !Task.isCancelled, capturing, let sessionID {
      do {
        try await Task.sleep(for: .seconds(1))
        guard captureHelperGeneration == helper.generation else {
          throw DesktopFailure("helper_unavailable", "The recording process exited unexpectedly")
        }
        let response = try await request("state", .object(["sessionId": .string(sessionID)]))
        guard !Task.isCancelled, capturing, self.sessionID == sessionID else { return }
        let state = try JSONDecoder().decode(RecorderState.self, from: response.encoded())
        guard state.elapsedMs.isFinite, state.elapsedMs >= 0 else {
          throw DesktopFailure("helper_protocol", "The recorder returned an invalid elapsed time")
        }
        elapsed = state.elapsedMs / 1000
        onChange()
        if state.status == .failed || state.status == .stopped {
          let failed = state.status == .failed
          let failure: String?
          if failed {
            guard let message = state.error?.message, !message.isEmpty else {
              throw DesktopFailure("helper_protocol", "The recorder omitted its failure reason")
            }
            failure = message
          } else {
            failure = nil
          }
          try await performControl {
            let previousStatus = self.status
            self.status = "finalizing"
            self.onChange()
            do {
              try await self.collect(sessionID, deliver: !failed)
              if let failure { self.error = failure }
            } catch {
              self.status = previousStatus
              throw error
            }
            self.onChange()
          }
          if self.sessionID == nil { return }
        }
      } catch {
        if Task.isCancelled { return }
        self.error = error.localizedDescription
        // A transient state query or finalization failure does not establish
        // that the capture ended. Retain its controls and poll again so the
        // user can stop/discard and existing frames remain recoverable.
        onChange()
        if captureHelperGeneration != helper.generation {
          status = "idle"
          self.sessionID = nil
          await helper.stop()
          onChange()
          return
        }
      }
    }
  }

  func shutdown(force: Bool = false) async throws {
    do { try await shutdownOwnedCapture() } catch {
      if force {
        pollTask?.cancel()
        await pollTask?.value
        pollTask = nil
        await helper.stop()
        sessionID = nil
        status = recording == nil ? "idle" : "ready"
        onChange()
      }
      throw error
    }
  }

  private func shutdownOwnedCapture() async throws {
    if let teardown { return try await teardown.task.value }
    let id = UUID()
    let task = Task { try await self.releaseCapture() }
    teardown = (id, task)
    defer { if teardown?.id == id { teardown = nil } }
    try await task.value
  }

  private func releaseCapture() async throws {
    if let control {
      if status == "preparing" { control.task.cancel() }
      do { try await control.task.value } catch { self.error = error.localizedDescription }
      if self.control?.id == control.id { self.control = nil }
    }
    pollTask?.cancel()
    await pollTask?.value
    pollTask = nil
    do {
      if let sessionID, capturing { try await collect(sessionID, deliver: false) }
      await helper.stop()
    } catch {
      if capturing { pollTask = Task { [weak self] in await self?.poll() } }
      throw error
    }
  }
}
