import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public struct DesktopHTTPError: Error, LocalizedError, Sendable {
  public let status: Int
  public let path: String
  public let retryAfter: Double?
  public var errorDescription: String? { "\(path) returned HTTP \(status)" }
  public var retryable: Bool { status == 408 || status == 429 || status >= 500 }
}

@MainActor
public final class DesktopAPI {
  public let configuration: DesktopConfiguration
  private let session: URLSession
  private let sessionID = UUID().uuidString.lowercased()
  public var tokenProvider: (@MainActor (Bool) async throws -> String?)?

  public init(
    configuration: DesktopConfiguration, session: URLSession = URLSession(configuration: .ephemeral)
  ) {
    self.configuration = configuration
    self.session = session
  }

  public func request(
    _ path: String, method: String = "GET", body: JSON? = nil, hostToken: String? = nil,
    timeout: Double = 30
  ) async throws -> JSON {
    let token: String?
    if let hostToken { token = hostToken } else { token = try await tokenProvider?(false) }
    do {
      return try await send(path, method: method, body: body, token: token, timeout: timeout)
    } catch let error as DesktopHTTPError where error.status == 401 && hostToken == nil {
      guard let refreshed = try await tokenProvider?(true) else { throw error }
      return try await send(path, method: method, body: body, token: refreshed, timeout: timeout)
    }
  }

  private func send(_ path: String, method: String, body: JSON?, token: String?, timeout: Double)
    async throws -> JSON
  {
    let url = configuration.apiURL.appendingPathComponent(path)
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = method
    request.httpBody = try body?.encoded()
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(configuration.version, forHTTPHeaderField: "X-Client-Version")
    request.setValue("Desktop", forHTTPHeaderField: "X-Client-Type")
    request.setValue(configuration.product, forHTTPHeaderField: "X-Client-Product")
    request.setValue(sessionID, forHTTPHeaderField: "X-Client-Session-Id")
    request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-Client-Request-Id")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw DesktopFailure("network", "Invalid API response")
    }
    guard (200..<300).contains(http.statusCode) else {
      let retry = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init).map {
        min(300, max(0, $0))
      }
      throw DesktopHTTPError(status: http.statusCode, path: path, retryAfter: retry)
    }
    return data.isEmpty ? .object([:]) : try JSON.decode(data)
  }

  public func upload(file: URL, contentType: String) async throws -> JSON {
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    guard let size = attributes[.size] as? NSNumber else {
      throw DesktopFailure("upload", "Could not read recording size")
    }
    let prepared = try await request(
      "api/uploads/prepare", method: "POST",
      body: .object([
        "filename": .string(file.lastPathComponent), "contentType": .string(contentType),
        "size": .number(size.doubleValue),
      ]))
    guard let url = URL(string: try prepared.requireString("uploadUrl")), url.scheme == "https"
    else { throw DesktopFailure("upload", "Upload URL must use HTTPS") }
    var upload = URLRequest(url: url, timeoutInterval: 600)
    upload.httpMethod = "PUT"
    for (key, value) in prepared["uploadHeaders"].object ?? [:] {
      upload.setValue(value.string, forHTTPHeaderField: key)
    }
    // Storage requests use a separate, cookie-free session and never carry
    // the API bearer. URLSession streams the recording from disk.
    let storageConfiguration = URLSessionConfiguration.ephemeral
    storageConfiguration.httpCookieStorage = nil
    storageConfiguration.httpShouldSetCookies = false
    let storage = URLSession(configuration: storageConfiguration)
    defer { storage.finishTasksAndInvalidate() }
    let (_, response) = try await storage.upload(for: upload, fromFile: file)
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode)
    else { throw DesktopFailure("upload", "Recording upload failed") }
    let id = try prepared.requireString("id")
    _ = try await request(
      "api/uploads/complete", method: "POST",
      body: .object(["id": .string(id), "contentType": .string(contentType)]))
    return .object([
      "id": .string(id), "name": .string(file.lastPathComponent), "size": .number(size.doubleValue),
    ])
  }
}
