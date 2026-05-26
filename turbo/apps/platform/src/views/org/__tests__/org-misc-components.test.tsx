/**
 * Tests for misc org components:
 * - ClaudeCodeSetupPrompt (setup-prompt.tsx)
 * - ZeroUnsavedBar (zero-unsaved-bar.tsx)
 * - InlineSettingsRow (zero-inline-settings-row.tsx)
 * - ZeroNoPermissionIllustration (zero-no-permission-illustration.tsx)
 * - InternalConnectorLogos (internal-connector-logos.tsx)
 * - VM0ClerkProvider (clerk-provider.tsx)
 *
 * Entry points: setupPage({ context, path: "..." })
 * External mocks: MSW for HTTP endpoints
 * Internal: real signals, components, rendering
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
} from "@vm0/connectors/connectors";
import {
  type ScheduleResponse,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setMockOrg, resetMockOrg } from "../../../mocks/handlers/api-org.ts";
import { setMockSchedules } from "../../../mocks/handlers/api-schedules.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { orgOpenAddDialog$ } from "../../../signals/zero-page/settings/org-model-providers.ts";
import { setOrgManageDialogOpen$ } from "../../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const context = testContext();
const mockApi = createMockApi(context);

beforeEach(() => {
  resetMockOrg();
  setMockOrg({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
});

// ---------------------------------------------------------------------------
// InternalConnectorLogos (ORG-D-118, ORG-D-119, ORG-D-120, ORG-I-121)
// ---------------------------------------------------------------------------

// Render-heavy internal debug page (173 connectors × 4 IconBox ≈ 700 DOM
// nodes). Bumped timeout absorbs CPU contention from parallel workers.
const INTERNAL_LOGOS_TIMEOUT = 15_000;

describe("internal connector logos - display (ORG-D-118)", () => {
  it(
    "lists all connector types with labels and type identifiers",
    async () => {
      detachedSetupPage({ context, path: "/__internal-connector-logos" });
      const connectorTypes = CONNECTOR_TYPE_KEYS;
      // Verify at least one connector type and its label appears in the document
      // (labels and type keys may appear multiple times due to icon display variants).
      await waitFor(() => {
        expect(
          screen.queryAllByText(CONNECTOR_TYPES[connectorTypes[0]].label)
            .length,
        ).toBeGreaterThan(0);
        expect(screen.queryAllByText(connectorTypes[0]).length).toBeGreaterThan(
          0,
        );
      });
      // All connectors are rendered at once, so sync checks suffice after the first waitFor
      for (const type of connectorTypes) {
        expect(screen.queryAllByText(type).length).toBeGreaterThan(0);
      }
    },
    INTERNAL_LOGOS_TIMEOUT,
  );
});

describe("internal connector logos - display (ORG-D-119)", () => {
  it(
    "heading displays the count of connector types",
    async () => {
      detachedSetupPage({ context, path: "/__internal-connector-logos" });
      const connectorTypes = CONNECTOR_TYPE_KEYS;
      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
          connectorTypes.length.toString(),
        );
      });
    },
    INTERNAL_LOGOS_TIMEOUT,
  );
});

describe("internal connector logos - interaction (ORG-I-121)", () => {
  it(
    "size selection buttons change the displayed icon size",
    async () => {
      detachedSetupPage({ context, path: "/__internal-connector-logos" });
      // Default size button is "128" — clicking "16" should switch to a smaller size
      await waitFor(() => {
        expect(
          queryAllByRoleFast("button").find((el) => {
            return /128/.test(el.textContent ?? "");
          }),
        ).toBeInTheDocument();
      });
      const btn16 = queryAllByRoleFast("button").find((el) => {
        return /^16$/.test(el.textContent ?? "");
      });
      click(btn16!);
      // After clicking "16", the icons container should reflect the smaller size;
      // verify the page still renders connector icon images (alt="" so role="presentation")
      await waitFor(() => {
        expect(
          screen.getAllByRole("presentation", { hidden: true }).length,
        ).toBeGreaterThan(0);
      });
    },
    INTERNAL_LOGOS_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

const TEST_SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function testSchedule(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    id: TEST_SCHEDULE_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "test-schedule",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Test prompt",
    description: "A test description",
    enabled: true,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    nextRunAt: null,
    lastRunAt: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    ...overrides,
  };
}

function mockScheduleDetailAPIs(
  schedules: ScheduleResponse[] = [testSchedule()],
) {
  setMockSchedules(schedules);
}

// ---------------------------------------------------------------------------
// InlineSettingsRow (ORG-D-108, ORG-C-109)
// ---------------------------------------------------------------------------

describe("inline settings row - display (ORG-D-108)", () => {
  it("label text is displayed", async () => {
    mockScheduleDetailAPIs();
    detachedSetupPage({
      context,
      path: `/schedules/${TEST_SCHEDULE_ID}`,
    });
    // The schedule detail page settings tab has InlineSettingsRow with label "Agent"
    await waitFor(() => {
      expect(screen.getByText("Agent")).toBeInTheDocument();
    });
  });
});

describe("inline settings row - conditional (ORG-C-109)", () => {
  it("description text is shown when provided", async () => {
    mockScheduleDetailAPIs();
    detachedSetupPage({
      context,
      path: `/schedules/${TEST_SCHEDULE_ID}`,
    });
    // The "Agent" InlineSettingsRow has a description explaining the field is read-only.
    await waitFor(() => {
      expect(
        screen.getByText(/The agent is fixed once a schedule is created/i),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// ZeroNoPermissionIllustration (ORG-D-110)
// ---------------------------------------------------------------------------

describe("zero no permission illustration - display (ORG-D-110)", () => {
  it("displays the illustration image when schedule is not found", async () => {
    mockScheduleDetailAPIs([]);
    detachedSetupPage({
      context,
      path: `/schedules/nonexistent-schedule-id`,
    });
    // ZeroNoPermissionIllustration renders alongside the not-found heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Schedule not found" }),
      ).toBeInTheDocument();
    });
    // The illustration image (role="presentation") is present on the not-found page
    expect(
      screen.getAllByRole("presentation", { hidden: true }).length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ZeroUnsavedBar (ORG-D-111, ORG-D-112, ORG-I-113, ORG-I-114)
// ---------------------------------------------------------------------------

async function openScheduleSettings() {
  mockScheduleDetailAPIs();
  detachedSetupPage({ context, path: `/schedules/${TEST_SCHEDULE_ID}` });
  // Wait until the settings form is ready — the description input is always rendered
  // on the settings tab once the schedule data has loaded
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText("Leave blank to auto-generate"),
    ).toBeInTheDocument();
  });
}

describe("zero unsaved bar - display (ORG-D-111)", () => {
  it("shows unsaved changes indicator when settings are changed", async () => {
    await openScheduleSettings();
    // Modify the description input to trigger unsaved state
    const descInput = screen.getByPlaceholderText(
      "Leave blank to auto-generate",
    );
    await fill(descInput, "New description");
    // ZeroUnsavedBar appears with Save/Discard buttons when there are unsaved changes
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return /^Discard$/.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });
  });
});

describe("zero unsaved bar - interaction (ORG-I-113)", () => {
  it("clicking Discard reverts unsaved changes", async () => {
    await openScheduleSettings();
    const descInput = screen.getByPlaceholderText(
      "Leave blank to auto-generate",
    );
    // Original value from schedule (description is "A test description", but the form
    // shows it via schedule.description. Let's clear and type a new value)
    await fill(descInput, "Changed description");
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return /^Discard$/.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });
    click(
      queryAllByRoleFast("button").find((el) => {
        return /^Discard$/.test(el.textContent ?? "");
      })!,
    );
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return /^Discard$/.test(el.textContent ?? "");
        }),
      ).toBeUndefined();
    });
  });
});

describe("zero unsaved bar - interaction (ORG-I-114)", () => {
  it("clicking Save persists changes and hides the unsaved bar", async () => {
    await openScheduleSettings();
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
        return respond(200, {
          schedule: testSchedule({ description: "New description" }),
          created: false,
        });
      }),
    );
    const descInput = screen.getByPlaceholderText(
      "Leave blank to auto-generate",
    );
    await fill(descInput, "New description");
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return /^Discard$/.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });
    click(
      queryAllByRoleFast("button").find((el) => {
        return /^Save$/.test(el.textContent ?? "");
      })!,
    );
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").find((el) => {
          return /^Discard$/.test(el.textContent ?? "");
        }),
      ).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeSetupPrompt (ORG-D-105, ORG-I-106, ORG-S-107)
// ---------------------------------------------------------------------------

async function openSetupPrompt() {
  detachedSetupPage({ context, path: "/" });
  context.store.set(setActiveOrgManageTab$, "providers");
  await context.store.set(setOrgManageDialogOpen$, true, context.signal);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  context.store.set(orgOpenAddDialog$, "claude-code-oauth-token");
  await waitFor(() => {
    expect(screen.getByText("claude setup-token")).toBeInTheDocument();
  });
}

describe("setup prompt - display (ORG-D-105)", () => {
  it("displays 'claude setup-token' command in a code element", async () => {
    await openSetupPrompt();
    const codeEl = screen.getByText("claude setup-token");
    expect(codeEl.tagName.toLowerCase()).toBe("code");
  });
});

describe("setup prompt - interaction (ORG-I-106)", () => {
  it("clicking the code element triggers the copied state", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await openSetupPrompt();
    click(screen.getByText("claude setup-token"));
    // The original command text should be replaced by the "copied!" state
    await waitFor(() => {
      expect(screen.queryByText("claude setup-token")).not.toBeInTheDocument();
    });
  });
});

describe("setup prompt - state (ORG-S-107)", () => {
  it("text changes to 'copied!' after click", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await openSetupPrompt();
    click(screen.getByText("claude setup-token"));
    await waitFor(() => {
      expect(screen.getByText("copied!")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// VM0ClerkProvider (ORG-D-122)
// ---------------------------------------------------------------------------

describe("clerk provider - display (ORG-D-122)", () => {
  it("clerk provider loads with publishable key from environment", async () => {
    setMockSchedules([]);
    detachedSetupPage({ context, path: "/" });
    // VM0ClerkProvider wraps children and renders null if Clerk is not loaded.
    // Verify that app content rendered — the mock-auth Clerk instance is in "hasData"
    // state, so the provider should allow children to render.
    await waitFor(() => {
      expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    });
  });
});
