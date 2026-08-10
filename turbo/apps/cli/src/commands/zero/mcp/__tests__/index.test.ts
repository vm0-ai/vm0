import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  type CallToolResult,
  type RequestId,
  type RequestParams,
  type Tool,
} from "@modelcontextprotocol/client";
import chalk from "chalk";
import { delay, http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../../mocks/server";
import {
  customConnector,
  mcpCustomConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { zeroMcpCommand } from "../index";

const CONNECTOR_ID = "44444444-4444-4444-8444-444444444444";
const MCP_ENDPOINT = "https://mcp.example.test/server";
const SESSION_ID = "mcp-session-test";

type ProtocolEra = "modern" | "legacy";

interface SeenMcpRequest {
  readonly httpMethod: string;
  readonly method?: string;
  readonly params?: RequestParams;
  readonly intent: string | null;
}

interface McpServerOptions {
  readonly era: ProtocolEra;
  readonly pages?: readonly (readonly Tool[])[];
  readonly callResult?: CallToolResult;
  readonly callResponse?: () => Response;
  readonly listResponse?: (requestId: RequestId) => Response;
  readonly deleteResponse?: () => Response | Promise<Response>;
}

function processExit(): never {
  throw new Error("process.exit called");
}

function pageCursor(params: RequestParams | undefined): string | undefined {
  if (params === undefined || !("cursor" in params)) {
    return undefined;
  }
  const cursor: unknown = params.cursor;
  return typeof cursor === "string" ? cursor : undefined;
}

function stubMcpServer(options: McpServerOptions): SeenMcpRequest[] {
  const seen: SeenMcpRequest[] = [];
  const pages = options.pages ?? [[]];
  const callResult = options.callResult ?? {
    content: [{ type: "text", text: "tool completed" }],
  };

  server.use(
    http.all(MCP_ENDPOINT, async ({ request }) => {
      const intent = request.headers.get("x-vm0-connector-intent");
      if (request.method === "DELETE") {
        seen.push({ httpMethod: request.method, intent });
        if (options.deleteResponse) {
          return options.deleteResponse();
        }
        return new HttpResponse(null, { status: 204 });
      }

      const message: unknown = await request.json();
      if (isJSONRPCNotification(message)) {
        seen.push({
          httpMethod: request.method,
          method: message.method,
          params: message.params,
          intent,
        });
        return new HttpResponse(null, { status: 204 });
      }
      if (!isJSONRPCRequest(message)) {
        return HttpResponse.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid request" },
          },
          { status: 400 },
        );
      }

      seen.push({
        httpMethod: request.method,
        method: message.method,
        params: message.params,
        intent,
      });

      if (message.method === "server/discover") {
        if (options.era === "legacy") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        return HttpResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
            },
          },
          { headers: { "mcp-session-id": SESSION_ID } },
        );
      }

      if (message.method === "initialize") {
        return HttpResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "test-mcp", version: "1.0.0" },
            },
          },
          { headers: { "mcp-session-id": SESSION_ID } },
        );
      }

      if (message.method === "tools/list") {
        if (options.listResponse) {
          return options.listResponse(message.id);
        }
        const cursor = pageCursor(message.params);
        const pageIndex = cursor === undefined ? 0 : Number(cursor);
        const tools = pages[pageIndex];
        if (tools === undefined) {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "Unknown cursor" },
          });
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ...(options.era === "modern" ? { resultType: "complete" } : {}),
            ttlMs: 0,
            cacheScope: "private",
            tools,
            ...(pageIndex + 1 < pages.length
              ? { nextCursor: String(pageIndex + 1) }
              : {}),
          },
        });
      }

      if (message.method === "tools/call") {
        if (options.callResponse) {
          return options.callResponse();
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ...(options.era === "modern" ? { resultType: "complete" } : {}),
            ...callResult,
          },
        });
      }

      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    }),
  );
  return seen;
}

function stubConnectorList(
  overrides: Parameters<typeof mcpCustomConnector>[0] = {},
): void {
  server.use(stubCustomConnectors([mcpCustomConnector(overrides)]));
}

function outputText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().join("\n");
}

describe("zero mcp command", () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(processExit);
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let inputDirectory: string;

  beforeAll(async () => {
    inputDirectory = await mkdtemp(join(process.cwd(), ".zero-mcp-test-"));
  });

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("ZERO_CUSTOM_CONNECTOR_IDS", JSON.stringify([CONNECTOR_ID]));
  });

  afterEach(() => {
    exit.mockClear();
    consoleLog.mockClear();
    consoleError.mockClear();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await rm(inputDirectory, { recursive: true, force: true });
  });

  it("lists only admitted MCP definitions in slug order with safe JSON fields", async () => {
    const secondId = "55555555-5555-4555-8555-555555555555";
    const httpId = "33333333-3333-4333-8333-333333333333";
    vi.stubEnv(
      "ZERO_CUSTOM_CONNECTOR_IDS",
      JSON.stringify([secondId, CONNECTOR_ID, httpId]),
    );
    server.use(
      stubCustomConnectors([
        mcpCustomConnector({ slug: "_zulu" }),
        customConnector(),
        mcpCustomConnector({
          id: secondId,
          slug: "_alpha",
          displayName: "Alpha MCP",
          endpoint: "https://alpha-mcp.example.test/server",
          connected: false,
        }),
        mcpCustomConnector({
          id: "66666666-6666-4666-8666-666666666666",
          slug: "_not-admitted",
        }),
      ]),
    );

    await zeroMcpCommand.parseAsync(["node", "zero", "list", "--json"]);

    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        connectors: [
          {
            slug: "_alpha",
            displayName: "Alpha MCP",
            transport: "streamable-http",
            endpoint: "https://alpha-mcp.example.test/server",
            connected: false,
          },
          {
            slug: "_zulu",
            displayName: "Acme MCP",
            transport: "streamable-http",
            endpoint: MCP_ENDPOINT,
            connected: true,
          },
        ],
      }),
    );
    const output = outputText(consoleLog);
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("secrets.secret");
    expect(output).not.toContain(httpId);
  });

  it("rejects malformed run metadata before requesting connector definitions", async () => {
    let apiCalls = 0;
    vi.stubEnv("ZERO_CUSTOM_CONNECTOR_IDS", "x".repeat(128 * 1024 + 1));
    server.use(
      http.get("http://localhost:3000/api/zero/custom-connectors", () => {
        apiCalls++;
        return HttpResponse.json({ connectors: [] });
      }),
    );

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list"]),
    ).rejects.toThrow("process.exit called");

    expect(apiCalls).toBe(0);
    expect(outputText(consoleError)).toContain("Start a new Agent Run");
    expect(outputText(consoleError)).not.toContain("xxxx");
  });

  it("rejects duplicate run IDs without a broad fallback", async () => {
    vi.stubEnv(
      "ZERO_CUSTOM_CONNECTOR_IDS",
      JSON.stringify([CONNECTOR_ID, CONNECTOR_ID.toUpperCase()]),
    );
    server.use(stubCustomConnectors([mcpCustomConnector()]));

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("Start a new Agent Run");
    expect(outputText(consoleLog)).not.toContain("Acme MCP");
  });

  it("does not apply the 256-item runtime-sync batch as a membership limit", async () => {
    const ids = Array.from({ length: 257 }, (_, index) => {
      return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    });
    vi.stubEnv("ZERO_CUSTOM_CONNECTOR_IDS", JSON.stringify(ids));
    server.use(
      stubCustomConnectors([
        mcpCustomConnector({ id: ids[256], slug: "_after-batch" }),
      ]),
    );

    await zeroMcpCommand.parseAsync(["node", "zero", "list", "--json"]);

    expect(outputText(consoleLog)).toContain("_after-batch");
  });

  it("discovers modern tools page by page with exact intent and cleanup", async () => {
    const searchTool = {
      name: "search",
      description: "Search documents",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    } satisfies Tool;
    const fetchTool = {
      name: "fetch",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    } satisfies Tool;
    const tools = [searchTool, fetchTool];
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [[searchTool], [fetchTool]],
    });

    await zeroMcpCommand.parseAsync([
      "node",
      "zero",
      "list-tools",
      "_acme-mcp",
      "--json",
    ]);

    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({ connectorSlug: "_acme-mcp", tools }),
    );
    expect(
      seen.map((request) => {
        return request.method ?? request.httpMethod;
      }),
    ).toEqual(["server/discover", "tools/list", "tools/list"]);
    expect(seen[2]?.params).toMatchObject({ cursor: "1" });
    expect(
      seen.every((request) => {
        return request.intent === CONNECTOR_ID;
      }),
    ).toBe(true);
  });

  it("falls back to the 2025 handshake and calls the exact tool once", async () => {
    const tool = {
      name: "search",
      description: "Search documents",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    } satisfies Tool;
    const callResult = {
      content: [{ type: "text", text: "one result" }],
    } satisfies CallToolResult;
    stubConnectorList();
    const seen = stubMcpServer({
      era: "legacy",
      pages: [[tool]],
      callResult,
    });

    await zeroMcpCommand.parseAsync([
      "node",
      "zero",
      "call",
      "_acme-mcp",
      "search",
      "--input",
      '{"query":"vm0"}',
      "--json",
    ]);

    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(callResult));
    expect(
      seen.map((request) => {
        return request.method ?? request.httpMethod;
      }),
    ).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "DELETE",
    ]);
    const calls = seen.filter((request) => {
      return request.method === "tools/call";
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      name: "search",
      arguments: { query: "vm0" },
    });
    expect(
      seen.every((request) => {
        return request.intent === CONNECTOR_ID;
      }),
    ).toBe(true);
  });

  it("reads call input from a file without exposing its contents", async () => {
    const inputPath = join(inputDirectory, "input.json");
    await writeFile(inputPath, '{"query":"from-file"}', "utf8");
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    await zeroMcpCommand.parseAsync([
      "node",
      "zero",
      "call",
      "_acme-mcp",
      "search",
      "--input-file",
      inputPath,
      "--json",
    ]);

    const call = seen.find((request) => {
      return request.method === "tools/call";
    });
    expect(call?.params).toMatchObject({
      arguments: { query: "from-file" },
    });
  });

  it("reads call input from piped stdin", async () => {
    const stdinIterator = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(async function* (): AsyncGenerator<
        Buffer,
        undefined,
        unknown
      > {
        yield Buffer.from('{"query":"from-stdin"}');
        return undefined;
      });
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    try {
      await zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "search",
        "--json",
      ]);
    } finally {
      stdinIterator.mockRestore();
    }

    const call = seen.find((request) => {
      return request.method === "tools/call";
    });
    expect(call?.params).toMatchObject({
      arguments: { query: "from-stdin" },
    });
  });

  it("rejects invalid JSON before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "{",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      "MCP tool input must be valid JSON",
    );
  });

  it("rejects non-object JSON before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "[]",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      "MCP tool input must be a JSON object",
    );
  });

  it("does not retry a failed tool call or expose its upstream body", async () => {
    const upstreamSecret = "upstream-secret-value";
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "side-effect",
            inputSchema: { type: "object" },
          },
        ],
      ],
      callResponse: () => {
        return HttpResponse.text(upstreamSecret, { status: 500 });
      },
    });

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "side-effect",
        "--input",
        "{}",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(
      seen.filter((request) => {
        return request.method === "tools/call";
      }),
    ).toHaveLength(1);
    const errors = outputText(consoleError);
    expect(errors).toContain("MCP server request failed");
    expect(errors).not.toContain(upstreamSecret);
    expect(errors).not.toContain("Error POSTing");
  });

  it("rejects an unknown tool without sending tools/call", async () => {
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "missing",
        "--input",
        "{}",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(
      seen.filter((request) => {
        return request.method === "tools/call";
      }),
    ).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      'MCP tool "missing" was not found',
    );
  });

  it("refuses MCP endpoint redirects", async () => {
    stubConnectorList();
    server.use(
      http.post(MCP_ENDPOINT, () => {
        return HttpResponse.redirect(
          "https://redirected.example.test/server",
          307,
        );
      }),
    );

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("MCP server request failed");
  });

  it("treats an empty fixed run set as an ordinary empty result", async () => {
    vi.stubEnv("ZERO_CUSTOM_CONNECTOR_IDS", "[]");
    server.use(stubCustomConnectors([mcpCustomConnector()]));

    await zeroMcpCommand.parseAsync(["node", "zero", "list", "--json"]);

    expect(consoleLog).toHaveBeenCalledWith('{"connectors":[]}');
  });

  it("rejects an unknown slug before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "list-tools",
        "_not-admitted",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      'MCP connector "_not-admitted" is not available in this run',
    );
  });

  it("rejects tool input above 1 MiB before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });
    const oversizedInput = JSON.stringify({
      value: "x".repeat(1024 * 1024),
    });

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        oversizedInput,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain("exceeds the 1 MiB limit");
    expect(outputText(consoleError)).not.toContain("xxxx");
  });

  it("returns tool-level MCP errors without retrying", async () => {
    const toolError = {
      content: [{ type: "text", text: "invalid query" }],
      isError: true,
    } satisfies CallToolResult;
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
      callResult: toolError,
    });

    await zeroMcpCommand.parseAsync([
      "node",
      "zero",
      "call",
      "_acme-mcp",
      "search",
      "--input",
      "{}",
      "--json",
    ]);

    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(toolError));
    expect(
      seen.filter((request) => {
        return request.method === "tools/call";
      }),
    ).toHaveLength(1);
  });

  it("warns instead of failing after a successful call whose legacy cleanup fails", async () => {
    stubConnectorList();
    stubMcpServer({
      era: "legacy",
      pages: [
        [
          {
            name: "side-effect",
            inputSchema: { type: "object" },
          },
        ],
      ],
      deleteResponse: () => {
        return HttpResponse.text("cleanup failed", { status: 500 });
      },
    });

    await zeroMcpCommand.parseAsync([
      "node",
      "zero",
      "call",
      "_acme-mcp",
      "side-effect",
      "--input",
      "{}",
      "--json",
    ]);

    expect(exit).not.toHaveBeenCalled();
    expect(outputText(consoleLog)).toContain("tool completed");
    const errors = outputText(consoleError);
    expect(errors).toContain("MCP session cleanup did not complete");
    expect(errors).not.toContain("cleanup failed");
  });

  it("preserves the primary failure when cleanup reaches the deadline", async () => {
    stubConnectorList();
    stubMcpServer({
      era: "legacy",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
      deleteResponse: async () => {
        await delay(2_000);
        return new HttpResponse(null, { status: 204 });
      },
    });

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "missing",
        "--input",
        "{}",
        "--timeout",
        "1s",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = outputText(consoleError);
    expect(errors).toContain('MCP tool "missing" was not found');
    expect(errors).not.toContain("timed out");
  });

  it("rejects repeated pagination cursors", async () => {
    let listRequests = 0;
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      listResponse: (requestId) => {
        listRequests++;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: requestId,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [],
            nextCursor: "same-cursor",
          },
        });
      },
    });

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(listRequests).toBe(2);
    expect(outputText(consoleError)).toContain("repeated a tool page cursor");
  });

  it("rejects discovery above 2,000 tools", async () => {
    const tools = Array.from({ length: 2_001 }, (_, index) => {
      return {
        name: `tool-${index}`,
        inputSchema: { type: "object" as const },
      } satisfies Tool;
    });
    stubConnectorList();
    stubMcpServer({ era: "modern", pages: [tools] });

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("2,000 tool limit");
  });

  it("rejects discovery above 100 pages", async () => {
    let listRequests = 0;
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      listResponse: (requestId) => {
        listRequests++;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: requestId,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [],
            nextCursor: `cursor-${listRequests}`,
          },
        });
      },
    });

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(listRequests).toBe(100);
    expect(outputText(consoleError)).toContain("100 page limit");
  });

  it("rejects aggregate discovery above 16 MiB", async () => {
    const largeDescription = "d".repeat(8 * 1024 * 1024);
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "first",
            description: largeDescription,
            inputSchema: { type: "object" },
          },
        ],
        [
          {
            name: "second",
            description: largeDescription,
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("16 MiB aggregate limit");
    expect(outputText(consoleError)).not.toContain("dddd");
  });

  it("rejects an oversized streamed response without buffering it", async () => {
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      listResponse: () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            controller.close();
          },
        });
        return new HttpResponse(body, {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      zeroMcpCommand.parseAsync(["node", "zero", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain(
      "MCP response exceeds the 16 MiB limit",
    );
  });

  it("uses one overall deadline", async () => {
    stubConnectorList();
    server.use(
      http.post(MCP_ENDPOINT, async () => {
        await delay(2_000);
        return HttpResponse.json({});
      }),
    );

    await expect(
      zeroMcpCommand.parseAsync([
        "node",
        "zero",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "{}",
        "--timeout",
        "1s",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("timed out after 1s");
  });
});
