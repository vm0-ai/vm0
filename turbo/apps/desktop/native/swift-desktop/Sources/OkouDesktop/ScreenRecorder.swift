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
  private let helper: HelperProcess
  private let preferences: DesktopPreferences
  private let api: DesktopAPI
  private let auth: DesktopAuth
  private var sessionID: String?
  private var recording: JSON?
  private var pollTask: Task<Void, Never>?
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

  func start(source: JSON, systemAudio: Bool, microphone: Bool, area: JSON? = nil) async throws {
    guard available, !busy else {
      throw DesktopFailure("capture_failed", "A recording is already in progress or unavailable")
    }
    try await auth.refreshIdentity(api: api)
    guard auth.signedIn, auth.organization["id"].string != nil else {
      throw DesktopFailure("signed_out", "Sign in and select a workspace before recording")
    }
    status = "preparing"
    error = nil
    onChange()
    do {
      var payload: JSON = .object([
        "sourceId": source["id"], "sourceKind": area == nil ? source["kind"] : .string("area"),
        "systemAudio": .bool(systemAudio), "microphone": .bool(microphone && microphoneSupported),
      ])
      if let area { payload["area"] = area }
      let prepared = try await request("prepare", payload)
      sessionID = try prepared.requireString("sessionId")
      let directory = preferences.directory.appendingPathComponent("recordings")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let output = directory.appendingPathComponent("screen-recording-\(UUID().uuidString).mp4")
      _ = try await request(
        "start", .object(["sessionId": prepared["sessionId"], "outputPath": .string(output.path)]))
      status = "recording"
      elapsed = 0
      onChange()
      pollTask = Task { [weak self] in await self?.poll() }
    } catch {
      helper.close()
      sessionID = nil
      status = "idle"
      self.error = error.localizedDescription
      onChange()
      throw error
    }
  }

  func pauseOrResume() async throws {
    guard let sessionID, capturing else { return }
    let pause = status == "recording"
    _ = try await request(pause ? "pause" : "resume", .object(["sessionId": .string(sessionID)]))
    status = pause ? "paused" : "recording"
    onChange()
  }

  func stop() async throws {
    guard let sessionID, capturing else { return }
    pollTask?.cancel()
    await pollTask?.value
    pollTask = nil
    status = "finalizing"
    onChange()
    do {
      recording = try await request(
        "stop", .object(["sessionId": .string(sessionID)]), timeout: 120)
      self.sessionID = nil
      status = "ready"
      onChange()
      if let message = recording?["failure"]["message"].string {
        error = message
        onChange()
        return
      }
      try await deliver()
    } catch {
      self.sessionID = nil
      status = recording == nil ? "idle" : "ready"
      self.error = error.localizedDescription
      onChange()
      throw error
    }
  }

  func discard() async throws {
    pollTask?.cancel()
    await pollTask?.value
    pollTask = nil
    if let sessionID {
      _ = try await request("discard", .object(["sessionId": .string(sessionID)]))
    }
    self.sessionID = nil
    recording = nil
    status = "idle"
    error = nil
    onChange()
  }

  func deliver() async throws {
    guard let recording else { return }
    status = "delivering"
    error = nil
    onChange()
    do {
      try await auth.refreshIdentity(api: api)
      let userID = try auth.user.requireString("userId")
      let video = try await api.upload(
        file: URL(fileURLWithPath: recording.requireString("videoPath")), contentType: "video/mp4")
      let clicks = try await api.upload(
        file: URL(fileURLWithPath: recording.requireString("clickTrackPath")),
        contentType: "application/json")
      var url = URLComponents(url: api.configuration.platformURL, resolvingAgainstBaseURL: false)!
      url.path = "/"
      url.queryItems = [
        .init(name: "intro-video-recording", value: video["id"].string),
        .init(name: "intro-video-recording-name", value: video["name"].string),
        .init(name: "intro-video-recording-size", value: String(Int(video["size"].number ?? 0))),
        .init(name: "intro-video-clicks", value: clicks["id"].string),
        .init(name: "intro-video-clicks-name", value: clicks["name"].string),
        .init(name: "intro-video-clicks-size", value: String(Int(clicks["size"].number ?? 0))),
        .init(name: "intro-video-user", value: userID),
      ]
      NSWorkspace.shared.open(url.url!)
      self.recording = nil
      status = "idle"
      onChange()
    } catch {
      status = "ready"
      self.error = error.localizedDescription
      onChange()
      throw error
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
        let state = try await request("state", .object(["sessionId": .string(sessionID)]))
        elapsed = (state["elapsedMs"].number ?? 0) / 1000
        onChange()
        if state["status"].string == "failed" {
          recording = try await request(
            "stop", .object(["sessionId": .string(sessionID)]), timeout: 120)
          self.sessionID = nil
          status = "ready"
          error = state["error"]["message"].string ?? "Recording source was lost"
          onChange()
          return
        }
      } catch {
        if Task.isCancelled { return }
        self.error = error.localizedDescription
        status = "idle"
        self.sessionID = nil
        helper.close()
        onChange()
        return
      }
    }
  }

  func shutdown() async throws {
    if capturing { try await stop() }
    pollTask?.cancel()
    await pollTask?.value
    pollTask = nil
    helper.close()
  }
}
