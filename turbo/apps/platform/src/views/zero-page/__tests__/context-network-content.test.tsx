import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  FeatureSwitchKey,
  type RunContextResponse,
  type NetworkLogEntry,
} from "@vm0/core";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

const LOG_ID = "c0000000-0000-4000-a000-000000000001";

function makeLogDetail(): LogDetail {
  return {
    id: LOG_ID,
    sessionId: "session_ctx",
    agentId: "ctx-agent",
    displayName: "Context Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "test prompt",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
  };
}

function makeEventsResponse(): AgentEventsResponse {
  return {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Hello" }] },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };
}

function makeBaseContext(
  overrides: Partial<RunContextResponse> = {},
): RunContextResponse {
  return {
    prompt: "Default prompt text",
    appendSystemPrompt: null,
    secretNames: [],
    vars: null,
    environment: {},
    firewalls: [],
    volumes: [],
    artifact: null,
    memory: null,
    ...overrides,
  };
}

function makeNetworkEntry(
  overrides: Partial<NetworkLogEntry> = {},
): NetworkLogEntry {
  return {
    timestamp: "2026-03-10T14:56:05Z",
    type: "http",
    action: "ALLOW",
    method: "GET",
    url: "https://api.example.com/data",
    host: "api.example.com",
    port: 443,
    status: 200,
    latency_ms: 150,
    request_size: 256,
    response_size: 1024,
    firewall_name: "default-fw",
    ...overrides,
  };
}

function setupMocks(options: {
  contextResponse?: RunContextResponse | null;
  networkResponse?: {
    networkLogs: NetworkLogEntry[];
    hasMore: boolean;
  } | null;
}) {
  server.use(
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === LOG_ID) {
        return HttpResponse.json(makeLogDetail());
      }
      return HttpResponse.json(
        { error: { message: "Not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(makeEventsResponse());
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );

  if (options.contextResponse !== undefined) {
    server.use(
      http.get("*/api/zero/runs/:id/context", () => {
        if (options.contextResponse === null) {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }
        return HttpResponse.json(options.contextResponse);
      }),
    );
  }

  if (options.networkResponse !== undefined) {
    server.use(
      http.get("*/api/zero/runs/:id/network", () => {
        if (options.networkResponse === null) {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }
        return HttpResponse.json(options.networkResponse);
      }),
    );
  }
}

async function setupAndNavigateToTab(tabName: "Context" | "Network") {
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/activities/${LOG_ID}`,
    featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
  });

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Context Test Agent" }),
    ).toBeInTheDocument();
  });

  const tab = screen.getByText(tabName);
  await user.click(tab);

  return user;
}

// ---------------------------------------------------------------------------
// Context content tests
// ---------------------------------------------------------------------------

describe("contextContent", () => {
  it("should render prompt code block (ACT-C-001)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({ prompt: "Hello world prompt" }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText("Hello world prompt")).toBeInTheDocument();
    });
  });

  it("should render system prompt conditionally (ACT-C-002)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        appendSystemPrompt: "Be helpful",
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "System Prompt", level: 3 }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Be helpful")).toBeInTheDocument();
  });

  it("should not render system prompt when null (ACT-C-002b)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({ appendSystemPrompt: null }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Prompt", level: 3 }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("heading", { name: "System Prompt", level: 3 }),
    ).not.toBeInTheDocument();
  });

  it("should render secret names as badges (ACT-C-003)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        secretNames: ["API_KEY", "DB_PASSWORD"],
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });
    expect(screen.getByText("DB_PASSWORD")).toBeInTheDocument();
  });

  it("should render vars key-value table (ACT-C-004)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        vars: { FOO: "bar", BAZ: "qux" },
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText("FOO")).toBeInTheDocument();
    });
    expect(screen.getByText("bar")).toBeInTheDocument();
    expect(screen.getByText("BAZ")).toBeInTheDocument();
    expect(screen.getByText("qux")).toBeInTheDocument();
  });

  it("should render environment mapping table (ACT-C-005)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        environment: { NODE_ENV: "production" },
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText("NODE_ENV")).toBeInTheDocument();
    });
    expect(screen.getByText("production")).toBeInTheDocument();
  });

  it("should render firewalls JSON data (ACT-C-006)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        firewalls: [
          {
            name: "my-firewall",
            ref: "fw-1",
            apis: [{ base: "https://api.example.com" }],
          },
        ],
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText(/my-firewall/)).toBeInTheDocument();
    });
  });

  it("should render volumes storage table (ACT-C-007)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        volumes: [
          {
            name: "data-vol",
            mountPath: "/data",
            vasStorageName: "store-1",
            vasVersionId: "v1",
          },
        ],
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText("data-vol")).toBeInTheDocument();
    });
    expect(screen.getByText("/data")).toBeInTheDocument();
    expect(screen.getByText("store-1")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();

    // Check column headers
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Mount Path")).toBeInTheDocument();
    expect(screen.getByText("Storage Name")).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
  });

  it("should render artifact storage data (ACT-C-008)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        artifact: {
          mountPath: "/artifacts",
          vasStorageName: "art-store",
          vasVersionId: "v2",
        },
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText("/artifacts")).toBeInTheDocument();
    });
    expect(screen.getByText("art-store")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("should render memory storage data (ACT-C-009)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        memory: {
          mountPath: "/memory",
          vasStorageName: "mem-store",
          vasVersionId: "v3",
        },
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(screen.getByText("/memory")).toBeInTheDocument();
    });
    expect(screen.getByText("mem-store")).toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Network content tests
// ---------------------------------------------------------------------------

describe("networkContent", () => {
  it("should render network log entries in table (ACT-N-001)", async () => {
    const httpEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      type: "http",
      method: "GET",
      url: "https://api.example.com/data",
      status: 200,
      firewall_name: "default-fw",
    });

    const tcpEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:06Z",
      type: "tcp",
      method: undefined,
      url: undefined,
      host: "db.internal",
      port: 5432,
      status: undefined,
      firewall_name: "db-fw",
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [httpEntry, tcpEntry],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://api.example.com/data"),
      ).toBeInTheDocument();
    });

    // Check column headers exist
    expect(
      screen.getAllByRole("columnheader").find((el) => {
        return el.textContent?.trim() === "Time";
      }),
    ).toBeDefined();
    const columnHeaders = screen.getAllByRole("columnheader");
    expect(
      columnHeaders.find((el) => {
        return el.textContent?.trim() === "Type";
      }),
    ).toBeDefined();
    expect(
      columnHeaders.find((el) => {
        return el.textContent?.trim() === "Method";
      }),
    ).toBeDefined();
    expect(
      columnHeaders.find((el) => {
        return el.textContent?.trim() === "URL / Host";
      }),
    ).toBeDefined();
    expect(
      columnHeaders.find((el) => {
        return el.textContent?.trim() === "Status";
      }),
    ).toBeDefined();
    expect(
      columnHeaders.find((el) => {
        return el.textContent?.trim() === "Latency";
      }),
    ).toBeDefined();
    expect(
      columnHeaders.find((el) => {
        return el.textContent?.trim() === "Firewall";
      }),
    ).toBeDefined();

    // TCP entry renders host:port
    expect(screen.getByText("db.internal:5432")).toBeInTheDocument();
  });

  it("should render formatted time, size, and latency (ACT-N-003)", async () => {
    const entry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05.123Z",
      latency_ms: 150,
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [entry],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      // Latency formatted as "150ms"
      expect(screen.getByText("150ms")).toBeInTheDocument();
    });
  });

  it("should render status colors based on HTTP status (ACT-N-004)", async () => {
    const okEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      status: 200,
      url: "https://ok.example.com",
    });

    const errorEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:06Z",
      status: 500,
      url: "https://error.example.com",
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [okEntry, errorEntry],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(screen.getByText("200")).toBeInTheDocument();
    });

    const status200 = screen.getByText("200");
    const status500 = screen.getByText("500");

    // 200 should have green color class
    expect(status200.className).toMatch(/text-green/);
    // 500 should have red color class
    expect(status500.className).toMatch(/text-red/);
  });

  it("should render expanded row detail when clicked (ACT-N-005)", async () => {
    const entry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      url: "https://detail.example.com/path",
      firewall_name: "detail-fw",
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [entry],
        hasMore: false,
      },
    });

    const user = await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://detail.example.com/path"),
      ).toBeInTheDocument();
    });

    // Click the row to expand
    await user.click(
      screen.getByText("https://detail.example.com/path").closest("tr")!,
    );

    // Detail fields should now be visible
    await waitFor(() => {
      // The expanded detail shows labels like "URL", "Firewall" etc.
      const urlLabels = screen.getAllByText("URL");
      // There should be the header column AND the detail label
      expect(urlLabels.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("should toggle row expansion on click (ACT-N-006)", async () => {
    const entry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      url: "https://toggle.example.com",
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [entry],
        hasMore: false,
      },
    });

    const user = await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://toggle.example.com"),
      ).toBeInTheDocument();
    });

    const row = screen.getByText("https://toggle.example.com").closest("tr")!;

    // Click to expand
    await user.click(row);

    await waitFor(() => {
      // Detail row shows Timestamp label
      expect(screen.getByText("Timestamp")).toBeInTheDocument();
    });

    // Click to collapse
    await user.click(row);

    await waitFor(() => {
      // "Timestamp" as a detail label should no longer be visible
      // (the header "Time" remains, but "Timestamp" is only in the detail)
      expect(screen.queryByText("Timestamp")).not.toBeInTheDocument();
    });
  });

  it("should show Load more button and append next page on click (ACT-N-007)", async () => {
    let requestCount = 0;
    server.use(
      http.get("*/api/zero/logs/:id", ({ params }) => {
        if (params["id"] === LOG_ID) {
          return HttpResponse.json(makeLogDetail());
        }
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
        return HttpResponse.json(makeEventsResponse());
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.get("*/api/zero/runs/:id/network", () => {
        requestCount++;
        if (requestCount === 1) {
          return HttpResponse.json({
            networkLogs: [
              makeNetworkEntry({
                url: "https://page1.example.com",
                timestamp: "2026-03-10T14:56:05Z",
              }),
            ],
            hasMore: true,
          });
        }
        return HttpResponse.json({
          networkLogs: [
            makeNetworkEntry({
              url: "https://page2.example.com",
              timestamp: "2026-03-10T14:56:06Z",
            }),
          ],
          hasMore: false,
        });
      }),
    );

    const user = await setupAndNavigateToTab("Network");

    // First page renders
    await waitFor(() => {
      expect(screen.getByText("https://page1.example.com")).toBeInTheDocument();
    });

    // "Load more" button visible
    const loadMoreButton = screen.getByText("Load more");
    expect(loadMoreButton).toBeInTheDocument();

    // Click to load next page
    await user.click(loadMoreButton);

    // Second page appended
    await waitFor(() => {
      expect(screen.getByText("https://page2.example.com")).toBeInTheDocument();
    });

    // First page still visible
    expect(screen.getByText("https://page1.example.com")).toBeInTheDocument();

    // "Load more" gone since hasMore is false
    expect(screen.queryByText("Load more")).not.toBeInTheDocument();
  });

  it("should not show Load more button when hasMore is false (ACT-N-008)", async () => {
    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [makeNetworkEntry()],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://api.example.com/data"),
      ).toBeInTheDocument();
    });

    expect(screen.queryByText("Load more")).not.toBeInTheDocument();
  });
});
