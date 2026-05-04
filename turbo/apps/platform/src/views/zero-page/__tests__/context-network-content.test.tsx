import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  type RunContextResponse,
  zeroRunAgentEventsContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

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
    runId: "run-test-id",
    sessionId: null,
    secretNames: [],
    vars: null,
    environment: {},
    firewalls: [],
    volumes: [],
    artifact: null,
    networkPolicies: null,
    featureFlags: null,
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
    mockApi(logsByIdContract.getById, ({ params, respond }) => {
      if (params.id === LOG_ID) {
        return respond(200, makeLogDetail());
      }
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }),
    mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, makeEventsResponse());
    }),
  );

  if (options.contextResponse !== undefined) {
    server.use(
      mockApi(zeroRunContextContract.getContext, ({ respond }) => {
        if (options.contextResponse === null) {
          return respond(404, {
            error: { message: "Not found", code: "NOT_FOUND" },
          });
        }
        return respond(200, options.contextResponse!);
      }),
    );
  }

  if (options.networkResponse !== undefined) {
    server.use(
      mockApi(zeroRunNetworkLogsContract.getNetworkLogs, ({ respond }) => {
        if (options.networkResponse === null) {
          return respond(404, {
            error: { message: "Not found", code: "NOT_FOUND" },
          });
        }
        return respond(200, options.networkResponse!);
      }),
    );
  }
}

async function setupAndNavigateToTab(tabName: "Context" | "Network") {
  detachedSetupPage({
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
  click(tab);
}

function getTypeFilterButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Type filter"]',
  );
  expect(button).toBeTruthy();
  return button!;
}

function getMenuCheckbox(label: string): HTMLElement {
  const item = screen.getAllByRole("menuitemcheckbox").find((el) => {
    return el.textContent?.trim() === label;
  });
  expect(item).toBeTruthy();
  return item!;
}

function queryMenuCheckbox(label: string): HTMLElement | undefined {
  return screen.getAllByRole("menuitemcheckbox").find((el) => {
    return el.textContent?.trim() === label;
  });
}

async function openNetworkTypeFilter() {
  const trigger = await waitFor(() => {
    return getTypeFilterButton();
  });
  click(trigger);
  await waitFor(() => {
    expect(getMenuCheckbox("HTTP")).toBeInTheDocument();
  });
}

function getAllTypesMenuItem(): HTMLElement {
  const item = screen.getAllByRole("menuitemcheckbox").find((el) => {
    return el.textContent?.trim() === "All types";
  });
  expect(item).toBeTruthy();
  return item!;
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

  it("should render session id when present (ACT-C-002c)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({
        sessionId: "sess-abc-123",
      }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Session", level: 3 }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("sess-abc-123")).toBeInTheDocument();
  });

  it("should not render session id when null (ACT-C-002d)", async () => {
    setupMocks({
      contextResponse: makeBaseContext({ sessionId: null }),
    });

    await setupAndNavigateToTab("Context");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Prompt", level: 3 }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Session", level: 3 }),
    ).not.toBeInTheDocument();
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
        return el.textContent?.trim() === "Permission";
      }),
    ).toBeDefined();

    // Default filter shows HTTP only.
    expect(screen.queryByText("db.internal:5432")).not.toBeInTheDocument();

    await openNetworkTypeFilter();
    click(getMenuCheckbox("TCP"));

    // TCP entry renders host:port when selected.
    await waitFor(() => {
      expect(screen.getByText("db.internal:5432")).toBeInTheDocument();
    });
  });

  it("should default network type filter to HTTP", async () => {
    const httpEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      type: "http",
      url: "https://api.example.com/data",
    });
    const dnsEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:06Z",
      type: "dns",
      action: undefined,
      method: undefined,
      url: undefined,
      status: undefined,
      host: "api.example.com",
      port: 53,
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [httpEntry, dnsEntry],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://api.example.com/data"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("api.example.com:53")).not.toBeInTheDocument();

    await openNetworkTypeFilter();
    expect(getAllTypesMenuItem()).toHaveAttribute("aria-checked", "false");
    expect(getMenuCheckbox("HTTP")).toHaveAttribute("aria-checked", "true");
    expect(getMenuCheckbox("DNS")).toHaveAttribute("aria-checked", "false");
  });

  it("should treat blank network log type as HTTP", async () => {
    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [
          makeNetworkEntry({
            type: "",
            url: "https://blank-type.example.com/data",
          }),
        ],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://blank-type.example.com/data"),
      ).toBeInTheDocument();
    });

    await openNetworkTypeFilter();
    expect(getMenuCheckbox("HTTP")).toHaveAttribute("aria-checked", "true");
  });

  it("should support multiple selected network type filters", async () => {
    const httpEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      type: "http",
      url: "https://api.example.com/data",
    });
    const dnsEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:06Z",
      type: "dns",
      action: undefined,
      method: undefined,
      url: undefined,
      status: undefined,
      host: "api.example.com",
      port: 53,
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [httpEntry, dnsEntry],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://api.example.com/data"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("api.example.com:53")).not.toBeInTheDocument();

    await openNetworkTypeFilter();
    click(getMenuCheckbox("DNS"));

    await waitFor(() => {
      expect(screen.getByText("api.example.com:53")).toBeInTheDocument();
    });
    expect(
      screen.getByText("https://api.example.com/data"),
    ).toBeInTheDocument();

    click(getMenuCheckbox("HTTP"));

    await waitFor(() => {
      expect(
        screen.queryByText("https://api.example.com/data"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("api.example.com:53")).toBeInTheDocument();
  });

  it("should keep load more visible when current loaded results do not match the type filter", async () => {
    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [
          makeNetworkEntry({
            timestamp: "2026-03-10T14:56:06Z",
            type: "dns",
            action: undefined,
            method: undefined,
            url: undefined,
            status: undefined,
            host: "api.example.com",
            port: 53,
          }),
        ],
        hasMore: true,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("No matching logs in loaded results"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Load more")).toBeInTheDocument();
  });

  it("should include newly loaded types while all network types are selected", async () => {
    let requestCount = 0;
    server.use(
      mockApi(logsByIdContract.getById, ({ params, respond }) => {
        if (params.id === LOG_ID) {
          return respond(200, makeLogDetail());
        }
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
      mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
        return respond(200, makeEventsResponse());
      }),
      mockApi(zeroRunNetworkLogsContract.getNetworkLogs, ({ respond }) => {
        requestCount++;
        if (requestCount === 1) {
          return respond(200, {
            networkLogs: [
              makeNetworkEntry({
                type: "http",
                url: "https://api.example.com/data",
                timestamp: "2026-03-10T14:56:05Z",
              }),
              makeNetworkEntry({
                type: "dns",
                action: undefined,
                method: undefined,
                url: undefined,
                status: undefined,
                host: "api.example.com",
                port: 53,
                timestamp: "2026-03-10T14:56:06Z",
              }),
            ],
            hasMore: true,
          });
        }
        return respond(200, {
          networkLogs: [
            makeNetworkEntry({
              type: "udp",
              action: undefined,
              method: undefined,
              url: undefined,
              status: undefined,
              host: "ntp.example.com",
              port: 123,
              timestamp: "2026-03-10T14:56:07Z",
            }),
          ],
          hasMore: false,
        });
      }),
    );

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://api.example.com/data"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("api.example.com:53")).not.toBeInTheDocument();

    await openNetworkTypeFilter();
    click(getAllTypesMenuItem());
    await waitFor(() => {
      expect(getTypeFilterButton().textContent).toContain("All types");
    });

    click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(screen.getByText("ntp.example.com:123")).toBeInTheDocument();
    });
  });

  it("should filter network log entries by type", async () => {
    const httpEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      type: "http",
      url: "https://api.example.com/data",
    });
    const dnsEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:06Z",
      type: "dns",
      action: undefined,
      method: undefined,
      url: undefined,
      status: undefined,
      latency_ms: undefined,
      request_size: undefined,
      response_size: undefined,
      firewall_name: undefined,
      host: "api.example.com",
      port: 53,
      dns_event: "reply",
      dns_result: "93.184.216.34",
      dns_serial: "42",
    });
    const deniedHttpEntry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:07Z",
      type: "http",
      action: "DENY",
      url: "https://blocked.example.com/data",
      status: undefined,
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [httpEntry, dnsEntry, deniedHttpEntry],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://api.example.com/data"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("api.example.com:53")).not.toBeInTheDocument();
    expect(
      screen.getByText("https://blocked.example.com/data"),
    ).toBeInTheDocument();
    expect(screen.queryByText("DENY")).not.toBeInTheDocument();

    await openNetworkTypeFilter();
    expect(queryMenuCheckbox("DENY")).toBeUndefined();
    click(getMenuCheckbox("DNS"));

    await waitFor(() => {
      expect(screen.getByText("api.example.com:53")).toBeInTheDocument();
    });
    expect(
      screen.getByText("https://api.example.com/data"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("https://blocked.example.com/data"),
    ).toBeInTheDocument();
    const httpBadges = screen.getAllByText("HTTP");
    expect(
      httpBadges.some((badge) => {
        return badge.className.includes("line-through");
      }),
    ).toBeTruthy();
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

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://detail.example.com/path"),
      ).toBeInTheDocument();
    });

    // Click the row to expand
    click(screen.getByText("https://detail.example.com/path").closest("tr")!);

    // Detail fields should now be visible
    await waitFor(() => {
      // The expanded detail shows labels like "URL", "Permission" etc.
      const urlLabels = screen.getAllByText("URL");
      // There should be the header column AND the detail label
      expect(urlLabels.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("should render DNS result fields in expanded details", async () => {
    const entry = makeNetworkEntry({
      timestamp: "2026-03-10T14:56:05Z",
      type: "dns",
      action: undefined,
      method: undefined,
      url: undefined,
      status: undefined,
      latency_ms: undefined,
      request_size: undefined,
      response_size: undefined,
      firewall_name: undefined,
      host: "api.github.com",
      port: 53,
      dns_event: "reply",
      dns_result: "140.82.121.4",
      dns_serial: "42",
    });

    setupMocks({
      contextResponse: null,
      networkResponse: {
        networkLogs: [entry],
        hasMore: false,
      },
    });

    await setupAndNavigateToTab("Network");

    expect(screen.queryByText("api.github.com:53")).not.toBeInTheDocument();
    await openNetworkTypeFilter();
    click(getMenuCheckbox("DNS"));

    await waitFor(() => {
      expect(screen.getByText("api.github.com:53")).toBeInTheDocument();
    });

    click(screen.getByText("api.github.com:53").closest("tr")!);

    await waitFor(() => {
      expect(screen.getByText("DNS Event")).toBeInTheDocument();
    });
    expect(screen.getByText("reply")).toBeInTheDocument();
    expect(screen.getByText("DNS Result")).toBeInTheDocument();
    expect(screen.getByText("140.82.121.4")).toBeInTheDocument();
    expect(screen.getByText("DNS Serial")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
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

    await setupAndNavigateToTab("Network");

    await waitFor(() => {
      expect(
        screen.getByText("https://toggle.example.com"),
      ).toBeInTheDocument();
    });

    const row = screen.getByText("https://toggle.example.com").closest("tr")!;

    // Click to expand
    click(row);

    await waitFor(() => {
      // Detail row shows Timestamp label
      expect(screen.getByText("Timestamp")).toBeInTheDocument();
    });

    // Click to collapse
    click(row);

    await waitFor(() => {
      // "Timestamp" as a detail label should no longer be visible
      // (the header "Time" remains, but "Timestamp" is only in the detail)
      expect(screen.queryByText("Timestamp")).not.toBeInTheDocument();
    });
  });

  it("should show Load more button and append next page on click (ACT-N-007)", async () => {
    let requestCount = 0;
    server.use(
      mockApi(logsByIdContract.getById, ({ params, respond }) => {
        if (params.id === LOG_ID) {
          return respond(200, makeLogDetail());
        }
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
      mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
        return respond(200, makeEventsResponse());
      }),
      mockApi(zeroRunNetworkLogsContract.getNetworkLogs, ({ respond }) => {
        requestCount++;
        if (requestCount === 1) {
          return respond(200, {
            networkLogs: [
              makeNetworkEntry({
                url: "https://page1.example.com",
                timestamp: "2026-03-10T14:56:05Z",
              }),
            ],
            hasMore: true,
          });
        }
        return respond(200, {
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

    await setupAndNavigateToTab("Network");

    // First page renders
    await waitFor(() => {
      expect(screen.getByText("https://page1.example.com")).toBeInTheDocument();
    });

    // "Load more" button visible
    const loadMoreButton = screen.getByText("Load more");
    expect(loadMoreButton).toBeInTheDocument();

    // Click to load next page
    click(loadMoreButton);

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
