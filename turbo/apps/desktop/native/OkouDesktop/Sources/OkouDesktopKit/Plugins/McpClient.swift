import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public struct McpError: Error, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

/// One JSON-RPC message pipe to an MCP server.
public protocol McpTransport: AnyObject {
    var onMessage: ((JSONValue) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }
    func start() async throws
    func send(_ message: JSONValue) async throws
    func close() async
    /// The negotiated protocol version, forwarded on later HTTP requests.
    func setProtocolVersion(_ version: String)
}

/// Environment the SDK inherits by default for stdio servers; everything
/// else stays out so secrets are not leaked to child processes.
public enum McpDefaultEnvironment {
    public static let inheritedKeys = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]

    public static func environment(from source: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var result: [String: String] = [:]
        for key in inheritedKeys {
            guard let value = source[key], !value.hasPrefix("()") else { continue }
            result[key] = value
        }
        return result
    }

    /// `spawn` resolves a bare command through PATH; `Process` does not.
    public static func resolveExecutable(_ command: String, path: String?) -> String? {
        if command.contains("/") {
            return FileManager.default.isExecutableFile(atPath: command) ? command : nil
        }
        for directory in (path ?? "").split(separator: ":") {
            let candidate = "\(directory)/\(command)"
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
}

/// Newline-delimited JSON-RPC over a child process's stdio.
public final class McpStdioTransport: McpTransport, @unchecked Sendable {
    public var onMessage: ((JSONValue) -> Void)? = nil
    public var onClose: (() -> Void)? = nil
    public var onError: ((Error) -> Void)? = nil

    private let command: String
    private let arguments: [String]
    private let environment: [String: String]
    private let process = Process()
    private let stdin = Pipe()
    private let stdout = Pipe()
    private let stderr = Pipe()
    private let lock = NSLock()
    private var buffer = Data()
    private var started = false
    private var closed = false
    public private(set) var stderrTail = ""

    public init(command: String, arguments: [String], environment: [String: String]) {
        self.command = command
        self.arguments = arguments
        self.environment = environment
    }

    public func setProtocolVersion(_ version: String) {}

    public func start() async throws {
        guard let executable = McpDefaultEnvironment.resolveExecutable(command, path: environment["PATH"]) else {
            throw McpError("spawn \(command) ENOENT")
        }
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self?.handleStdout(data)
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self?.lock.withLock {
                guard let self else { return }
                self.stderrTail = String((self.stderrTail + String(decoding: data, as: UTF8.self)).suffix(4_000))
            }
        }
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            let wasClosed = self.lock.withLock { () -> Bool in
                let previous = self.closed
                self.closed = true
                return previous
            }
            if !wasClosed {
                self.onClose?()
            }
        }
        do {
            try process.run()
        } catch {
            throw McpError("spawn \(command) \(error.localizedDescription)")
        }
        lock.withLock { started = true }
    }

    private func handleStdout(_ data: Data) {
        var lines: [String] = []
        lock.withLock {
            buffer.append(data)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.subdata(in: buffer.startIndex..<newline)
                buffer.removeSubrange(buffer.startIndex...newline)
                let line = String(decoding: lineData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                if !line.isEmpty { lines.append(line) }
            }
        }
        for line in lines {
            do {
                onMessage?(try JSONValue.parse(line))
            } catch {
                onError?(McpError("Invalid JSON-RPC message from MCP server: \(error)"))
            }
        }
    }

    public func send(_ message: JSONValue) async throws {
        guard lock.withLock({ started && !closed }) else {
            throw McpError("MCP stdio transport is not connected")
        }
        do {
            try stdin.fileHandleForWriting.write(contentsOf: Data((message.serialized() + "\n").utf8))
        } catch {
            throw McpError("Unable to write to MCP server: \(error.localizedDescription)")
        }
    }

    public func close() async {
        let alreadyClosed = lock.withLock { () -> Bool in
            let previous = closed
            closed = true
            return previous
        }
        if alreadyClosed { return }
        try? stdin.fileHandleForWriting.close()
        if process.isRunning {
            for _ in 0..<20 {
                if !process.isRunning { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if process.isRunning {
                process.terminate()
            }
        }
    }
}

/// MCP Streamable HTTP: JSON-RPC over POST with JSON or SSE responses.
public final class McpStreamableHTTPTransport: McpTransport, @unchecked Sendable {
    public var onMessage: ((JSONValue) -> Void)? = nil
    public var onClose: (() -> Void)? = nil
    public var onError: ((Error) -> Void)? = nil

    private let url: URL
    private let http: DesktopHTTPClient
    private let lock = NSLock()
    private var sessionId: String? = nil
    private var protocolVersion: String? = nil
    private var closed = false

    public init(url: URL, http: DesktopHTTPClient = URLSessionHTTPClient()) {
        self.url = url
        self.http = http
    }

    public func setProtocolVersion(_ version: String) {
        lock.withLock { protocolVersion = version }
    }

    public func start() async throws {}

    public func send(_ message: JSONValue) async throws {
        guard !lock.withLock({ closed }) else {
            throw McpError("MCP HTTP transport is closed")
        }
        var headers = ["content-type": "application/json", "accept": "application/json, text/event-stream"]
        let (sessionId, version) = lock.withLock { (self.sessionId, self.protocolVersion) }
        if let sessionId { headers["mcp-session-id"] = sessionId }
        if let version { headers["mcp-protocol-version"] = version }
        let response = try await http.send(URLRequest.desktop(url: url, method: "POST", headers: headers, body: message.serializedData()))
        if let newSession = response.header("mcp-session-id") {
            lock.withLock { self.sessionId = newSession }
        }
        if response.status == 202 {
            return
        }
        guard response.ok else {
            if response.status == 404, sessionId != nil {
                throw McpError("MCP session expired (404)")
            }
            throw McpError("MCP server responded with HTTP \(response.status)")
        }
        let contentType = response.header("content-type") ?? ""
        if contentType.hasPrefix("text/event-stream") {
            for event in Self.parseServerSentEvents(response.text) {
                dispatch(event)
            }
        } else if !response.body.isEmpty {
            dispatch(response.text)
        }
    }

    private func dispatch(_ text: String) {
        do {
            let value = try JSONValue.parse(text)
            if let batch = value.arrayValue {
                for entry in batch { onMessage?(entry) }
            } else {
                onMessage?(value)
            }
        } catch {
            onError?(McpError("Invalid JSON-RPC message from MCP server: \(error)"))
        }
    }

    /// `data:` payloads of an SSE body; comments and other fields are ignored.
    public static func parseServerSentEvents(_ body: String) -> [String] {
        var events: [String] = []
        var data: [String] = []
        for rawLine in body.components(separatedBy: "\n") {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
            if line.isEmpty {
                if !data.isEmpty {
                    events.append(data.joined(separator: "\n"))
                    data.removeAll()
                }
                continue
            }
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("data:") {
                var value = String(line.dropFirst(5))
                if value.hasPrefix(" ") { value.removeFirst() }
                data.append(value)
            }
        }
        if !data.isEmpty {
            events.append(data.joined(separator: "\n"))
        }
        return events
    }

    public func close() async {
        let sessionId: String? = lock.withLock {
            closed = true
            return self.sessionId
        }
        guard let sessionId else { return }
        var headers: [String: String] = ["mcp-session-id": sessionId]
        if let version = lock.withLock({ protocolVersion }) { headers["mcp-protocol-version"] = version }
        _ = try? await http.send(URLRequest.desktop(url: url, method: "DELETE", headers: headers))
    }
}

public struct McpTool: Equatable, Sendable {
    public var name: String
    public var description: String
    public var inputSchema: JSONValue

    public init(name: String, description: String, inputSchema: JSONValue) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
    }

    public var json: JSONValue {
        .object(["name": .string(name), "description": .string(description), "inputSchema": inputSchema])
    }
}

/// Minimal MCP client: initialize handshake, tools/list, tools/call.
public final class McpClient: @unchecked Sendable {
    public static let protocolVersion = "2025-06-18"
    public static let requestTimeoutMs: Double = 60_000

    public let transport: McpTransport
    private let clientName: String
    private let clientVersion: String
    private let lock = NSLock()
    private var nextId = 0
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var closed = false
    public private(set) var serverProtocolVersion: String? = nil
    public private(set) var serverInfo: JSONValue? = nil

    public init(transport: McpTransport, clientName: String, clientVersion: String) {
        self.transport = transport
        self.clientName = clientName
        self.clientVersion = clientVersion
        transport.onMessage = { [weak self] message in self?.handle(message) }
        transport.onClose = { [weak self] in self?.failAll(McpError("MCP server connection closed")) }
        transport.onError = { [weak self] error in self?.failAll(error) }
    }

    private func handle(_ message: JSONValue) {
        if let id = message["id"]?.intValue, message["method"] == nil {
            let continuation = lock.withLock { pending.removeValue(forKey: id) }
            guard let continuation else { return }
            if let error = message["error"] {
                let code = error["code"]?.intValue ?? 0
                continuation.resume(throwing: McpError("MCP error \(code): \(error["message"]?.stringValue ?? "unknown")"))
            } else {
                continuation.resume(returning: message["result"] ?? .object([:]))
            }
            return
        }
        // Server-initiated requests: answer ping, refuse everything else.
        if let method = message["method"]?.stringValue, let id = message["id"] {
            let reply: JSONValue = method == "ping"
                ? .object(["jsonrpc": "2.0", "id": id, "result": .object([:])])
                : .object(["jsonrpc": "2.0", "id": id, "error": .object(["code": -32601, "message": "Method not found"])])
            Task { try? await self.transport.send(reply) }
        }
    }

    private func failAll(_ error: Error) {
        let continuations = lock.withLock { () -> [CheckedContinuation<JSONValue, Error>] in
            let all = Array(pending.values)
            pending.removeAll()
            return all
        }
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }

    public func request(_ method: String, params: JSONValue = .object([:]), timeoutMs: Double = McpClient.requestTimeoutMs) async throws -> JSONValue {
        guard !lock.withLock({ closed }) else { throw McpError("MCP client is closed") }
        let id = lock.withLock { () -> Int in
            nextId += 1
            return nextId
        }
        let message: JSONValue = .object(["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method), "params": params])
        return try await withThrowingTaskGroup(of: JSONValue.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { continuation in
                    self.lock.withLock { self.pending[id] = continuation }
                    Task {
                        do {
                            try await self.transport.send(message)
                        } catch {
                            if let pending = self.lock.withLock({ self.pending.removeValue(forKey: id) }) {
                                pending.resume(throwing: error)
                            }
                        }
                    }
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutMs * 1_000_000))
                throw McpError("MCP request \(method) timed out after \(Int(timeoutMs))ms")
            }
            do {
                let result = try await group.next()!
                group.cancelAll()
                return result
            } catch {
                group.cancelAll()
                if let pending = lock.withLock({ pending.removeValue(forKey: id) }) {
                    pending.resume(throwing: error)
                }
                throw error
            }
        }
    }

    public func notify(_ method: String, params: JSONValue = .object([:])) async throws {
        try await transport.send(.object(["jsonrpc": "2.0", "method": .string(method), "params": params]))
    }

    public func connect() async throws {
        try await transport.start()
        let result = try await request(
            "initialize",
            params: .object([
                "protocolVersion": .string(Self.protocolVersion),
                "capabilities": .object([:]),
                "clientInfo": .object(["name": .string(clientName), "version": .string(clientVersion)]),
            ])
        )
        let version = result["protocolVersion"]?.stringValue ?? Self.protocolVersion
        lock.withLock {
            serverProtocolVersion = version
            serverInfo = result["serverInfo"]
        }
        transport.setProtocolVersion(version)
        try await notify("notifications/initialized")
    }

    public func listTools() async throws -> [McpTool] {
        var tools: [McpTool] = []
        var cursor: String? = nil
        repeat {
            var params: [String: JSONValue] = [:]
            if let cursor { params["cursor"] = .string(cursor) }
            let result = try await request("tools/list", params: .object(params))
            for entry in result["tools"]?.arrayValue ?? [] {
                guard let name = entry["name"]?.stringValue else { continue }
                tools.append(McpTool(name: name, description: entry["description"]?.stringValue ?? "", inputSchema: entry["inputSchema"] ?? .object([:])))
            }
            cursor = result["nextCursor"]?.stringValue
        } while cursor != nil
        return tools
    }

    public func callTool(name: String, arguments: [String: JSONValue], timeoutMs: Double = McpClient.requestTimeoutMs) async throws -> McpCallToolResult {
        let result = try await request("tools/call", params: .object(["name": .string(name), "arguments": .object(arguments)]), timeoutMs: timeoutMs)
        guard let parsed = McpCallToolResult.parse(result) else {
            throw McpError("MCP server returned an unsupported tool result.")
        }
        return parsed
    }

    public func close() async {
        lock.withLock { closed = true }
        failAll(McpError("MCP client is closed"))
        await transport.close()
    }
}
