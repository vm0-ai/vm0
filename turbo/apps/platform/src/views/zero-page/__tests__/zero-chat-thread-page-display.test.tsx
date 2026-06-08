import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import { updateChatArtifacts } from "../../../mocks/mock-helpers.ts";
import { search } from "../../../signals/location.ts";
import {
  chatMessagesContract,
  chatThreadArtifactsContract,
  chatThreadGithubPrsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import {
  type UserPermissionGrantExpiresIn,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroConnectorOauthStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import {
  createMockUserPermissionGrantResponse,
  setMockUserPermissionGrants,
} from "../../../mocks/handlers/api-user-permission-grants.ts";
import {
  createDefaultMockGithubIntegration,
  setMockGithubIntegration,
} from "../../../mocks/handlers/api-integrations-github.ts";
import {
  createMockScheduleResponse,
  setMockSchedules,
} from "../../../mocks/handlers/api-schedules.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

function queryRoleByText(
  role: Parameters<typeof queryAllByRoleFast>[0],
  text: string,
): HTMLElement | undefined {
  return queryAllByRoleFast(role).find((element) => {
    return element.textContent?.trim() === text;
  });
}

function getRoleByText(
  role: Parameters<typeof queryAllByRoleFast>[0],
  text: string,
): HTMLElement {
  const element = queryRoleByText(role, text);
  expect(element).toBeDefined();
  return element!;
}

function queryRoleByAriaLabel(
  role: Parameters<typeof queryAllByRoleFast>[0],
  label: string,
): HTMLElement | undefined {
  return queryAllByRoleFast(role).find((element) => {
    return element.getAttribute("aria-label") === label;
  });
}

function getRoleByAriaLabel(
  role: Parameters<typeof queryAllByRoleFast>[0],
  label: string,
): HTMLElement {
  const element = queryRoleByAriaLabel(role, label);
  expect(element).toBeDefined();
  return element!;
}

function mockConnectorOauthStart() {
  server.use(
    mockApi(zeroConnectorOauthStartContract.start, ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    }),
  );
}

function createMockAuthWindow() {
  return { closed: false, close: vi.fn(), location: { href: "" } };
}

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://www.vm0.ai");
  vi.stubEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm7.io");
  server.use(
    http.get("https://example.com/avatar.png", () => {
      return new HttpResponse("avatar", {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
});

describe("zero chat thread page display - schedule menu", () => {
  it("hides the schedule button when no schedules are linked to the thread", async () => {
    const threadId = "d0000000-0000-4000-a000-000000000001";
    let schedulesRequested = false;
    mockChatLifecycle({ threadId });
    server.use(
      mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
        schedulesRequested = true;
        return respond(200, {
          schedules: [
            createMockScheduleResponse({
              id: "e0000000-0000-4000-a000-000000000002",
              name: "other-internal-name",
              description: "Other thread schedule",
              chatThreadId: "d0000000-0000-4000-a000-000000000002",
            }),
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(schedulesRequested).toBeTruthy();
    });
    expect(screen.queryByLabelText("Schedules")).not.toBeInTheDocument();
  });

  it("shows linked schedule titles instead of internal names", async () => {
    const user = userEvent.setup();
    const threadId = "d0000000-0000-4000-a000-000000000001";
    mockChatLifecycle({ threadId });
    setMockSchedules([
      createMockScheduleResponse({
        id: "e0000000-0000-4000-a000-000000000001",
        name: "e0000000-0000-4000-a000-000000000001",
        description: "Daily morning briefing",
        chatThreadId: threadId,
      }),
      createMockScheduleResponse({
        id: "e0000000-0000-4000-a000-000000000002",
        name: "other-internal-name",
        description: "Other thread schedule",
        chatThreadId: "d0000000-0000-4000-a000-000000000002",
      }),
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await user.click(await screen.findByLabelText("Schedules"));

    await waitFor(() => {
      expect(screen.getByText("Daily morning briefing")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("e0000000-0000-4000-a000-000000000001"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Other thread schedule")).not.toBeInTheDocument();
  });

  it("shows linked schedule status sublines from schedule API data", async () => {
    const user = userEvent.setup();
    const threadId = "d0000000-0000-4000-a000-000000000001";
    const nextRunAt = "2026-06-07T14:30:00.000Z";
    mockChatLifecycle({ threadId });
    setMockSchedules([
      createMockScheduleResponse({
        id: "e0000000-0000-4000-a000-000000000011",
        name: "next-run-schedule",
        description: "Daily morning briefing",
        chatThreadId: threadId,
        enabled: true,
        nextRunAt,
      }),
      createMockScheduleResponse({
        id: "e0000000-0000-4000-a000-000000000012",
        name: "inactive-schedule",
        description: "Paused sync",
        chatThreadId: threadId,
        enabled: false,
        nextRunAt: "2026-06-08T09:00:00.000Z",
      }),
      createMockScheduleResponse({
        id: "e0000000-0000-4000-a000-000000000013",
        name: "no-upcoming-run-schedule",
        description: "Manual follow-up",
        chatThreadId: threadId,
        enabled: true,
        nextRunAt: null,
      }),
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await user.click(await screen.findByLabelText("Schedules"));

    const menu = await screen.findByRole("menu");
    const expectedNextRun = `Next run ${new Date(nextRunAt).toLocaleString(
      "en-US",
      {
        dateStyle: "medium",
        timeStyle: "short",
      },
    )}`;

    expect(
      within(menu).getByText("Daily morning briefing"),
    ).toBeInTheDocument();
    expect(within(menu).getByText(expectedNextRun)).toBeInTheDocument();
    expect(within(menu).getByText("Paused sync")).toBeInTheDocument();
    expect(within(menu).getByText("Schedule inactive")).toBeInTheDocument();
    expect(within(menu).getByText("Manual follow-up")).toBeInTheDocument();
    expect(within(menu).getByText("No upcoming run")).toBeInTheDocument();
  });
});

describe("zero chat thread page display - scheduled run card", () => {
  it("collapses a scheduled run into a status card and opens assistant details", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          id: "msg-scheduled-user",
          role: "user",
          content: "Run the daily report",
          runId: "run-scheduled-report",
          scheduleId: "schedule-report",
          scheduleTitle: "Daily report",
          scheduleSnapshot: {
            id: "schedule-report",
            title: "Daily report",
            description: "Daily revenue summary",
          },
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-scheduled-assistant",
          role: "assistant",
          content: [
            "I checked the latest numbers.",
            "Revenue is up 4%.",
            "Open issues are unchanged.",
            "I prepared the report.",
          ].join("\n"),
          runId: "run-scheduled-report",
          status: "completed",
          createdAt: "2026-03-10T00:00:10Z",
        },
        {
          id: "msg-scheduled-marker",
          role: "assistant",
          content: null,
          runId: "run-scheduled-report",
          runLifecycleEvent: "completed",
          createdAt: "2026-03-10T00:00:11Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const card = await screen.findByLabelText(
      "Open scheduled run details for Daily revenue summary",
    );
    expect(card).toHaveTextContent("Triggered at");
    expect(card).toHaveTextContent("Daily revenue summary");
    expect(card).toHaveTextContent("Succeeded");
    expect(card).toHaveTextContent("Revenue is up 4%.");
    expect(card).toHaveTextContent("Open issues are unchanged.");
    expect(card).toHaveTextContent("I prepared the report.");
    expect(
      screen.queryByText("I checked the latest numbers."),
    ).not.toBeInTheDocument();

    await user.click(card);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Scheduled run")).toBeInTheDocument();
    expect(within(dialog).getByText("Succeeded")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/I checked the latest numbers/),
    ).toBeInTheDocument();
  });

  it("uses the original inline schedule display when the feature switch is disabled", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          id: "msg-scheduled-user",
          role: "user",
          content: "Run the daily report",
          runId: "run-scheduled-report",
          scheduleId: "schedule-report",
          scheduleTitle: "Daily report",
          scheduleSnapshot: {
            id: "schedule-report",
            title: "Daily report",
            description: "Daily revenue summary",
          },
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-scheduled-assistant",
          role: "assistant",
          content: "I checked the latest numbers and prepared the report.",
          runId: "run-scheduled-report",
          status: "completed",
          createdAt: "2026-03-10T00:00:10Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatScheduledRunCard]: false },
    });

    const scheduleLink = await screen.findByLabelText(
      "Open schedule Daily revenue summary",
    );
    expect(scheduleLink).toBeInTheDocument();
    expect(
      screen.queryByLabelText(
        "Open scheduled run details for Daily revenue summary",
      ),
    ).not.toBeInTheDocument();
    const assistantMessage = await screen.findByText(
      "I checked the latest numbers and prepared the report.",
    );
    expect(assistantMessage).toBeInTheDocument();
  });
});

describe("zero chat thread page display - permission action card", () => {
  function mockPermissionAgent() {
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
        });
      }),
    );
  }

  function mockPermissionMessage(
    permission = "channels:write",
    action: "allow" | "deny" = "allow",
    expiresIn?: UserPermissionGrantExpiresIn,
  ) {
    const expiresInQuery = expiresIn ? `&expiresIn=${expiresIn}` : "";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `https://app.vm0.ai/agents/4f189ea8-ada2-416d-83a9-9c25ddb960c9/permissions?ref=slack&permission=${encodeURIComponent(permission)}&action=${action}${expiresInQuery}`,
          runId: "run-user-grant-permission-action",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
  }

  it("writes a current-user grant from a permission action card", async () => {
    let grantBody: unknown;
    mockPermissionAgent();
    mockPermissionMessage();
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(
          200,
          createMockUserPermissionGrantResponse({
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: body.permission,
            action: body.action,
          }),
        );
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "slack",
        permission: "channels:write",
        action: "allow",
      });
    });
    expect(grantBody).not.toMatchObject({ expiresIn: expect.any(String) });
    const status = within(card).getByText("Permissions updated");
    expect(status).toBeInTheDocument();
    expect(status.closest("button")).toBeNull();
  });

  it("submits the default duration from permission action cards when enabled", async () => {
    let grantBody: unknown;
    mockPermissionAgent();
    mockPermissionMessage();
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(
      within(card).getByRole("combobox", { name: "Permission duration" }),
    ).toHaveTextContent("1 hour");
    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({
        permission: "channels:write",
        action: "allow",
        expiresIn: "1h",
      });
    });
  });

  it("does not show or submit duration for deny permission action cards", async () => {
    let grantBody: unknown;
    mockPermissionAgent();
    mockPermissionMessage("channels:read", "deny");
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(
      within(card).queryByRole("combobox", { name: "Permission duration" }),
    ).not.toBeInTheDocument();
    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({
        permission: "channels:read",
        action: "deny",
      });
    });
    expect(grantBody).not.toMatchObject({ expiresIn: expect.any(String) });
  });

  it("uses current-user grants for already-applied permission actions", async () => {
    mockPermissionAgent();
    mockPermissionMessage();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "slack",
        permission: "channels:write",
        action: "allow",
      }),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button", card).find((element) => {
        return element.textContent?.trim() === "Confirm";
      }),
    ).toBeUndefined();
  });

  it("confirms requested expiration changes for already-applied permission actions", async () => {
    let grantBody: unknown;
    mockPermissionAgent();
    mockPermissionMessage("channels:write", "allow", "24h");
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "slack",
        permission: "channels:write",
        action: "allow",
      }),
    ]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantBody = body;
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(
      within(card).getByRole("combobox", { name: "Permission duration" }),
    ).toHaveTextContent("24 hours");

    click(await within(card).findByText("Confirm"));

    await waitFor(() => {
      expect(grantBody).toMatchObject({
        permission: "channels:write",
        action: "allow",
        expiresIn: "24h",
      });
    });
  });

  it("treats requested always as already applied for permanent allow permission actions", async () => {
    mockPermissionAgent();
    mockPermissionMessage("channels:write", "allow", "always");
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "slack",
        permission: "channels:write",
        action: "allow",
        expiresAt: null,
      }),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
    expect(
      within(card).queryByRole("combobox", { name: "Permission duration" }),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button", card).find((element) => {
        return element.textContent?.trim() === "Confirm";
      }),
    ).toBeUndefined();
  });

  it("shows existing expiration for already-applied permission actions", async () => {
    mockPermissionAgent();
    mockPermissionMessage();
    setMockUserPermissionGrants([
      createMockUserPermissionGrantResponse({
        agentId: "4f189ea8-ada2-416d-83a9-9c25ddb960c9",
        connectorRef: "slack",
        permission: "channels:write",
        action: "allow",
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ExpiringPermissionGrants]: true },
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    expect(within(card).getByText("Permissions updated")).toBeInTheDocument();
    expect(within(card).getByText("Expires in 2 hours")).toBeInTheDocument();
    expect(
      within(card).queryByRole("combobox", { name: "Permission duration" }),
    ).not.toBeInTheDocument();
  });

  it("does not write grants for unknown permission actions", async () => {
    let grantWritten = false;
    mockPermissionAgent();
    mockPermissionMessage("not-a-real-permission");
    setMockUserPermissionGrants([]);
    server.use(
      mockApi(zeroUserPermissionGrantsContract.upsert, ({ body, respond }) => {
        grantWritten = true;
        return respond(200, createMockUserPermissionGrantResponse(body));
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const card = await waitFor(() => {
      return screen.getByTestId("permission-action-card");
    });
    const button = await waitFor(() => {
      const element = queryAllByRoleFast("button", card).find((candidate) => {
        return candidate.textContent?.trim() === "Unknown permission";
      });
      expect(element).toBeDefined();
      return element!;
    });
    expect(button).toBeDisabled();
    expect(grantWritten).toBeFalsy();
  });
});

describe("zero chat thread page display - attachment image preview", () => {
  it("renders image attachment preview with the correct alt text", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            "[Attached file: photo.png](https://example.com/photo.png)\nDownload with: curl https://example.com/photo.png\n",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const previewLink = await waitFor(() => {
      return screen.getByLabelText("Preview photo.png");
    });
    expect(previewLink).toHaveAttribute(
      "href",
      "https://example.com/photo.png",
    );
    expect(previewLink).toHaveClass("w-[min(100%,400px)]", "aspect-[16/10]");
    const previewImage = within(previewLink).getByAltText("photo.png");
    expect(previewImage).toBeInTheDocument();
    expect(
      within(previewLink).getByTestId("chat-image-preview-loading"),
    ).toBeInTheDocument();

    fireEvent.load(previewImage);
    await waitFor(() => {
      expect(
        within(previewLink).queryByTestId("chat-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment audio chip", () => {
  it("renders audio attachment as a compact preview chip", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Please listen",
          createdAt: "2026-03-10T00:00:00Z",
          attachFiles: [
            {
              id: "audio-file-1",
              filename: "clip.mp3",
              contentType: "audio/mpeg",
              size: 4096,
              url: "https://example.com/clip.mp3",
            },
          ],
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const preview = await waitFor(() => {
      return screen.getByLabelText("Open audio preview for clip.mp3");
    });
    expect(preview).toHaveAttribute("type", "button");
    expect(preview).not.toHaveAttribute("href");
    expect(
      within(preview).getByTestId("attachment-chip-file-icon"),
    ).toBeInTheDocument();

    await user.click(preview);

    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(
      within(lightbox).getByLabelText("Audio preview for clip.mp3"),
    ).toHaveAttribute("src", "https://example.com/clip.mp3");
  });
});

// CHAT-D-037: Attachment document previews render in ChatMessageRow
describe("zero chat thread page display - attachment document preview", () => {
  it("keeps markdown attachments as chips and opens preview on click", async () => {
    const docUrl = "https://example.com/notes.md#intro";
    let requestedUrl = "";
    let requestedRange = "";
    server.use(
      http.get("https://example.com/notes.md", ({ request }) => {
        requestedUrl = request.url;
        requestedRange = request.headers.get("Range") ?? "";
        return HttpResponse.text("# PRD\n\nPreview body");
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: notes.md](${docUrl})\nDownload with: curl ${docUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open markdown preview for notes.md"),
    );

    await waitFor(() => {
      expect(screen.getByText("PRD")).toBeInTheDocument();
      expect(screen.getByText("Preview body")).toBeInTheDocument();
    });
    expect(new URL(requestedUrl).searchParams.get("raw")).toBeNull();
    expect(requestedRange).toBe("bytes=0-65535");
  });
});

describe("zero chat thread page display - body link document preview", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "location",
      new URL("https://app.vm0.ai/chats/thread-test-1"),
    );
  });

  it("renders markdown body links inline for platform file urls", async () => {
    const docUrl =
      "https://api.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/notes.md";
    server.use(
      http.get(docUrl, () => {
        return HttpResponse.text("# Linked PRD\n\nPreview body");
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[可爱文档](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("attachment-preview-markdown"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open markdown preview for notes.md"),
    );

    await waitFor(() => {
      expect(screen.getByText("Linked PRD")).toBeInTheDocument();
      expect(screen.getByText("Preview body")).toBeInTheDocument();
    });
  });

  it("keeps external markdown links as plain links and does not render preview cards", async () => {
    const docUrl = "https://example.com/notes.md";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[notes](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(screen.getByText("notes")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("attachment-preview-markdown"),
    ).not.toBeInTheDocument();
  });

  it("keeps external /f links as plain links and does not render preview cards", async () => {
    const docUrl =
      "https://example.com/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/notes.md";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[notes](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByText("notes").closest("a")).toHaveAttribute(
        "href",
        docUrl,
      );
    });

    expect(
      screen.queryByTestId("attachment-preview-markdown"),
    ).not.toBeInTheDocument();
  });

  it.each(["vm0.ai", "vm6.ai", "vm7.ai"])(
    "renders %s file host links as thumbnail preview blocks",
    async (host) => {
      const fileUrl = `https://www.${host}/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/test_files.zip`;

      mockChatLifecycle({
        chatMessages: [
          {
            role: "assistant",
            content: `[test_files.zip](${fileUrl})`,
            createdAt: "2026-03-10T00:00:00Z",
          },
        ],
      });

      detachedSetupPage({
        context,
        path: "/chats/thread-test-1",
      });

      const preview = await screen.findByTestId("attachment-preview-file");
      expect(
        within(preview).getByTestId("attachment-preview-file-icon"),
      ).toBeInTheDocument();
      expect(within(preview).getByText("ZIP")).toBeInTheDocument();
    },
  );

  it("renders matching tunnel host file links as thumbnail preview blocks", async () => {
    vi.stubGlobal(
      "location",
      new URL("https://tunnel-yuma-vm0-app.vm7.ai/chats/thread-test-1"),
    );
    const fileUrl =
      "https://tunnel-yuma-vm0-www.vm7.ai/f/user_3BennfUepyJwP3OaiYD0rK8CZKs/bce0a522-aed9-4d72-a86c-3164177fb44c/test_files.zip";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[test_files.zip](${fileUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const preview = await screen.findByTestId("attachment-preview-file");
    expect(
      within(preview).getByTestId("attachment-preview-file-icon"),
    ).toBeInTheDocument();
    expect(within(preview).getByText("ZIP")).toBeInTheDocument();
    const download = screen.getByLabelText("Download test_files.zip");
    expect(download).toHaveAttribute("type", "button");
    expect(download).not.toHaveAttribute("href");
  });

  it("keeps platform file links inside markdown tables as table links", async () => {
    const docUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/budget.xlsx";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: [
            "| File | Link |",
            "| --- | --- |",
            `| Budget | [budget.xlsx](${docUrl}) |`,
          ].join("\n"),
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const table = await screen.findByRole("table");
    expect(within(table).getByText("budget.xlsx").closest("a")).toHaveAttribute(
      "href",
      docUrl,
    );
    expect(screen.queryByTestId("attachment-preview-file")).toBeNull();
  });

  it("renders html body links as preview cards for platform file urls", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[可爱小猫页面](${htmlUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for 可爱小猫页面"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for 可爱小猫页面"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("可爱小猫页面 preview")).toBeInTheDocument();
    });
  });

  it("renders html body links wrapped in markdown formatting as preview cards for platform file urls", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/cute_kitten.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>kitten preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `上传完成！点击下面的链接即可查看：\n\n**[可爱小猫页面](${htmlUrl})**\n\n页面包含居中卡片布局。`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for 可爱小猫页面"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for 可爱小猫页面"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("可爱小猫页面 preview")).toBeInTheDocument();
    });
  });

  it("renders bold bare html urls as preview cards and preserves surrounding text", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/diabetes.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>diabetes preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `已上传，直接访问即可：\n\n**${htmlUrl}**\n\n页面包含了血糖换算器、诊断标准表、饮食建议。`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByText("已上传，直接访问即可：")).toBeInTheDocument();
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for diabetes.html"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("页面包含了血糖换算器、诊断标准表、饮食建议。"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for diabetes.html"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("diabetes.html preview")).toBeInTheDocument();
    });
  });

  it("renders platform file urls inside markdown list and quote symbols as preview cards", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/symbol-report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>symbol preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `文件已生成：\n\n> 👉 **<${htmlUrl}>**\n\n- **[查看报告](${htmlUrl})**`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getAllByTestId("attachment-preview-html")).toHaveLength(2);
      expect(
        screen.getByLabelText("Open html preview for symbol-report.html"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for 查看报告"),
      ).toBeInTheDocument();
    });
  });

  it("renders bare platform image file urls as image previews", async () => {
    const user = userEvent.setup();
    const imageUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    const publicImageUrl =
      "https://cdn.vm7.io/artifacts/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    server.use(
      http.get(imageUrl, () => {
        return new HttpResponse("png", {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `生成完成：\n\n${imageUrl}`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview chart.png")).toBeInTheDocument();
    });
    const previewLink = screen.getByLabelText("Preview chart.png");
    expect(previewLink).toHaveAttribute("href", publicImageUrl);
    expect(within(previewLink).getByAltText("chart.png")).toBeInTheDocument();

    await user.click(previewLink);
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(lightbox).toBeInTheDocument();
  });

  it("renders json body links as preview cards for platform file urls", async () => {
    const jsonUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/data.json";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[数据](${jsonUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      const preview = screen.getByTestId("attachment-preview-json");
      expect(preview).toBeInTheDocument();
      expect(preview).toHaveAttribute("href");
      expect(within(preview).getByText("data.json")).toBeInTheDocument();
    });
  });

  it("renders pdf body links as previewable document cards for platform file urls", async () => {
    const pdfUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/document.pdf";
    server.use(
      http.get(pdfUrl, () => {
        return new HttpResponse("%PDF-1.4", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[手册](${pdfUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-pdf")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open pdf preview for document.pdf"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open pdf preview for document.pdf"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("document.pdf preview")).toBeInTheDocument();
    });
  });

  it("renders csv body links as previewable document cards for platform file urls", async () => {
    const csvUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/report.csv";
    server.use(
      http.get(csvUrl, () => {
        return HttpResponse.text("name,count\nkitten,2\npuppy,3", {
          headers: { "Content-Type": "text/csv" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[报表](${csvUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-csv")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open csv preview for report.csv"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open csv preview for report.csv"),
    );

    await waitFor(() => {
      expect(screen.getByText("name")).toBeInTheDocument();
      expect(screen.getByText("count")).toBeInTheDocument();
      expect(screen.getByText("kitten")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  it("renders text body links as preview cards for platform file urls", async () => {
    const txtUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/readme.txt#summary";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[readme](${txtUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      const preview = screen.getByTestId("attachment-preview-text");
      expect(preview).toBeInTheDocument();
      expect(preview).toHaveAttribute("href");
      expect(within(preview).getByText("readme.txt")).toBeInTheDocument();
    });
  });

  it.each([
    {
      filename: "config.xml",
    },
    {
      filename: "deploy.yaml",
    },
    {
      filename: "table.tsv",
    },
  ])(
    "renders $filename body links as text preview cards for platform file urls",
    async ({ filename }) => {
      const fileUrl = `https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/${filename}`;
      mockChatLifecycle({
        chatMessages: [
          {
            role: "assistant",
            content: `[file](${fileUrl})`,
            createdAt: "2026-03-10T00:00:00Z",
          },
        ],
      });

      detachedSetupPage({
        context,
        path: "/chats/thread-test-1",
      });

      await waitFor(() => {
        const textPreview = screen.getByTestId("attachment-preview-text");
        expect(textPreview).toBeInTheDocument();
        expect(textPreview).toHaveAttribute("href");
        expect(within(textPreview).getByText(filename)).toBeInTheDocument();
      });
    },
  );

  it("renders non-inline platform file links as thumbnail preview blocks", async () => {
    const docUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/budget.xlsx";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[budget](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      const preview = screen.getByTestId("attachment-preview-file");
      expect(preview).toBeInTheDocument();
      expect(
        within(preview).getByTestId("attachment-preview-file-icon"),
      ).toBeInTheDocument();
      expect(within(preview).getByText("XLSX")).toBeInTheDocument();
      const download = screen.getByLabelText("Download budget.xlsx");
      expect(download).toHaveAttribute("type", "button");
      expect(download).not.toHaveAttribute("href");
    });
  });

  it("renders structured non-inline attached files as compact download chips", async () => {
    const fileUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/budget.xlsx";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Please review",
          createdAt: "2026-03-10T00:00:00Z",
          attachFiles: [
            {
              id: "file-budget",
              filename: "budget.xlsx",
              contentType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: 2048,
              url: fileUrl,
            },
          ],
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const preview = screen.getByLabelText("Download budget.xlsx");
      expect(
        within(preview).queryByTestId("attachment-preview-file-icon"),
      ).not.toBeInTheDocument();
      expect(
        within(preview).getByTestId("attachment-chip-file-icon"),
      ).toBeInTheDocument();
      expect(within(preview).getByText("XLSX")).toBeInTheDocument();
      expect(preview).toHaveAttribute("type", "button");
      expect(preview).not.toHaveAttribute("href");
    });
  });

  it("preserves assistant soft line breaks without forcing hard breaks", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Here is some text that wraps\nacross multiple lines for readability.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent?.replace(/\s+/g, " ")).toContain(
        "Here is some text that wraps across multiple lines for readability.",
      );
      expect(assistant?.querySelector("br")).toBeNull();
    });
  });

  it("renders assistant inline and block math", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: "Inline $x^2$.\n\n$$\nx^2\n$$",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.querySelector(".katex")).toBeInTheDocument();
      expect(assistant?.querySelector(".katex-display")).toBeInTheDocument();
    });
  });

  it("keeps assistant math delimiters inside code fences as code", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: "Here is code:\n```text\n$x^2$\n```\nDone.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.querySelector("code")?.textContent).toContain("$x^2$");
      expect(assistant?.querySelector(".katex")).toBeNull();
    });
  });

  it("does not render a single ordinary dollar amount as math", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: "The total is $5 today.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent).toContain("The total is $5 today.");
      expect(assistant?.querySelector(".katex")).toBeNull();
    });
  });

  it("keeps previewable markdown links inside assistant code fences as code", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Here is the syntax:\n```markdown\n[PRD](https://example.com/prd.md)\n```\nDone.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent).toContain(
        "[PRD](https://example.com/prd.md)",
      );
    });
    expect(screen.queryByTestId("attachment-preview-markdown")).toBeNull();
    expect(
      screen.queryByLabelText("Open markdown preview for prd.md"),
    ).toBeNull();
  });
});

// CHAT-D-065: Video attachments render as poster buttons and open playback preview.
describe("zero chat thread page display - attachment video preview", () => {
  it("renders an mp4 attachment poster and opens an autoplaying preview", async () => {
    const videoUrl = "https://example.com/clip.mp4";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: clip.mp4](${videoUrl})\nDownload with: curl ${videoUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const previewButton = await waitFor(() => {
      return screen.getByLabelText("Preview clip.mp4");
    });
    const posterVideo = previewButton.querySelector("video");

    expect(previewButton).toHaveClass("w-[min(100%,400px)]", "aspect-[16/10]");
    expect(
      within(previewButton).getByTestId("chat-video-preview-poster"),
    ).toBeInTheDocument();
    expect(posterVideo?.getAttribute("src")).toBe(`${videoUrl}#t=0.001`);
    expect(posterVideo?.hasAttribute("controls")).toBeFalsy();
    expect(
      screen.queryByLabelText("Video preview for clip.mp4"),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(`img[src="${videoUrl}"]`),
    ).not.toBeInTheDocument();

    await userEvent.click(previewButton);

    const lightbox = await waitFor(() => {
      return screen.getByTestId("attachment-lightbox");
    });
    const video = within(lightbox).getByLabelText("Video preview for clip.mp4");

    expect(lightbox).toHaveClass("zero-dialog-enter-overlay");
    expect(
      within(lightbox).getByTestId("attachment-lightbox-panel"),
    ).toHaveClass("zero-dialog-enter-content");
    expect(video).toHaveAttribute("src", videoUrl);
    expect(video).toHaveAttribute("controls");
    expect((video as HTMLVideoElement).autoplay).toBeTruthy();
    expect(within(lightbox).getByLabelText("Share")).toBeInTheDocument();
    expect(
      within(lightbox).getByLabelText("Download options"),
    ).toBeInTheDocument();
  });

  it("uses the padded artifact dialog stage for video previews", async () => {
    const videoUrl = "https://example.com/clip.mp4";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: clip.mp4](${videoUrl})\nDownload with: curl ${videoUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await userEvent.click(await screen.findByLabelText("Preview clip.mp4"));

    const lightbox = await screen.findByTestId("attachment-lightbox");
    const stage = within(lightbox).getByTestId("artifact-dialog-stage");
    const videoStage = within(lightbox).getByTestId(
      "artifact-dialog-video-stage",
    );
    const video = within(videoStage).getByLabelText(
      "Video preview for clip.mp4",
    );

    expect(stage).toHaveClass("bg-muted/30", "p-5");
    expect(videoStage).toHaveClass("rounded-xl", "border", "bg-black");
    expect(video).toHaveClass("aspect-video", "object-contain");
  });
});

describe("zero chat thread page display - attachment html preview", () => {
  it("keeps html attachments as chips and opens preview on click", async () => {
    const htmlUrl = "https://example.com/report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: report.html](${htmlUrl})\nDownload with: curl ${htmlUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open html preview for report.html"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for report.html"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("report.html preview")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment json preview", () => {
  it("keeps json attachments as chips and opens preview on click", async () => {
    const jsonUrl = "https://example.com/data.json";
    server.use(
      http.get(jsonUrl, () => {
        return HttpResponse.text('{"status":"ok","count":2}');
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: data.json](${jsonUrl})\nDownload with: curl ${jsonUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open json preview for data.json"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open json preview for data.json"),
    );

    await waitFor(() => {
      expect(screen.getByText(/"status": "ok"/)).toBeInTheDocument();
      expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment pdf preview", () => {
  it("keeps pdf attachments as chips and opens preview on click", async () => {
    const pdfUrl = "https://example.com/document.pdf";
    server.use(
      http.get(pdfUrl, () => {
        return new HttpResponse("%PDF-1.4", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: document.pdf](${pdfUrl})\nDownload with: curl ${pdfUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open pdf preview for document.pdf"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open pdf preview for document.pdf"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("document.pdf preview")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - artifact sidebar", () => {
  it("opens the artifact inbox sidebar", async () => {
    const user = userEvent.setup();
    let artifactsRequests = 0;
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create files",
          runId: "run-artifact-inbox",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        artifactsRequests += 1;
        return respond(200, {
          runs: [
            {
              runId: "run-artifact-inbox",
              files: [
                {
                  id: "file-image",
                  filename: "chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: "https://example.com/chart.png",
                  createdAt: "2026-03-10T00:00:00Z",
                },
                {
                  id: "file-data",
                  filename: "data.csv",
                  contentType: "text/csv",
                  size: 2048,
                  url: "https://example.com/data.csv",
                  createdAt: "2026-03-10T00:00:00Z",
                },
                {
                  id: "file-video",
                  filename: "demo.mp4",
                  contentType: "video/mp4",
                  size: 16_384,
                  url: "https://example.com/demo.mp4",
                  createdAt: "2026-03-10T00:00:00Z",
                },
                {
                  id: "file-site",
                  filename: "landing.html",
                  contentType: "text/html",
                  size: 8192,
                  url: "https://preview.sites.vm7.io",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    expect(artifactsRequests).toBe(0);
    await user.click(button);

    const inbox = await screen.findByTestId("artifact-inbox");
    expect(inbox).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Artifacts" })).toBeNull();
    expect(artifactsRequests).toBeGreaterThan(0);
    expect(search()).toContain("artifacts=thread-test-1");
    expect(
      getRoleByAriaLabel("button", "Open artifact chart.png"),
    ).toBeInTheDocument();
    expect(
      getRoleByAriaLabel("button", "Open artifact data.csv"),
    ).toBeInTheDocument();
    expect(
      getRoleByAriaLabel("button", "Open artifact landing.html"),
    ).toBeInTheDocument();
    const videoRow = getRoleByAriaLabel("button", "Open artifact demo.mp4");
    expect(
      within(videoRow).getByTestId("artifact-video-preview-badge"),
    ).toHaveAttribute("src", "https://example.com/demo.mp4#t=0.001");
    const siteRow = getRoleByAriaLabel("button", "Open artifact landing.html");
    expect(
      within(siteRow).getByTestId("artifact-html-preview-badge"),
    ).toBeInTheDocument();
    expect(within(inbox).queryByText("Live")).not.toBeInTheDocument();

    await user.click(getRoleByText("tab", "Sites"));
    expect(
      getRoleByAriaLabel("button", "Open artifact landing.html"),
    ).toBeInTheDocument();
    expect(
      queryRoleByAriaLabel("button", "Open artifact chart.png"),
    ).toBeUndefined();

    await user.click(getRoleByText("tab", "Docs"));
    expect(
      getRoleByAriaLabel("button", "Open artifact data.csv"),
    ).toBeInTheDocument();
    expect(
      queryRoleByAriaLabel("button", "Open artifact landing.html"),
    ).toBeUndefined();

    await user.click(getRoleByText("tab", "Media"));
    await user.click(getRoleByAriaLabel("button", "Open artifact chart.png"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    expect(sidebar).toBeInTheDocument();
    expect(screen.getByLabelText("Back to all artifacts")).toBeInTheDocument();
    expect(within(sidebar).getByText("chart.png")).toBeInTheDocument();
    expect(
      within(sidebar).getByText(/Image · PNG · 4\.0 KB · Generated/u),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("artifact-sidebar-image-zoom-controls"),
    ).toBeInTheDocument();
    expect(search()).toContain(
      "artifact=https%3A%2F%2Fexample.com%2Fchart.png",
    );

    await user.click(screen.getByTestId("artifact-sidebar-fullscreen-toggle"));
    expect(screen.getByTestId("artifact-sidebar")).toHaveClass("fixed");
    expect(search()).toContain("artifact-fullscreen=1");

    await user.click(screen.getByLabelText("Back to all artifacts"));
    await expect(
      screen.findByTestId("artifact-inbox"),
    ).resolves.toBeInTheDocument();
    expect(search()).toContain("artifacts=thread-test-1");
    expect(search()).not.toContain("artifact=");
    expect(search()).not.toContain("artifact-fullscreen=");

    await user.click(screen.getByTestId("artifact-inbox-fullscreen-toggle"));
    expect(screen.getByTestId("artifact-inbox")).toHaveClass("fixed");

    await user.click(screen.getByLabelText("Close artifacts"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-inbox")).not.toBeInTheDocument();
    });
    expect(search()).not.toContain("artifacts=");
  });

  it("opens chat previews in a modal before split view", async () => {
    const user = userEvent.setup();
    const imageUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    server.use(
      http.get(imageUrl, () => {
        return new HttpResponse("png", {
          headers: { "Content-Type": "image/png" },
        });
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-chat-preview-artifact",
              files: [
                {
                  id: "file-image",
                  filename: "chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: imageUrl,
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `Generated chart:\n\n${imageUrl}`,
          runId: "run-chat-preview-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await user.click(await screen.findByLabelText("Preview chart.png"));

    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(lightbox).toBeInTheDocument();
    expect(lightbox).toHaveClass("zero-dialog-enter-overlay");
    expect(
      within(lightbox).getByTestId("attachment-lightbox-panel"),
    ).toHaveClass("zero-dialog-enter-content");
    const stage = within(lightbox).getByTestId("artifact-dialog-stage");
    expect(stage).toHaveClass("overflow-hidden");
    expect(stage).not.toHaveClass("p-5");
    expect(stage.firstElementChild).toHaveClass("max-w-none");
    expect(within(lightbox).getByTestId("artifact-dialog-card")).toHaveClass(
      "h-full",
      "min-h-0",
    );
    expect(
      within(lightbox).getByTestId("artifact-dialog-card"),
    ).not.toHaveClass("border");
    expect(
      within(lightbox).getByTestId("artifact-dialog-image-stage"),
    ).toHaveClass("h-full", "overflow-hidden");
    expect(screen.getByRole("dialog", { name: "chart.png preview" })).toBe(
      lightbox,
    );
    expect(within(lightbox).getByText("chart.png")).toBeInTheDocument();
    expect(
      within(lightbox).getByText(/Image · PNG · 4\.0 KB · Generated/u),
    ).toBeInTheDocument();
    expect(
      within(lightbox).queryByTestId("attachment-lightbox-file-icon"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("artifact-inbox")).not.toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    expect(search()).not.toContain("artifacts=");
    expect(search()).not.toContain("artifact=");

    await user.click(within(lightbox).getByLabelText("Zoom in"));
    expect(within(lightbox).getByText("115%")).toBeInTheDocument();

    await user.click(within(lightbox).getByLabelText("Enter fullscreen"));
    const fullscreenLightbox = await screen.findByTestId("attachment-lightbox");
    await waitFor(() => {
      expect(within(fullscreenLightbox).getByText("100%")).toBeInTheDocument();
    });
    expect(
      within(fullscreenLightbox).getByLabelText("Exit fullscreen"),
    ).toBeInTheDocument();

    await user.click(
      within(fullscreenLightbox).getByLabelText("Open in split view"),
    );

    await expect(
      screen.findByTestId("artifact-sidebar"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("artifact-inbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Back to all artifacts")).toBeNull();
    expect(search()).not.toContain("artifacts=");
    expect(search()).toContain(
      "artifact=https%3A%2F%2Fwww.vm0.ai%2Ff%2Fuser_123%2F3a474c61-ffe4-4e56-b9e7-0185b3dba9f7%2Fchart.png",
    );
  });

  it("only shows artifact inbox filters for existing artifact types", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create an image",
          runId: "run-artifact-inbox-media",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-artifact-inbox-media",
              files: [
                {
                  id: "file-image",
                  filename: "chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: "https://example.com/chart.png",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await user.click(await screen.findByLabelText("Open artifacts"));

    await expect(
      screen.findByTestId("artifact-inbox"),
    ).resolves.toBeInTheDocument();
    expect(getRoleByText("tab", "All")).toBeInTheDocument();
    expect(getRoleByText("tab", "Media")).toBeInTheDocument();
    expect(queryRoleByText("tab", "Docs")).toBeUndefined();
    expect(queryRoleByText("tab", "Sites")).toBeUndefined();
  });

  it("opens artifacts from the mobile top bar icon", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create a file",
          runId: "run-mobile-artifacts",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-mobile-artifacts",
              files: [
                {
                  id: "file-mobile",
                  filename: "mobile.zip",
                  contentType: "application/zip",
                  size: 512,
                  url: "https://example.com/mobile.zip",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open mobile artifacts");
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
      expect(screen.getAllByText("mobile.zip").length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("dialog", { name: "Artifacts" })).toBeNull();
  });

  it("renders markdown artifacts through the text loader instead of an iframe", async () => {
    const user = userEvent.setup();
    let requestedUrl = "";
    let requestedRange = "";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create markdown",
          runId: "run-markdown-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/readme.md", ({ request }) => {
        requestedUrl = request.url;
        requestedRange = request.headers.get("Range") ?? "";
        return HttpResponse.text("# 发布说明\n\n这里是中文内容");
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-markdown-artifact",
              files: [
                {
                  id: "file-md",
                  filename: "readme.md",
                  contentType: "text/markdown",
                  size: 1024,
                  url: "https://example.com/readme.md",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open artifacts");
      }),
    );
    await user.click(await screen.findByLabelText("Open artifact readme.md"));

    await waitFor(() => {
      expect(screen.getByText("发布说明")).toBeInTheDocument();
      expect(screen.getByText("这里是中文内容")).toBeInTheDocument();
    });
    expect(new URL(requestedUrl).searchParams.get("raw")).toBeNull();
    expect(requestedRange).toBe("bytes=0-65535");
    expect(
      document.querySelector('iframe[title="Preview readme.md"]'),
    ).not.toBeInTheDocument();
  });

  it("renders xml artifacts through the text loader instead of an iframe", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create XML",
          runId: "run-xml-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/config.xml", () => {
        return HttpResponse.text("<config><enabled>true</enabled></config>");
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-xml-artifact",
              files: [
                {
                  id: "file-xml",
                  filename: "config.xml",
                  contentType: "application/xml",
                  size: 512,
                  url: "https://example.com/config.xml",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open artifacts");
      }),
    );
    await user.click(await screen.findByLabelText("Open artifact config.xml"));

    await waitFor(() => {
      expect(screen.getByText(/<config>/)).toBeInTheDocument();
    });
    expect(
      document.querySelector('iframe[title="Preview config.xml"]'),
    ).not.toBeInTheDocument();
  });

  it("renders html artifacts as document iframe previews", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create HTML",
          runId: "run-html-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/report.html", () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-html-artifact",
              files: [
                {
                  id: "file-html",
                  filename: "report.html",
                  contentType: "text/html",
                  size: 1024,
                  url: "https://example.com/report.html",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Open artifacts");
      }),
    );
    await user.click(await screen.findByLabelText("Open artifact report.html"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "title",
        "report.html preview",
      );
    });
  });

  it("refreshes uploaded files from the artifacts Ably signal while the inbox is open", async () => {
    const threadId = "thread-test-1";
    let artifactsRequests = 0;
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Upload from a run",
          runId: "run-artifacts-ably",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        artifactsRequests += 1;
        return respond(200, {
          runs:
            artifactsRequests === 1
              ? []
              : [
                  {
                    runId: "run-artifacts-ably",
                    files: [
                      {
                        id: "file-ably",
                        filename: "artifact.zip",
                        contentType: "application/zip",
                        size: 8192,
                        url: "https://example.com/artifact.zip",
                        createdAt: "2026-03-10T00:00:00Z",
                      },
                    ],
                  },
                ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    click(button);

    await waitFor(() => {
      expect(
        screen.getByText("No uploaded files in this chat yet."),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        hasSubscription(`chatThreadArtifactsChanged:${threadId}`),
      ).toBeTruthy();
    });

    updateChatArtifacts(threadId);

    await waitFor(() => {
      expect(screen.getAllByText("artifact.zip").length).toBeGreaterThan(0);
    });
    expect(artifactsRequests).toBeGreaterThanOrEqual(2);
  });

  it("copies artifact links and syncs to Google Drive when connected", async () => {
    const user = userEvent.setup();
    const fileUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    const publicFileUrl =
      "https://cdn.vm7.io/artifacts/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/chart.png";
    let artifactsRequests = 0;
    const syncBodies: unknown[] = [];
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "See attached",
          runId: "run-artifacts-actions",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setMockConnectors([
      {
        id: "00000000-0000-4000-8000-000000000000",
        type: "google-drive",
        authMethod: "oauth",
        externalId: "drive-user",
        externalUsername: "Drive User",
        externalEmail: "drive@example.com",
        oauthScopes: ["https://www.googleapis.com/auth/drive"],
        connectionStatus: "connected",
        tokenExpiresAt: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    server.use(
      http.get(fileUrl, () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        });
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        artifactsRequests += 1;
        return respond(200, {
          runs: [
            {
              runId: "run-artifacts-actions",
              files: [
                {
                  id: "file-1",
                  filename: "chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: fileUrl,
                  createdAt: "2026-03-10T00:00:00Z",
                  googleDriveSync:
                    artifactsRequests > 1
                      ? {
                          status: "synced",
                          id: "drive-file-id",
                          name: "chart.png",
                          webViewLink:
                            "https://drive.google.com/file/d/drive-file-id/view",
                        }
                      : { status: "not_synced" },
                },
                {
                  id: "file-2",
                  filename: "data.csv",
                  contentType: "text/csv",
                  size: 2048,
                  url: "https://example.com/data.csv",
                  createdAt: "2026-03-10T00:00:00Z",
                  googleDriveSync: { status: "not_synced" },
                },
              ],
            },
          ],
        });
      }),
      mockApi(
        chatThreadArtifactsContract.syncGoogleDrive,
        ({ body, respond }) => {
          syncBodies.push(body);
          return respond(200, {
            id: "drive-file-id",
            name: "chart.png",
            webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
          });
        },
      ),
    );
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    click(button);
    await user.click(await screen.findByLabelText("Open artifact chart.png"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Share artifact"));
    expect(writeTextSpy).toHaveBeenCalledWith(publicFileUrl);

    const downloadButton = screen.getByLabelText("Download artifact");
    await user.hover(downloadButton);
    await waitFor(() => {
      expect(
        getRoleByText("menuitem", "Upload to Google Drive"),
      ).toBeInTheDocument();
    });
    fireEvent.pointerLeave(downloadButton);
    await waitFor(() => {
      expect(
        queryRoleByText("menuitem", "Upload to Google Drive"),
      ).toBeUndefined();
    });

    await user.click(downloadButton);
    await user.click(await screen.findByText("Upload to Google Drive"));

    await waitFor(() => {
      expect(syncBodies).toStrictEqual([
        {
          runId: "run-artifacts-actions",
          fileId: "file-1",
        },
      ]);
    });
    await user.click(downloadButton);
    await waitFor(() => {
      expect(
        getRoleByText("menuitem", "Synced to Google Drive"),
      ).toHaveAttribute("aria-disabled", "true");
    });
    await user.keyboard("{Escape}");
  });

  it("hides presentation PPTX download when the feature switch is disabled", async () => {
    const user = userEvent.setup();
    const fileUrl = "https://demo-deck.sites.vm0.io";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create slides",
          runId: "run-presentation-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setMockConnectors([]);
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-presentation-artifact",
              files: [
                {
                  id: fileUrl,
                  filename: "demo-deck.html",
                  contentType: "text/html",
                  size: 4096,
                  url: fileUrl,
                  artifactKind: "presentation-html",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: {
        [FeatureSwitchKey.PresentationHtmlPptxDownload]: false,
      },
    });

    click(await screen.findByLabelText("Open artifacts"));
    await user.click(
      await screen.findByLabelText("Open artifact demo-deck.html"),
    );
    const downloadButton = await screen.findByLabelText("Download artifact");
    await user.click(downloadButton);

    await waitFor(() => {
      expect(queryRoleByText("menuitem", "Download")).toBeInTheDocument();
    });
    expect(queryRoleByText("menuitem", "Download (.pptx)")).toBeUndefined();
  });

  it("downloads presentation HTML artifacts as PPTX when the feature switch is enabled", async () => {
    const user = userEvent.setup();
    const fileUrl = "https://demo-deck.sites.vm0.io";
    let presentationHtmlRequested = false;
    const presentationHtml = `
      <!doctype html>
      <html>
        <head><title>Demo deck</title></head>
        <body>
          <section data-vm0-slide>
            <h1>Demo deck</h1>
          </section>
        </body>
      </html>
    `;
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Create slides",
          runId: "run-presentation-artifact",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setMockConnectors([]);
    server.use(
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-presentation-artifact",
              files: [
                {
                  id: fileUrl,
                  filename: "demo-deck.html",
                  contentType: "text/html",
                  size: 4096,
                  url: fileUrl,
                  artifactKind: "presentation-html",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
      http.get(fileUrl, () => {
        presentationHtmlRequested = true;
        return HttpResponse.html(presentationHtml);
      }),
      http.get("/__vm0-dev-artifact-fetch", ({ request }) => {
        const requestUrl = new URL(request.url);
        if (requestUrl.searchParams.get("url") !== fileUrl) {
          return new HttpResponse(null, { status: 404 });
        }
        presentationHtmlRequested = true;
        return HttpResponse.html(presentationHtml);
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: {
        [FeatureSwitchKey.PresentationHtmlPptxDownload]: true,
      },
    });

    click(await screen.findByLabelText("Open artifacts"));
    await user.click(
      await screen.findByLabelText("Open artifact demo-deck.html"),
    );
    await user.click(await screen.findByLabelText("Download artifact"));
    await user.click(await screen.findByText("Download (.pptx)"));

    await waitFor(() => {
      expect(presentationHtmlRequested).toBeTruthy();
    });
  });

  it("opens Google Drive OAuth in a new tab and syncs after the connector event", async () => {
    const user = userEvent.setup();
    const fileUrl = "https://example.com/disconnected-chart.png";
    let authorizeCalled = false;
    let syncSawAuthorize = false;
    let syncBody: unknown;
    mockConnectorOauthStart();
    const mockWindow = createMockAuthWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWindow as unknown as Window);

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "See attached",
          runId: "run-artifacts-disconnected-actions",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setMockConnectors([]);
    server.use(
      http.get(fileUrl, () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        });
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        return respond(200, {
          runs: [
            {
              runId: "run-artifacts-disconnected-actions",
              files: [
                {
                  id: "file-disconnected",
                  filename: "disconnected-chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: fileUrl,
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
      mockApi(
        chatThreadArtifactsContract.syncGoogleDrive,
        ({ body, respond }) => {
          syncSawAuthorize = authorizeCalled;
          syncBody = body;
          return respond(200, {
            id: "drive-file-id",
            name: "disconnected-chart.png",
            webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
          });
        },
      ),
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: [] });
      }),
      mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
        authorizeCalled = body.enabledTypes.includes("google-drive");
        return respond(200, { enabledTypes: body.enabledTypes });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    click(button);
    await user.click(
      await screen.findByLabelText("Open artifact disconnected-chart.png"),
    );

    const downloadButton = await waitFor(() => {
      return screen.getByLabelText("Download artifact");
    });

    await user.click(downloadButton);
    const connectGoogleDriveItem = await screen.findByText(
      "Connect Google Drive",
    );
    await user.hover(connectGoogleDriveItem);
    await expect(
      screen.findAllByText("Connect Google Drive to upload artifacts"),
    ).resolves.not.toHaveLength(0);
    await user.click(connectGoogleDriveItem);
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "about:blank",
        "_blank",
        "width=600,height=700",
      );
      expect(mockWindow.location.href).toBe(
        "https://oauth.test/google-drive/authorize",
      );
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });
    expect(syncBody).toBeUndefined();

    setMockConnectors([
      {
        id: "00000000-0000-4000-8000-000000000000",
        type: "google-drive",
        authMethod: "oauth",
        externalId: "drive-user",
        externalUsername: "Drive User",
        externalEmail: "drive@example.com",
        oauthScopes: ["https://www.googleapis.com/auth/drive"],
        connectionStatus: "connected",
        tokenExpiresAt: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    triggerAblyEvent("connector:changed");

    await waitFor(() => {
      expect(syncBody).toStrictEqual({
        runId: "run-artifacts-disconnected-actions",
        fileId: "file-disconnected",
      });
      expect(syncSawAuthorize).toBeTruthy();
    });
  });
});

describe("zero chat thread page display - GitHub PR tracking", () => {
  function setConnectedGithubConnector() {
    setMockConnectors([
      {
        id: "00000000-0000-4000-8000-000000000010",
        type: "github",
        authMethod: "oauth",
        externalId: "github-user",
        externalUsername: "octocat",
        externalEmail: "octocat@example.com",
        oauthScopes: ["repo", "workflow"],
        connectionStatus: "connected",
        tokenExpiresAt: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
  }

  it("opens a docked panel with tracked GitHub PR action status when enabled and authorized", async () => {
    const user = userEvent.setup();
    let prsRequests = 0;
    const sentPrompts: string[] = [];
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Created https://github.com/vm0-ai/vm0/pull/15070 and waiting on CI.",
          runId: "run-github-pr-tracking",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setConnectedGithubConnector();
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        labelListeners: [
          {
            id: "a0000000-0000-4000-a000-000000000010",
            labelName: "pr-review-merge",
            triggerMode: "created_by_me",
            prompt: "review",
            enabled: true,
            canManage: true,
            agent: {
              id: "c0000000-0000-4000-a000-000000000001",
              name: "zero",
            },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          },
        ],
      }),
    );
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["github"] });
      }),
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        if ("prompt" in body && body.prompt) {
          sentPrompts.push(body.prompt);
        }
        return respond(201, {
          runId: null,
          threadId: "thread-test-1",
        });
      }),
      mockApi(chatThreadGithubPrsContract.list, ({ params, respond }) => {
        prsRequests += 1;
        expect(params.threadId).toBe("thread-test-1");
        return respond(200, {
          prs: [
            {
              repo: "vm0-ai/vm0",
              number: 15_070,
              title: "Add GitHub PR tracking",
              url: "https://github.com/vm0-ai/vm0/pull/15070",
              state: "open",
              headSha: "abc123",
              mergeStatus: "ready",
              rollup: "success",
              checks: [
                {
                  name: "CI",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/1",
                  startedAt: "2026-06-02T00:00:00Z",
                  completedAt: "2026-06-02T00:01:00Z",
                },
              ],
            },
            {
              repo: "vm0-ai/vm0",
              number: 15_071,
              title: "Fix merge conflict",
              url: "https://github.com/vm0-ai/vm0/pull/15071",
              state: "open",
              headSha: "def456",
              mergeStatus: "conflicts",
              rollup: "failure",
              checks: [
                {
                  name: "Build",
                  status: "completed",
                  conclusion: "failure",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/2",
                  startedAt: "2026-06-02T00:00:00Z",
                  completedAt: "2026-06-02T00:01:00Z",
                },
                {
                  name: "Deploy",
                  status: "in_progress",
                  conclusion: null,
                  url: "https://github.com/vm0-ai/vm0/actions/runs/3",
                  startedAt: "2026-06-02T00:02:00Z",
                  completedAt: null,
                },
                {
                  name: "Lint",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/4",
                  startedAt: "2026-06-02T00:03:00Z",
                  completedAt: "2026-06-02T00:04:00Z",
                },
                {
                  name: "Test",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/5",
                  startedAt: "2026-06-02T00:04:00Z",
                  completedAt: "2026-06-02T00:05:00Z",
                },
                {
                  name: "Package",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/6",
                  startedAt: "2026-06-02T00:05:00Z",
                  completedAt: "2026-06-02T00:06:00Z",
                },
                {
                  name: "Security",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/7",
                  startedAt: "2026-06-02T00:06:00Z",
                  completedAt: "2026-06-02T00:07:00Z",
                },
                {
                  name: "E2E",
                  status: "completed",
                  conclusion: "success",
                  url: "https://github.com/vm0-ai/vm0/actions/runs/8",
                  startedAt: "2026-06-02T00:07:00Z",
                  completedAt: "2026-06-02T00:08:00Z",
                },
              ],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open GitHub PR tracking");
    });
    expect(prsRequests).toBe(0);
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText("GitHub PRs")).toBeInTheDocument();
    });
    expect(screen.getByText("vm0-ai/vm0 #15070")).toBeInTheDocument();
    expect(screen.getByText("Add GitHub PR tracking")).toBeInTheDocument();
    expect(screen.getByText("Ready to merge")).toBeInTheDocument();
    expect(screen.getByText("Fix merge conflict")).toBeInTheDocument();
    expect(screen.getByText("Conflicts")).toBeInTheDocument();
    expect(screen.queryByText("Passing")).not.toBeInTheDocument();
    expect(
      screen
        .getByText("Fix merge conflict")
        .compareDocumentPosition(screen.getByText("Add GitHub PR tracking")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("CI")).toBeInTheDocument();
    expect(screen.getAllByText("Success").length).toBeGreaterThan(0);
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("E2E")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(
      screen
        .getByText("Build")
        .compareDocumentPosition(screen.getByText("Deploy")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(queryRoleByText("link", "Open PR")).toBeUndefined();
    expect(queryRoleByText("link", "CI")).toBeUndefined();
    const ciRow = screen.getByText("CI").closest("details");
    expect(ciRow).toBeInstanceOf(HTMLDetailsElement);
    if (!(ciRow instanceof HTMLDetailsElement)) {
      throw new Error("CI check row was not rendered");
    }
    expect(ciRow.open).toBeFalsy();
    await user.click(screen.getByText("CI"));
    expect(ciRow.open).toBeTruthy();
    expect(within(ciRow).getByText("Started")).toBeVisible();
    expect(within(ciRow).getByText("Completed")).toBeVisible();
    const actionLink = queryAllByRoleFast("link", ciRow).find((link) => {
      return link.textContent?.trim() === "Open action";
    });
    expect(actionLink).toBeDefined();
    expect(actionLink).toHaveAttribute(
      "href",
      "https://github.com/vm0-ai/vm0/actions/runs/1",
    );

    await user.click(getRoleByText("button", "Fix conflict"));
    expect(sentPrompts).toContain("fix pr 15071 conflict & push");

    const addLabelButton = queryRoleByAriaLabel(
      "button",
      "Add label to PR 15070",
    );
    expect(addLabelButton).toBeDefined();
    await user.click(addLabelButton!);
    await user.click(getRoleByText("menuitem", "pr-review-merge"));
    expect(sentPrompts).toContain('add label "pr-review-merge" to pr 15070');
    expect(prsRequests).toBeGreaterThan(0);
  });

  it("hides add label when no GitHub integration labels are configured", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Created https://github.com/vm0-ai/vm0/pull/15070 and waiting on CI.",
          runId: "run-github-pr-tracking-no-labels",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    setConnectedGithubConnector();
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({ labelListeners: [] }),
    );
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["github"] });
      }),
      mockApi(chatThreadGithubPrsContract.list, ({ respond }) => {
        return respond(200, {
          prs: [
            {
              repo: "vm0-ai/vm0",
              number: 15_070,
              title: "Add GitHub PR tracking",
              url: "https://github.com/vm0-ai/vm0/pull/15070",
              state: "open",
              headSha: "abc123",
              mergeStatus: "ready",
              rollup: "success",
              checks: [],
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    await user.click(await screen.findByLabelText("Open GitHub PR tracking"));

    await waitFor(() => {
      expect(screen.getByText("Add GitHub PR tracking")).toBeInTheDocument();
    });
    expect(screen.queryByText("Add label")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.getAttribute("aria-label")?.startsWith("Add label to PR");
      }),
    ).toBeFalsy();
  });

  it("hides the GitHub PR tracking button when the agent is not authorized", async () => {
    let authorizationRequests = 0;
    mockChatLifecycle();
    setConnectedGithubConnector();
    server.use(
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        authorizationRequests += 1;
        return respond(200, { enabledTypes: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    await waitFor(() => {
      expect(authorizationRequests).toBeGreaterThan(0);
    });
    expect(
      screen.queryByLabelText("Open GitHub PR tracking"),
    ).not.toBeInTheDocument();
  });
});

// CHAT-D-043: Message status indicators render in ChatMessageRow
describe("zero chat thread page display - message status indicators", () => {
  it("displays a Stop button status indicator when a run is active", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          runId: "run-1",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-1",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - manual history button", () => {
  it("shows load history by default when history exists", async () => {
    mockChatLifecycle({
      historyMessages: [
        {
          role: "user",
          content: "Older message",
          createdAt: "2026-03-09T23:59:59Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
    expect(screen.getByText("Load history")).toBeInTheDocument();
  });

  it("shows load history when the feature switch is on and history exists", async () => {
    mockChatLifecycle({
      historyMessages: [
        {
          role: "user",
          content: "Older message",
          createdAt: "2026-03-09T23:59:59Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(screen.getByText("Load history")).toBeInTheDocument();
    });
  });
});
