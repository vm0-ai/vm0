import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ComputerUseCommand } from "./computer-use-accessibility";
import {
  DesktopMcpPluginManager,
  parseMcpServersJson,
} from "./desktop-mcp-plugin";

const nodeRequire = createRequire(__filename);

function filesystemServerEntry(): string {
  return nodeRequire.resolve(
    "@modelcontextprotocol/server-filesystem/dist/index.js",
  );
}

function pluginCommand(payload: Record<string, unknown>): ComputerUseCommand {
  return {
    id: "cmd-1",
    kind: "plugin.call",
    payload,
  };
}

async function waitForServerStatus(
  manager: DesktopMcpPluginManager,
  name: string,
  status: string,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const server = manager
      .getState()
      .servers.find((entry) => entry.name === name);
    if (server?.status === status) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Timed out waiting for MCP server ${name} to become ${status} (currently ${server?.status ?? "missing"}: ${server?.lastError ?? "no error"})`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

describe("parseMcpServersJson", () => {
  it("parses the community mcpServers format", () => {
    const servers = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          notes: { command: "npx", args: ["-y", "apple-notes-mcp"] },
          figma: { url: "http://127.0.0.1:3845/mcp" },
        },
      }),
    );
    expect(servers).toStrictEqual({
      notes: { command: "npx", args: ["-y", "apple-notes-mcp"], env: {} },
      figma: { url: "http://127.0.0.1:3845/mcp" },
    });
  });

  it("parses a bare name-to-config map", () => {
    const servers = parseMcpServersJson(
      JSON.stringify({ notes: { command: "npx" } }),
    );
    expect(Object.keys(servers)).toStrictEqual(["notes"]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseMcpServersJson("{nope")).toThrow(/not valid JSON/);
  });

  it("rejects invalid server names", () => {
    expect(() =>
      parseMcpServersJson(
        JSON.stringify({ mcpServers: { "Bad Name!": { command: "npx" } } }),
      ),
    ).toThrow(/names must match/);
  });

  it("rejects servers without a command or url", () => {
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { notes: {} } })),
    ).toThrow(/must declare either/);
  });

  it("rejects empty configurations", () => {
    expect(() => parseMcpServersJson("{}")).toThrow(/contains no servers/);
  });
});

describe("DesktopMcpPluginManager", () => {
  const managers: DesktopMcpPluginManager[] = [];

  function createManager(preferencesPath: string): DesktopMcpPluginManager {
    const manager = new DesktopMcpPluginManager({
      preferencesPath,
      onChange: () => {},
    });
    managers.push(manager);
    return manager;
  }

  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.stop();
    }
  });

  it("runs a stdio MCP server end to end", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "mcp-plugin-"));
    writeFileSync(path.join(workspace, "hello.txt"), "hello from mcp\n");
    const preferencesPath = path.join(workspace, "preferences.json");

    const manager = createManager(preferencesPath);
    manager.load();
    manager.importServersJson(
      JSON.stringify({
        mcpServers: {
          files: {
            command: process.execPath,
            args: [filesystemServerEntry(), workspace],
          },
        },
      }),
    );
    manager.setFeatureEnabled(true);
    manager.setHostRuntimeOnline(true);

    expect(manager.getState().servers).toStrictEqual([
      {
        name: "files",
        transport: "stdio",
        enabled: false,
        status: "disabled",
        lastError: null,
        tools: [],
      },
    ]);
    expect(
      await manager.execute(
        pluginCommand({
          plugin: "mcp",
          server: "files",
          tool: "read_text_file",
          arguments: {},
        }),
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "plugin_disabled" },
    });

    manager.setServerEnabled("files", true);
    await waitForServerStatus(manager, "files", "running");
    expect(manager.getCapabilities()).toStrictEqual(["plugin.mcp.files"]);

    const listResult = await manager.execute(
      pluginCommand({
        plugin: "mcp",
        server: "files",
        tool: "tools/list",
        arguments: {},
      }),
    );
    expect(listResult.status).toBe("succeeded");
    if (listResult.status !== "succeeded") {
      throw new Error("unreachable");
    }
    const listed: unknown = JSON.parse(String(listResult.result.content));
    expect(JSON.stringify(listed)).toContain("read_text_file");

    const readResult = await manager.execute(
      pluginCommand({
        plugin: "mcp",
        server: "files",
        tool: "read_text_file",
        arguments: { path: path.join(workspace, "hello.txt") },
      }),
    );
    expect(readResult).toMatchObject({
      status: "succeeded",
      result: {
        plugin: "mcp",
        server: "files",
        tool: "read_text_file",
      },
    });
    if (readResult.status !== "succeeded") {
      throw new Error("unreachable");
    }
    expect(String(readResult.result.content)).toContain("hello from mcp");

    expect(
      await manager.execute(
        pluginCommand({
          plugin: "mcp",
          server: "files",
          tool: "no_such_tool",
          arguments: {},
        }),
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "unknown_tool" },
    });

    expect(
      await manager.execute(
        pluginCommand({
          plugin: "mcp",
          server: "missing",
          tool: "read_text_file",
          arguments: {},
        }),
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "plugin_unavailable" },
    });

    // Config persists across manager instances and keeps the enabled flag.
    const reloaded = createManager(preferencesPath);
    reloaded.load();
    expect(reloaded.getState().servers).toMatchObject([
      { name: "files", enabled: true, transport: "stdio" },
    ]);
  }, 30_000);

  it("rejects calls while the plugin feature switch is off", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "mcp-plugin-"));
    const manager = createManager(path.join(workspace, "preferences.json"));
    manager.load();
    manager.importServersJson(
      JSON.stringify({ mcpServers: { notes: { command: "npx" } } }),
    );
    expect(
      await manager.execute(
        pluginCommand({
          plugin: "mcp",
          server: "notes",
          tool: "anything",
          arguments: {},
        }),
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "feature_disabled" },
    });
  });
});
