import XCTest

@testable import OkouDesktopKit

/// A tiny MCP stdio server in Python: initialize, tools/list, tools/call.
private let fakeServerScript = #"""
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    rid = msg.get("id")
    if method == "initialize":
        out = {"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": msg["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}}}
    elif method == "notifications/initialized":
        continue
    elif method == "tools/list":
        out = {"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object"}}, {"name": "boom", "description": "", "inputSchema": {}}]}}
    elif method == "tools/call":
        name = msg["params"]["name"]
        if name == "echo":
            out = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "echo:" + msg["params"]["arguments"].get("text", "")}]}}
        elif name == "boom":
            out = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "kaboom"}], "isError": True}}
        else:
            out = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": "Unknown tool: " + name}}
    elif method == "ping":
        out = {"jsonrpc": "2.0", "id": rid, "result": {}}
    else:
        out = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Method not found"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
"""#

@MainActor
final class McpTests: XCTestCase {
    private static func python() -> String? {
        for candidate in ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"] where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
    }

    private func serverConfig(enabled: Bool) throws -> McpServerConfig {
        guard let python = Self.python() else { throw XCTSkip("python3 is not available") }
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("fake-mcp-\(UUID().uuidString).py")
        try fakeServerScript.write(to: script, atomically: true, encoding: .utf8)
        return .stdio(enabled: enabled, command: python, args: [script.path], env: [:])
    }

    func testStdioClientHandshakeAndTools() async throws {
        guard case let .stdio(_, command, args, _) = try serverConfig(enabled: true) else { return }
        let transport = McpStdioTransport(command: command, arguments: args, environment: McpDefaultEnvironment.environment())
        let client = McpClient(transport: transport, clientName: "test", clientVersion: "1")
        try await client.connect()
        XCTAssertEqual(client.serverProtocolVersion, McpClient.protocolVersion)
        XCTAssertEqual(client.serverInfo?["name"]?.stringValue, "fake")
        let tools = try await client.listTools()
        XCTAssertEqual(tools.map(\.name), ["echo", "boom"])
        let result = try await client.callTool(name: "echo", arguments: ["text": "hi"])
        XCTAssertEqual(result, McpCallToolResult(content: [.text("echo:hi")], isError: false))
        do {
            _ = try await client.callTool(name: "missing", arguments: [:])
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(String(describing: error), "MCP error -32602: Unknown tool: missing")
        }
        await client.close()
    }

    func testStdioMissingCommandReportsEnoent() async {
        let transport = McpStdioTransport(command: "definitely-not-a-command-xyz", arguments: [], environment: ["PATH": "/usr/bin:/bin"])
        let client = McpClient(transport: transport, clientName: "test", clientVersion: "1")
        do {
            try await client.connect()
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(String(describing: error), "spawn definitely-not-a-command-xyz ENOENT")
        }
        XCTAssertEqual(DesktopMcpPluginManager.withEnoentHint("spawn npx ENOENT"), "spawn npx ENOENT — " + DesktopMcpPluginManager.enoentHint)
    }

    func testServerJsonParsing() throws {
        let parsed = try McpServersJson.parse(#"{"mcpServers":{"apple-notes":{"command":"npx","args":["-y","mcp-apple-notes"],"enabled":true},"figma":{"url":"http://127.0.0.1:3845/mcp"}}}"#)
        XCTAssertEqual(parsed["apple-notes"], .stdio(enabled: false, command: "npx", args: ["-y", "mcp-apple-notes"], env: [:]))
        XCTAssertEqual(parsed["figma"], .http(enabled: false, url: "http://127.0.0.1:3845/mcp"))
        XCTAssertEqual(try McpServersJson.parse(#"{"a":{"command":"x"}}"#).count, 1)
        XCTAssertThrowsError(try McpServersJson.parse("nope")) { XCTAssertEqual(String(describing: $0), "MCP server configuration is not valid JSON") }
        XCTAssertThrowsError(try McpServersJson.parse("[]")) { XCTAssertEqual(String(describing: $0), "MCP server configuration must be a JSON object") }
        XCTAssertThrowsError(try McpServersJson.parse("{}")) { XCTAssertEqual(String(describing: $0), "MCP server configuration contains no servers") }
        XCTAssertThrowsError(try McpServersJson.parse(#"{"Bad Name":{"url":"x"}}"#)) {
            XCTAssertEqual(String(describing: $0), "MCP server name \"Bad Name\" is invalid: names must match [a-z0-9_-]{1,64}")
        }
        XCTAssertThrowsError(try McpServersJson.parse(#"{"a":{"enabled":true}}"#)) {
            XCTAssertEqual(String(describing: $0), "MCP server \"a\" must declare either \"command\" (stdio) or \"url\" (Streamable HTTP)")
        }
        XCTAssertEqual(
            McpStreamableHTTPTransport.parseServerSentEvents("event: message\ndata: {\"a\":1}\n\n: comment\ndata: {\"b\":\ndata: 2}\n\n"),
            ["{\"a\":1}", "{\"b\":\n2}"]
        )
    }

    func testManagerLifecycleWithFakeServer() async throws {
        let config = try serverConfig(enabled: false)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("okou-mcp-\(UUID().uuidString)")
        let store = DesktopPreferencesStore(fileURL: directory.appendingPathComponent("prefs.json"))
        var changes = 0
        let manager = DesktopMcpPluginManager(store: store, onChange: { changes += 1 }, resolveShellPath: { nil }, sleep: { _ in })
        manager.load()
        guard case let .stdio(_, command, args, _) = config else { return }
        try manager.importServersJson(#"{"mcpServers":{"fake":{"command":"\#(command)","args":\#(JSONValue.array(args.map(JSONValue.string)).serialized())}}}"#)
        XCTAssertEqual(manager.state.servers.map(\.name), ["fake"])
        XCTAssertEqual(manager.state.servers.first?.enabled, false)
        let call = ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "mcp", "server": "fake", "tool": "echo", "arguments": ["text": "yo"]])
        let disabledFeature = await manager.execute(call)
        XCTAssertEqual(disabledFeature.failure?.code, .featureDisabled)
        manager.setFeatureEnabled(true)
        let disabledServer = await manager.execute(call)
        XCTAssertEqual(disabledServer.failure, ComputerUseCommandFailure(code: .pluginDisabled, message: "MCP server is disabled: fake"))
        try manager.setServerEnabled("fake", true)
        manager.setHostRuntimeOnline(true)
        for _ in 0..<100 where manager.state.servers.first?.status != .running {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(manager.state.servers.first?.status, .running)
        XCTAssertEqual(manager.state.servers.first?.tools, ["echo", "boom"])
        XCTAssertEqual(manager.capabilities, ["plugin.mcp.fake"])
        let echoed = await manager.execute(call)
        XCTAssertEqual(echoed.result?["content"]?.stringValue, "echo:yo")
        XCTAssertEqual(echoed.result?["server"]?.stringValue, "fake")
        let listed = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "mcp", "server": "fake", "tool": "tools/list"]))
        XCTAssertTrue(listed.result?["content"]?.stringValue?.contains("\"name\": \"echo\"") == true)
        let boom = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "mcp", "server": "fake", "tool": "boom"]))
        XCTAssertEqual(boom.failure, ComputerUseCommandFailure(code: .mcpError, message: "kaboom"))
        let unknown = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "mcp", "server": "fake", "tool": "nope"]))
        XCTAssertEqual(unknown.failure, ComputerUseCommandFailure(code: .unknownTool, message: "MCP server fake does not expose tool: nope"))
        let unconfigured = await manager.execute(ComputerUseCommand(id: "c", kind: "plugin.call", payload: ["plugin": "mcp", "server": "other", "tool": "x"]))
        XCTAssertEqual(unconfigured.failure?.code, .pluginUnavailable)
        try manager.removeServer("fake")
        XCTAssertEqual(manager.state.servers.count, 0)
        XCTAssertEqual(try store.read()["computerUsePlugins"]?["mcp"]?["servers"], .object([:]))
        XCTAssertTrue(changes > 3)
        try? FileManager.default.removeItem(at: directory)
    }
}
