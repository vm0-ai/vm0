import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@okouai/ui/components/ui/sonner";
import { describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { click, fill } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  AGENT_ID,
  AGENT_CHAT_PATH,
  COMPUTER_USE_SELECTION_THREAD_ID,
  COMPUTER_USE_SEND_THREAD_ID,
  COMPUTER_USE_SAVED_SELECTION_THREAD_ID,
  mockChatLifecycleWithoutBrowserSession,
  mockMacUserAgentData,
  mockResizeObserver,
  computerUsePermissions,
  buttonByText,
  linkByText,
  queryLinkByText,
  chatComposerTextarea,
} from "./chat-lifecycle-test-helpers.ts";
import {
  billingStatus,
  composerElementFrom,
  placeCaretAfterText,
} from "./chat-composer-test-helpers.ts";

const WINDOWS_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const MAC_SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.6 Safari/605.1.15";

function pressVoiceInputShortcut(
  target: HTMLElement,
  options: {
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
  },
): boolean {
  return fireEvent.keyDown(target, {
    key: "E",
    code: "KeyE",
    shiftKey: true,
    ...options,
  });
}

async function enabledVoiceInputButton(): Promise<HTMLElement> {
  const voiceInput = await screen.findByLabelText("Voice input");
  await waitFor(() => {
    expect(voiceInput).toBeEnabled();
  });
  return voiceInput;
}

function computerUseRow(switchName: string): HTMLElement {
  const row = screen
    .getByRole("switch", { name: switchName })
    .closest("div.cursor-pointer");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No computer use row found for switch: ${switchName}`);
  }
  return row;
}

async function composerConnectorsButton(): Promise<HTMLElement> {
  const editor = await screen.findByPlaceholderText(PLACEHOLDER);
  const composer = editor.closest(".zero-composer");
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Chat composer not found");
  }
  return within(composer).getByLabelText("Connectors");
}

describe("chat lifecycle", () => {
  it("keeps Cloud browser and Computer Use mutually exclusive", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000719";
    const hostId = "11111111-1111-4111-8111-111111111111";
    const updates: {
      computerUseHostId: string | null;
      cloudBrowserEnabled?: boolean;
    }[] = [];
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      computerUseHostId: hostId,
      onComputerUseHostUpdate: (body) => {
        updates.push(body);
      },
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        computerUseHostId: hostId,
        cloudBrowserEnabled: false,
      },
    ]);
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            product: "okou",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());
    expect(screen.getByText("Your computer")).toBeInTheDocument();
    expect(screen.getByText("Okou")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Enable Cloud browser" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "Disconnect Studio Mac" }),
    ).toHaveAttribute("aria-checked", "true");

    await user.click(
      screen.getByRole("switch", { name: "Enable Cloud browser" }),
    );
    await waitFor(() => {
      expect(updates.at(-1)).toStrictEqual({
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      });
      expect(
        screen.getByRole("switch", { name: "Disable Cloud browser" }),
      ).toHaveAttribute("aria-checked", "true");
      expect(
        screen.getByRole("switch", { name: "Connect Studio Mac" }),
      ).toHaveAttribute("aria-checked", "false");
    });

    await user.click(
      screen.getByRole("switch", { name: "Connect Studio Mac" }),
    );
    await waitFor(() => {
      expect(updates.at(-1)).toStrictEqual({
        computerUseHostId: hostId,
        cloudBrowserEnabled: false,
      });
      expect(
        screen.getByRole("switch", { name: "Enable Cloud browser" }),
      ).toHaveAttribute("aria-checked", "false");
    });
  });

  it("keeps enabled Cloud browser and host rows untinted", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000720";
    const hostId = "11111111-1111-4111-8111-111111111112";
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      computerUseHostId: hostId,
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        computerUseHostId: hostId,
        cloudBrowserEnabled: false,
      },
    ]);
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());

    // Declared exception to the "no CSS class assertions" rule in
    // docs/testing/testing-external-behavior.md and AP-7 of
    // docs/testing/anti-patterns.md. jsdom loads no Tailwind stylesheet, so row
    // colour has no observable page surface and getComputedStyle cannot tell a
    // tinted row from an untinted one. The class assertion is the only way to
    // keep the selected-state tint from being reintroduced here.
    expect(computerUseRow("Disconnect Studio Mac")).not.toHaveClass(
      "bg-primary/5",
    );

    await user.click(
      screen.getByRole("switch", { name: "Enable Cloud browser" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Disable Cloud browser" }),
      ).toHaveAttribute("aria-checked", "true");
    });

    expect(computerUseRow("Disable Cloud browser")).not.toHaveClass(
      "bg-primary/5",
    );
  });

  it("keeps Cloud browser out of the Your computer group", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
    });

    await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await composerConnectorsButton());

    const cloudBrowserSwitch = await screen.findByRole("switch", {
      name: "Disable Cloud browser",
    });
    expect(screen.getByText("No online computers")).toBeInTheDocument();

    // Cloud browser is a Zero-hosted remote browser, not one of the user's own
    // machines, so its toggle must stay above the "Your computer" heading
    // instead of being listed under it. That heading labels the rows after it
    // rather than wrapping them, so document order is the only page-visible
    // expression of the grouping.
    expect(
      cloudBrowserSwitch.compareDocumentPosition(
        screen.getByText("Your computer"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps Cloud browser on while the preference feature is off", async () => {
    const user = userEvent.setup({ delay: null });
    let sentCloudBrowserEnabled: boolean | undefined;
    let sentComputerUseHostId: string | null | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentCloudBrowserEnabled = body.cloudBrowserEnabled;
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });
    context.mocks.data.userPreferences({
      cloudBrowserEnabledByDefault: false,
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await composerConnectorsButton());
    expect(
      screen.getByRole("switch", { name: "Disable Cloud browser" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");

    await sendMessageInUI(user, textarea, "Open a cloud browser");

    await waitFor(() => {
      expect(sentCloudBrowserEnabled).toBeTruthy();
      expect(sentComputerUseHostId).toBeUndefined();
    });
  });

  it("uses the disabled Cloud browser preference for a new chat thread", async () => {
    const user = userEvent.setup({ delay: null });
    let runCreated = false;
    let sentCloudBrowserEnabled: boolean | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runCreated = true;
        sentCloudBrowserEnabled = body.cloudBrowserEnabled;
      },
    });
    context.mocks.data.userPreferences({
      cloudBrowserEnabledByDefault: false,
    });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
      featureSwitches: {
        [FeatureSwitchKey.CloudBrowserPreference]: true,
      },
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await composerConnectorsButton());
    const cloudBrowserSwitch = await screen.findByRole("switch", {
      name: "Enable Cloud browser",
    });
    expect(cloudBrowserSwitch).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Escape}");

    await sendMessageInUI(user, textarea, "Keep the cloud browser closed");

    await waitFor(() => {
      expect(runCreated).toBeTruthy();
      expect(sentCloudBrowserEnabled).toBeUndefined();
    });
  });

  it("creates a new chat thread without Cloud browser after turning it off", async () => {
    const user = userEvent.setup({ delay: null });
    let runCreated = false;
    let sentCloudBrowserEnabled: boolean | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runCreated = true;
        sentCloudBrowserEnabled = body.cloudBrowserEnabled;
      },
    });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    click(await composerConnectorsButton());
    click(screen.getByRole("switch", { name: "Disable Cloud browser" }));
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Enable Cloud browser" }),
      ).toHaveAttribute("aria-checked", "false");
    });
    await sendMessageInUI(user, textarea, "Keep the cloud browser closed");

    await waitFor(() => {
      expect(runCreated).toBeTruthy();
      expect(sentCloudBrowserEnabled).toBeUndefined();
    });
  });

  it("replaces the new chat thread Cloud browser default with a Computer Use host", async () => {
    const user = userEvent.setup({ delay: null });
    const hostId = "55555555-5555-4555-8555-555555555555";
    let sentCloudBrowserEnabled: boolean | undefined;
    let sentComputerUseHostId: string | null | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentCloudBrowserEnabled = body.cloudBrowserEnabled;
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await composerConnectorsButton());
    expect(
      screen.getByRole("switch", { name: "Disable Cloud browser" }),
    ).toHaveAttribute("aria-checked", "true");

    const hostsGroup = await screen.findByRole("group", {
      name: "Computer Use hosts",
    });
    await user.click(within(hostsGroup).getByText("Studio Mac"));

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Enable Cloud browser" }),
      ).toHaveAttribute("aria-checked", "false");
      expect(
        screen.getByRole("switch", { name: "Disconnect Studio Mac" }),
      ).toHaveAttribute("aria-checked", "true");
    });
    await user.keyboard("{Escape}");

    await sendMessageInUI(user, textarea, "Open the app on my computer");

    await waitFor(() => {
      expect(sentComputerUseHostId).toBe(hostId);
      expect(sentCloudBrowserEnabled).toBeUndefined();
    });
  });

  it("shows online computers in the chat composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = COMPUTER_USE_SELECTION_THREAD_ID;
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      computerUseHostId: "22222222-2222-4222-8222-222222222222",
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        computerUseHostId: "22222222-2222-4222-8222-222222222222",
      },
    ]);
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            displayName: "Office Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:01:00Z",
            createdAt: "2026-06-10T11:01:00Z",
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            displayName: "Offline Desktop",
            appVersion: "1.0.0",
            osVersion: "Windows 11",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "offline",
            lastSeenAt: "2026-06-09T12:00:00Z",
            createdAt: "2026-06-09T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());

    await waitFor(() => {
      expect(screen.getByText("Studio Mac")).toBeInTheDocument();
      expect(screen.getByText("Office Mac")).toBeInTheDocument();
      expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();
      expect(screen.getByText("Connect my computer")).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: "Connect Studio Mac" }),
      ).toHaveAttribute("aria-checked", "false");
      expect(
        screen.getByRole("switch", { name: "Disconnect Office Mac" }),
      ).toHaveAttribute("aria-checked", "true");
    });

    const hostsGroup = screen.getByRole("group", {
      name: "Computer Use hosts",
    });
    expect(
      within(hostsGroup)
        .getAllByRole("switch")
        .map((item) => {
          return item.getAttribute("aria-label");
        }),
    ).toStrictEqual(["Connect Studio Mac", "Disconnect Office Mac"]);
  });

  it("opens the Computer Use download dialog from the chat composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000001";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());
    await user.click(await screen.findByText("Connect my computer"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Let Zero use your computer")).toBeInTheDocument();
    expect(
      screen.getByText(
        "So Zero can work in your browser and apps for you, even ones with no connector like LinkedIn or Reddit.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Requires an Apple silicon Mac with macOS 14 or newer. Intel Macs aren't supported.",
      ),
    ).toBeInTheDocument();
    const downloadLink = await waitFor(() => {
      return linkByText("Download for macOS");
    });
    expect(downloadLink).toHaveAttribute(
      "href",
      expect.stringContaining("/api/desktop/updates/stable/darwin/arm64/dmg"),
    );
  });

  it("uses Okou copy on an Okou host", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000005";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());
    await user.click(await screen.findByText("Connect my computer"));

    expect(screen.getByText("Let Okou use your computer")).toBeInTheDocument();
    expect(
      screen.getByText(
        "So Okou can work in your browser and apps for you, even ones with no connector like LinkedIn or Reddit.",
      ),
    ).toBeInTheDocument();
    const downloadLink = await waitFor(() => {
      return linkByText("Download for macOS");
    });
    expect(downloadLink).toHaveAttribute(
      "href",
      expect.stringContaining("/api/desktop/updates/stable/darwin/arm64/dmg"),
    );
  });

  it("blocks the Computer Use download dialog on Intel Macs", async () => {
    mockMacUserAgentData("x86");
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000002";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());
    await user.click(await screen.findByText("Connect my computer"));

    const requiredButton = await waitFor(() => {
      return buttonByText("Requires an Apple silicon Mac");
    });
    expect(requiredButton).toBeDisabled();
    expect(
      screen.getByText(
        "Requires an Apple silicon Mac with macOS 14 or newer. Intel Macs aren't supported.",
      ),
    ).toBeInTheDocument();
    expect(queryLinkByText("Download for macOS")).not.toBeInTheDocument();
  });

  it("does not auto-select the only online Computer Use host", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000003";
    let sentComputerUseHostId: string | null | undefined;
    mockChatLifecycle(context, {
      threadId,
      onRunCreate: (body) => {
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: "host-online",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());
    expect(
      screen.getByRole("switch", { name: "Connect Studio Mac" }),
    ).toHaveAttribute("aria-checked", "false");

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Open the app on my computer");

    await waitFor(() => {
      expect(
        screen.getByText("Open the app on my computer"),
      ).toBeInTheDocument();
      expect(sentComputerUseHostId).toBeUndefined();
    });
  });

  it("refreshes computers when the computer-use hosts Ably event arrives", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000004";
    let hostOnline = true;
    let requestCount = 0;
    mockChatLifecycle(context, { threadId });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      requestCount += 1;
      return respond(200, {
        hosts: [
          {
            id: "host-refresh",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: hostOnline ? "online" : "offline",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      sharedWorkerTestTransport: "message-port",
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("computerUseHostsChanged"),
      ).toBeTruthy();
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());

    await waitFor(() => {
      expect(screen.getByText("Studio Mac")).toBeInTheDocument();
    });

    const requestCountAfterInitialLoad = requestCount;
    hostOnline = false;

    context.mocks.ably.trigger("computerUseHostsChanged");

    await waitFor(() => {
      expect(requestCount).toBeGreaterThan(requestCountAfterInitialLoad);
      expect(screen.queryByText("Studio Mac")).not.toBeInTheDocument();
    });
  });

  it("persists the selected Computer Use host before sending", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = COMPUTER_USE_SEND_THREAD_ID;
    const hostId = "33333333-3333-4333-8333-333333333333";
    let sendCount = 0;
    let sentComputerUseHostId: string | null | undefined;
    let updatedComputerUseHostId: string | null | undefined;
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      onComputerUseHostUpdate: (body) => {
        updatedComputerUseHostId = body.computerUseHostId;
      },
      onRunCreate: (body) => {
        sendCount += 1;
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());
    const hostsGroup = await screen.findByRole("group", {
      name: "Computer Use hosts",
    });
    await user.click(within(hostsGroup).getByText("Studio Mac"));
    await waitFor(() => {
      expect(updatedComputerUseHostId).toBe(hostId);
    });

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await fill(textarea, "Open the app on my computer");
    const sendButton = screen.getByLabelText("Send");
    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    await user.click(sendButton);

    await waitFor(() => {
      expect(sendCount).toBe(1);
      expect(
        screen.getByText("Open the app on my computer"),
      ).toBeInTheDocument();
      expect(sentComputerUseHostId).toBeUndefined();
    });
  });

  it("shows and clears a saved Computer Use host selection", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = COMPUTER_USE_SAVED_SELECTION_THREAD_ID;
    const hostId = "11111111-1111-4111-8111-111111111111";
    let sentComputerUseHostId: string | null | undefined;
    let updatedComputerUseHostId: string | null | undefined;
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      threadTitle: "Computer Use",
      computerUseHostId: hostId,
      onComputerUseHostUpdate: (body) => {
        updatedComputerUseHostId = body.computerUseHostId;
      },
      onRunCreate: (body) => {
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: "Computer Use",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        computerUseHostId: hostId,
      },
    ]);
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());

    const selectedComputer = await screen.findByRole("switch", {
      name: "Disconnect Studio Mac",
    });
    expect(selectedComputer).toHaveAttribute("aria-checked", "true");
    await user.click(selectedComputer);
    await waitFor(() => {
      expect(updatedComputerUseHostId).toBeNull();
    });

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Do not use my computer");

    await waitFor(() => {
      expect(screen.getByText("Do not use my computer")).toBeInTheDocument();
      expect(sentComputerUseHostId).toBeUndefined();
    });
  });

  it("shows a saved offline Computer Use host selection", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "44444444-4444-4444-8444-444444444444";
    const hostId = "22222222-2222-4222-8222-222222222222";
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      threadTitle: "Computer Use",
      computerUseHostId: hostId,
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: "Computer Use",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        computerUseHostId: hostId,
      },
    ]);
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "offline",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());

    const hostName = await screen.findByText("Studio Mac");
    expect(hostName).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Disconnect Studio Mac" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("shows a computer use empty state when host listing is unavailable", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000005";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Computer Use is unavailable",
        },
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await composerConnectorsButton());

    await waitFor(() => {
      expect(screen.getByText("No online computers")).toBeInTheDocument();
      expect(screen.getByText("Connect my computer")).toBeInTheDocument();
    });
  });

  it("transcribes voice input into the composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000006";
    const draftPatches: unknown[] = [];
    const toastError = vi.spyOn(toast, "error");
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.patch("*/api/chat-threads/:id", async ({ request }) => {
      draftPatches.push(await request.json());
      return new Response(null, { status: 200 });
    });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: "Summarize the standup" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const textarea = await waitFor(() => {
      return chatComposerTextarea();
    });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(textarea).toHaveTextContent("Summarize the standup");
    });
    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftUserMessage: {
          version: 1,
          parts: [{ type: "text", text: "Summarize the standup" }],
        },
        draftAttachments: null,
      });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(toastError).not.toHaveBeenCalledWith("HTTP 200");
  });

  it("routes Ctrl+Shift+E to the focused chat composer and defaults to main on Windows", async () => {
    const mainThreadId = "e2000000-0000-4000-a000-000000000026";
    const sideThreadId = "e2000000-0000-4000-a000-000000000028";
    const transcripts = [
      "Main keyboard transcript",
      "Side keyboard transcript",
    ];
    let transcriptIndex = 0;
    context.mocks.browser.userAgent(WINDOWS_CHROME_USER_AGENT);
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockResizeObserver();
    const lifecycle = mockChatLifecycleWithoutBrowserSession({
      threadId: mainThreadId,
    });
    lifecycle.setThreadList([
      {
        id: mainThreadId,
        title: "Main voice thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: sideThreadId,
        title: "Side voice thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.http.post("*/api/voice-io/stt", () => {
      const text = transcripts[transcriptIndex];
      transcriptIndex += 1;
      return new Response(JSON.stringify({ text }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${mainThreadId}?sidebar=${sideThreadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerVoiceInputShortcut]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getAllByLabelText("Chat thread")).toHaveLength(2);
    });
    const mainThread = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${mainThreadId}"]`,
    );
    const sideThread = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${sideThreadId}"]`,
    );
    if (!mainThread || !sideThread) {
      throw new Error("Split chat threads not found");
    }
    const mainComposer = within(mainThread).getByPlaceholderText(PLACEHOLDER);
    const sideComposer = within(sideThread).getByPlaceholderText(PLACEHOLDER);
    const mainVoiceInput = within(mainThread).getByLabelText("Voice input");
    await waitFor(() => {
      expect(mainVoiceInput).toBeEnabled();
    });
    expect(mainVoiceInput).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+E Control+Shift+E",
    );

    const outsideThread = screen.getAllByLabelText("New chat")[0];
    if (!outsideThread) {
      throw new Error("New chat control not found");
    }
    outsideThread.focus();
    expect(
      pressVoiceInputShortcut(outsideThread, { ctrlKey: true }),
    ).toBeFalsy();

    await waitFor(() => {
      expect(
        within(mainThread).getByLabelText("Stop recording"),
      ).toBeInTheDocument();
    });

    expect(
      pressVoiceInputShortcut(outsideThread, { ctrlKey: true }),
    ).toBeFalsy();

    await waitFor(() => {
      expect(mainComposer).toHaveTextContent("Main keyboard transcript");
    });
    expect(sideComposer).not.toHaveTextContent("Main keyboard transcript");

    sideComposer.focus();
    expect(
      pressVoiceInputShortcut(sideComposer, { ctrlKey: true }),
    ).toBeFalsy();
    await waitFor(() => {
      expect(
        within(sideThread).getByLabelText("Stop recording"),
      ).toBeInTheDocument();
    });

    expect(
      pressVoiceInputShortcut(sideComposer, { ctrlKey: true }),
    ).toBeFalsy();
    await waitFor(() => {
      expect(sideComposer).toHaveTextContent("Side keyboard transcript");
    });
    expect(mainComposer).not.toHaveTextContent("Side keyboard transcript");
  });

  it("uses Command instead of Control for the agent chat voice shortcut on macOS", async () => {
    context.mocks.browser.userAgent(MAC_SAFARI_USER_AGENT);
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycleWithoutBrowserSession();
    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: "Mac transcript" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
      featureSwitches: {
        [FeatureSwitchKey.ComposerVoiceInputShortcut]: true,
      },
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    await enabledVoiceInputButton();

    expect(
      pressVoiceInputShortcut(document.body, { ctrlKey: true }),
    ).toBeTruthy();

    expect(
      pressVoiceInputShortcut(document.body, { metaKey: true }),
    ).toBeFalsy();

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    expect(
      pressVoiceInputShortcut(document.body, { metaKey: true }),
    ).toBeFalsy();
    await waitFor(() => {
      expect(composer).toHaveTextContent("Mac transcript");
    });
  });

  it("uses the latest assistant message as polish context", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000026";
    const rawTranscript = "um ship the nebula release";
    const polishedTranscript = "Ship the Project Nebula release.";
    const lastAssistantMessage =
      "The current release is called Project Nebula.";
    const polishBodies: unknown[] = [];
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "voice-draft-earlier-assistant",
          role: "assistant",
          content: "The earlier release was called Project Aurora.",
          runId: "voice-draft-earlier-run",
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T08:00:00Z",
        },
        {
          id: "voice-draft-latest-assistant",
          role: "assistant",
          content: lastAssistantMessage,
          runId: "voice-draft-latest-run",
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T08:01:00Z",
        },
      ],
    });

    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: rawTranscript }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.api(voiceIoPolishContract.post, ({ body, respond }) => {
      polishBodies.push(body);
      return respond(200, { text: polishedTranscript });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(composer).toHaveTextContent(polishedTranscript);
    });
    expect(polishBodies).toStrictEqual([
      { text: rawTranscript, lastAssistantMessage },
    ]);
  });

  it("replaces the composer footer while finishing a voice draft at the last selection", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000025";
    const rawTranscript = "um polished transcript";
    const polishedTranscript = "polished transcript";
    const polishRequested = context.mocks.deferred<void>();
    const polishReady = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: rawTranscript }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.api(voiceIoPolishContract.post, async ({ body, respond }) => {
      expect(body).toStrictEqual({ text: rawTranscript });
      polishRequested.resolve(undefined);
      await polishReady.promise;
      return respond(200, { text: polishedTranscript });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.VoiceDraft]: true,
        [FeatureSwitchKey.ComposerVoiceInputShortcut]: true,
      },
    });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });
    const composerShell = composerElementFrom(composer);
    await fill(composer, "Start  end");
    placeCaretAfterText(composer, "Start ");

    await user.click(await screen.findByLabelText("Voice input"));

    const finishRecording = await waitFor(() => {
      return buttonByText("OK", composerShell);
    });
    expect(finishRecording).toHaveAccessibleName("Stop recording");
    expect(within(composerShell).queryByLabelText("Send")).toBeNull();
    expect(within(composerShell).queryByLabelText("Voice input")).toBeNull();

    expect(
      pressVoiceInputShortcut(document.body, { ctrlKey: true }),
    ).toBeFalsy();
    await polishRequested.promise;

    await expect(
      within(composerShell).findByRole("status"),
    ).resolves.toHaveTextContent("Transcribing...");
    expect(within(composerShell).queryByLabelText("Send")).toBeNull();

    polishReady.resolve(undefined);

    await waitFor(() => {
      expect(composer.textContent).toBe("Start polished transcript end");
      expect(window.getSelection()?.toString()).toBe(polishedTranscript);
      expect(within(composerShell).getByLabelText("Send")).toBeEnabled();
      expect(within(composerShell).getByLabelText("Voice input")).toBeEnabled();
    });
  });

  it("keeps a voice draft hidden and unsendable until cleanup fails", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000022";
    const rawTranscript = "um ship Friday no Monday";
    const polishedTranscript = "Ship on Monday.";
    const draftPatches: unknown[] = [];
    let polishCalls = 0;
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.patch("*/api/chat-threads/:id", async ({ request }) => {
      draftPatches.push(await request.json());
      return new Response(null, { status: 200 });
    });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: rawTranscript }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.api(voiceIoPolishContract.post, ({ body, respond }) => {
      expect(body).toStrictEqual({ text: rawTranscript });
      polishCalls += 1;
      if (polishCalls === 1) {
        return respond(503, {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Voice draft cleanup is temporarily unavailable",
          },
        });
      }
      return respond(200, { text: polishedTranscript });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    const hiddenDraft = document.querySelector("[data-voice-draft]");
    expect(hiddenDraft).not.toBeNull();
    expect(hiddenDraft).not.toBeVisible();
    expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();

    composer.focus();
    await user.keyboard("{Control>}z{/Control}");
    const draftAfterUndo = document.querySelector("[data-voice-draft]");
    expect(draftAfterUndo).not.toBeNull();
    expect(draftAfterUndo).not.toBeVisible();
    expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Stop recording"));

    const failedDraft = await screen.findByLabelText("Voice draft");
    expect(failedDraft).toBeVisible();
    expect(failedDraft).toHaveTextContent(rawTranscript);
    expect(screen.getByLabelText("Send")).toBeDisabled();
    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftUserMessage: {
          version: 1,
          parts: [
            expect.objectContaining({
              type: "voice",
              transcript: rawTranscript,
            }),
          ],
        },
        draftAttachments: null,
      });
    });

    await user.click(buttonByText("Finish"));

    await waitFor(() => {
      expect(composer).toHaveTextContent(polishedTranscript);
      expect(screen.queryByLabelText("Voice draft")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeEnabled();
    });
    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftUserMessage: {
          version: 1,
          parts: [{ type: "text", text: polishedTranscript }],
        },
        draftAttachments: null,
      });
    });
    expect(polishCalls).toBe(2);

    composer.focus();
    await user.keyboard("{Control>}z{/Control}");

    const restoredDraft = await screen.findByLabelText("Voice draft");
    expect(restoredDraft).toBeVisible();
    expect(restoredDraft).toHaveTextContent(rawTranscript);
    expect(buttonByText("Finish")).toBeEnabled();
    expect(screen.getByLabelText("Remove voice draft")).toBeEnabled();
    expect(screen.getByLabelText("Send")).toBeDisabled();

    await user.click(screen.getByLabelText("Remove voice draft"));
    await waitFor(() => {
      expect(screen.queryByLabelText("Voice draft")).not.toBeInTheDocument();
    });
    await fill(composer, "Ready to send");
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });

  it("reveals a durable voice draft when a later segment reaches quota", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000024";
    const rawTranscript = "First raw segment";
    const firstRequestStarted = context.mocks.deferred<void>();
    const releaseFirstRequest = context.mocks.deferred<void>();
    const firstSpeechResumed = context.mocks.deferred<void>();
    const secondRequestStarted = context.mocks.deferred<void>();
    const releaseSecondRequest = context.mocks.deferred<void>();
    const secondSpeechResumed = context.mocks.deferred<void>();
    const draftPatches: unknown[] = [];
    let currentRms = 0.1;
    let transcriptionCalls = 0;
    let polishCalls = 0;
    context.mocks.browser.voiceInput({
      rms: () => {
        if (
          currentRms > 0 &&
          transcriptionCalls === 1 &&
          !firstSpeechResumed.settled()
        ) {
          firstSpeechResumed.resolve(undefined);
        }
        if (
          currentRms > 0 &&
          transcriptionCalls === 2 &&
          !secondSpeechResumed.settled()
        ) {
          secondSpeechResumed.resolve(undefined);
        }
        return currentRms;
      },
    });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: null });
    });
    context.mocks.http.patch("*/api/chat-threads/:id", async ({ request }) => {
      draftPatches.push(await request.json());
      return new Response(null, { status: 200 });
    });
    context.mocks.http.post("*/api/voice-io/stt", async () => {
      const requestIndex = transcriptionCalls;
      transcriptionCalls += 1;
      if (requestIndex === 0) {
        firstRequestStarted.resolve(undefined);
        await releaseFirstRequest.promise;
        return new Response(JSON.stringify({ text: rawTranscript }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      secondRequestStarted.resolve(undefined);
      await releaseSecondRequest.promise;
      return new Response(
        JSON.stringify({
          error: {
            code: "DAILY_RATE_LIMIT_EXCEEDED",
            message: "Daily request rate limit exceeded",
          },
          quota: { count: 500, limit: 500 },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    });
    context.mocks.api(voiceIoPolishContract.post, ({ respond }) => {
      polishCalls += 1;
      return respond(200, { text: "This should not be used." });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    currentRms = 0;
    await firstRequestStarted.promise;
    currentRms = 0.1;
    await firstSpeechResumed.promise;
    releaseFirstRequest.resolve(undefined);
    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftUserMessage: {
          version: 1,
          parts: [
            expect.objectContaining({
              type: "voice",
              transcript: rawTranscript,
            }),
          ],
        },
        draftAttachments: null,
      });
    });

    currentRms = 0;
    await secondRequestStarted.promise;
    currentRms = 0.1;
    await secondSpeechResumed.promise;
    releaseSecondRequest.resolve(undefined);

    const failedDraft = await screen.findByLabelText("Voice draft");
    expect(failedDraft).toBeVisible();
    expect(failedDraft).toHaveTextContent(rawTranscript);
    expect(screen.getByLabelText("Finish")).toBeEnabled();
    expect(screen.getByLabelText("Remove voice draft")).toBeEnabled();
    expect(screen.getByLabelText("Send")).toBeDisabled();
    await waitFor(() => {
      expect(screen.queryByLabelText("Stop recording")).not.toBeInTheDocument();
      expect(draftPatches.length).toBeGreaterThanOrEqual(2);
    });
    expect(transcriptionCalls).toBe(2);
    expect(polishCalls).toBe(0);
  });

  it("restores a persisted voice draft as an actionable blocked item", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000023";
    const rawTranscript = "uh email Alex tomorrow no Tuesday";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftUserMessage: {
          version: 1,
          parts: [
            {
              type: "voice",
              id: "15874914-6ca6-41eb-ad09-ac64bf0784ea",
              transcript: rawTranscript,
            },
          ],
        },
        draftAttachments: null,
      });
    });
    context.mocks.api(voiceIoPolishContract.post, ({ body, respond }) => {
      expect(body).toStrictEqual({ text: rawTranscript });
      return respond(200, { text: "Email Alex on Tuesday." });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    const restoredDraft = await screen.findByLabelText("Voice draft");
    expect(restoredDraft).toBeVisible();
    expect(restoredDraft).toHaveTextContent(rawTranscript);
    expect(screen.getByLabelText("Send")).toBeDisabled();

    await user.click(buttonByText("Finish"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Voice draft")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveTextContent(
        "Email Alex on Tuesday.",
      );
      expect(screen.getByLabelText("Send")).toBeEnabled();
    });
  });

  it("waits for active voice input before sending", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000778";
    const transcriptionRequested = context.mocks.deferred<void>();
    const transcriptionReady = context.mocks.deferred<void>();
    const submissionRequested = context.mocks.deferred<void>();
    const sentPrompts: string[] = [];
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, {
      threadId,
      onRunCreate: (body) => {
        if (body.prompt !== undefined) {
          sentPrompts.push(body.prompt);
        }
        submissionRequested.resolve(undefined);
      },
    });
    context.mocks.http.post("*/api/voice-io/stt", async () => {
      transcriptionRequested.resolve(undefined);
      await transcriptionReady.promise;
      return new Response(JSON.stringify({ text: "completed voice input" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });
    await fill(composer, "Typed introduction");
    const sendButton = screen.getByLabelText("Send");
    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    const firstRequest = Promise.race([
      (async () => {
        await transcriptionRequested.promise;
        return "transcription" as const;
      })(),
      (async () => {
        await submissionRequested.promise;
        return "submission" as const;
      })(),
    ]);
    await user.click(sendButton);

    await expect(firstRequest).resolves.toBe("transcription");
    expect(sentPrompts).toStrictEqual([]);

    await user.click(screen.getByLabelText("Send"));
    expect(submissionRequested.settled()).toBeFalsy();

    transcriptionReady.resolve(undefined);

    await waitFor(() => {
      expect(sentPrompts).toHaveLength(1);
    });
    expect(sentPrompts[0]).toContain("Typed introduction");
    expect(sentPrompts[0]).toContain("completed voice input");
    expect(sentPrompts[0]?.match(/completed voice input/g)).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
  });

  it("waits for voice input to finish starting before sending", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000779";
    const microphoneReady = context.mocks.deferred<void>();
    const submissionRequested = context.mocks.deferred<void>();
    const sentPrompts: string[] = [];
    context.mocks.browser.voiceInput({
      getUserMediaReady: microphoneReady.promise,
      rms: 0.1,
    });
    mockChatLifecycle(context, {
      threadId,
      onRunCreate: (body) => {
        if (body.prompt !== undefined) {
          sentPrompts.push(body.prompt);
        }
        submissionRequested.resolve(undefined);
      },
    });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: "startup voice input" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });
    await fill(composer, "Typed introduction");
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Starting voice input")).toBeDisabled();
    });

    await user.click(screen.getByLabelText("Send"));

    expect(submissionRequested.settled()).toBeFalsy();
    microphoneReady.resolve(undefined);

    await waitFor(() => {
      expect(sentPrompts).toHaveLength(1);
    });
    expect(sentPrompts[0]).toContain("Typed introduction");
    expect(sentPrompts[0]).toContain("startup voice input");
    await waitFor(() => {
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
  });

  it("transcribes a voice input segment after silence while recording", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000007";
    const draftPatches: unknown[] = [];
    const uploadedAudio: string[] = [];
    const transcriptionRequested = context.mocks.deferred<void>();
    const recorderTransitions: ("start" | "stop")[] = [];
    let transcriptionCalls = 0;
    context.mocks.browser.voiceInput({
      onRecorderStart: () => {
        recorderTransitions.push("start");
      },
      onRecorderStop: () => {
        recorderTransitions.push("stop");
      },
      rms: [0.1, 0.1, 0, 0, 0],
    });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.patch("*/api/chat-threads/:id", async ({ request }) => {
      draftPatches.push(await request.json());
      return new Response(null, { status: 200 });
    });
    context.mocks.http.post("*/api/voice-io/stt", async ({ request }) => {
      transcriptionRequested.resolve(undefined);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return new Response(null, { status: 400 });
      }
      uploadedAudio.push(await file.text());
      transcriptionCalls += 1;
      return new Response(JSON.stringify({ text: "First sentence" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    await transcriptionRequested.promise;
    expect(recorderTransitions.slice(0, 3)).toStrictEqual([
      "start",
      "stop",
      "start",
    ]);
    await waitFor(() => {
      expect(composer).toHaveTextContent("First sentence");
    });
    expect(transcriptionCalls).toBe(1);
    expect(uploadedAudio).toStrictEqual(["voice-1"]);
    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftUserMessage: {
          version: 1,
          parts: [{ type: "text", text: "First sentence" }],
        },
        draftAttachments: null,
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
    expect(transcriptionCalls).toBe(1);
    expect(recorderTransitions).toStrictEqual([
      "start",
      "stop",
      "start",
      "stop",
    ]);
  });

  it("uploads voice input segments one at a time", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000008";
    const firstRequestStarted = context.mocks.deferred<void>();
    const releaseFirstRequest = context.mocks.deferred<void>();
    const speechResumed = context.mocks.deferred<void>();
    const finalRecorderStopped = context.mocks.deferred<void>();
    let currentRms = 0.1;
    let recorderStopCount = 0;
    let requestCount = 0;
    let activeRequestCount = 0;
    let maxActiveRequestCount = 0;
    context.mocks.browser.voiceInput({
      onRecorderStop: () => {
        recorderStopCount += 1;
        if (recorderStopCount === 2) {
          finalRecorderStopped.resolve(undefined);
        }
      },
      rms: () => {
        if (
          currentRms > 0 &&
          firstRequestStarted.settled() &&
          !speechResumed.settled()
        ) {
          speechResumed.resolve(undefined);
        }
        return currentRms;
      },
    });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: null });
    });
    context.mocks.http.post("*/api/voice-io/stt", async () => {
      const requestIndex = requestCount;
      requestCount += 1;
      activeRequestCount += 1;
      maxActiveRequestCount = Math.max(
        maxActiveRequestCount,
        activeRequestCount,
      );
      if (requestIndex === 0) {
        firstRequestStarted.resolve(undefined);
        await releaseFirstRequest.promise;
      }
      activeRequestCount -= 1;
      return new Response(
        JSON.stringify({
          text: requestIndex === 0 ? "First sentence" : "Second sentence",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });
    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    currentRms = 0;
    await firstRequestStarted.promise;
    currentRms = 0.1;
    await speechResumed.promise;
    await user.click(screen.getByLabelText("Stop recording"));
    await finalRecorderStopped.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(requestCount).toBe(1);

    releaseFirstRequest.resolve(undefined);
    await waitFor(() => {
      expect(composer).toHaveTextContent("First sentence Second sentence");
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
    expect(requestCount).toBe(2);
    expect(maxActiveRequestCount).toBe(1);
  });

  it("automatically stops voice input after extended silence", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000009";
    let transcriptionCalls = 0;
    context.mocks.browser.voiceInput({ rms: [0.1, 0.1, 0, 0, 0] });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: 10 });
    });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      transcriptionCalls += 1;
      return new Response(JSON.stringify({ text: "Auto stopped note" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });

    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(composer).toHaveTextContent("Auto stopped note");
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
    expect(transcriptionCalls).toBe(1);
  });

  it("keeps a voice draft recording after extended silence", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000030";
    const silenceSegmentRequested = context.mocks.deferred<void>();
    const continuedSilenceObserved = context.mocks.deferred<void>();
    let sampleCount = 0;
    let continuedSilenceStartedAt: number | null = null;
    let transcriptionCalls = 0;
    let polishCalls = 0;
    context.mocks.browser.voiceInput({
      rms: () => {
        sampleCount += 1;
        if (sampleCount <= 2) {
          return 0.1;
        }
        if (silenceSegmentRequested.settled()) {
          continuedSilenceStartedAt ??= performance.now();
          if (performance.now() - continuedSilenceStartedAt >= 100) {
            continuedSilenceObserved.resolve(undefined);
          }
        }
        return 0;
      },
    });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: null });
    });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      transcriptionCalls += 1;
      silenceSegmentRequested.resolve(undefined);
      return new Response(JSON.stringify({ text: "Extended voice draft" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.api(voiceIoPolishContract.post, ({ respond }) => {
      polishCalls += 1;
      return respond(200, { text: "Extended voice draft." });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    await continuedSilenceObserved.promise;
    expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    expect(transcriptionCalls).toBe(1);
    expect(polishCalls).toBe(0);

    await user.click(screen.getByLabelText("Stop recording"));
    await waitFor(() => {
      expect(composer).toHaveTextContent("Extended voice draft.");
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
    expect(polishCalls).toBe(1);
  });

  it("appends a delayed voice input segment to the current composer text", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000010";
    const transcriptionReady = context.mocks.deferred<void>();
    const transcriptionRequested = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({ rms: [0.1, 0.1, 0, 0, 0] });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/voice-io/stt", async () => {
      transcriptionRequested.resolve(undefined);
      await transcriptionReady.promise;
      return new Response(JSON.stringify({ text: "voice segment" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER);
    });

    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    await transcriptionRequested.promise;
    await fill(composer, "manual note");
    transcriptionReady.resolve(undefined);

    await waitFor(() => {
      expect(composer).toHaveTextContent("manual note voice segment");
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
  });

  it("shows voice input starting state while the browser opens the microphone", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000011";
    const micReady = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({
      getUserMediaReady: micReady.promise,
      rms: 0.1,
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByLabelText("Starting voice input")).toBeDisabled();
    });
    expect(screen.queryByLabelText("Stop recording")).not.toBeInTheDocument();

    micReady.resolve(undefined);

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
  });

  it("keeps the composer footer visible until a voice draft microphone starts", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000026";
    const microphoneReady = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({
      getUserMediaReady: microphoneReady.promise,
      rms: 0.1,
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    const composerShell = composerElementFrom(composer);
    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(
        within(composerShell).getByLabelText("Starting voice input"),
      ).toBeDisabled();
    });
    expect(within(composerShell).getByLabelText("Send")).toBeInTheDocument();
    expect(document.querySelector("[data-voice-draft]")).toBeNull();
    expect(within(composerShell).queryByLabelText("Stop recording")).toBeNull();

    microphoneReady.resolve(undefined);

    await waitFor(() => {
      expect(
        within(composerShell).getByLabelText("Stop recording"),
      ).toBeEnabled();
    });
    expect(within(composerShell).queryByLabelText("Send")).toBeNull();
    expect(document.querySelector("[data-voice-draft]")).not.toBeNull();
  });

  it("restores the composer footer when a voice draft microphone fails to open", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000027";
    const microphoneReady = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({
      getUserMediaReady: microphoneReady.promise,
      rms: 0.1,
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    const composerShell = composerElementFrom(composer);
    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(
        within(composerShell).getByLabelText("Starting voice input"),
      ).toBeDisabled();
    });

    microphoneReady.reject(
      new DOMException("Microphone permission denied", "NotAllowedError"),
    );

    await waitFor(() => {
      expect(within(composerShell).getByLabelText("Voice input")).toBeEnabled();
    });
    expect(within(composerShell).getByLabelText("Send")).toBeInTheDocument();
    expect(within(composerShell).queryByLabelText("Stop recording")).toBeNull();
    expect(document.querySelector("[data-voice-draft]")).toBeNull();
  });

  it("scrolls sampled voice draft levels from right to left", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000028";
    let currentRms = 0.1;
    context.mocks.browser.voiceInput({
      rms: () => {
        return currentRms;
      },
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
    });

    await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await screen.findByLabelText("Voice input"));
    await screen.findByLabelText("Stop recording");

    const waveform = await waitFor(() => {
      const element = document.querySelector("[data-voice-level-waveform]");
      if (!(element instanceof HTMLElement)) {
        throw new Error("Voice level waveform not found");
      }
      return element;
    });
    const waveformHeights = () => {
      return Array.from(waveform.children, (bar) => {
        if (!(bar instanceof HTMLElement)) {
          throw new Error("Voice level bar not found");
        }
        return bar.style.height;
      });
    };

    await waitFor(() => {
      expect(waveformHeights().at(-1)).toBe("16px");
    });
    currentRms = 0;

    await waitFor(() => {
      const heights = waveformHeights();
      expect(heights.at(-1)).toBe("4px");
      expect(heights.slice(0, -1)).toContain("16px");
    });
  });

  it("starts recording before the voice activity monitor is ready", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000012";
    const audioReady = context.mocks.deferred<void>();
    let audioContextCloseCount = 0;
    context.mocks.browser.voiceInput({
      audioContextReady: audioReady.promise,
      onAudioContextClose: () => {
        audioContextCloseCount += 1;
      },
      rms: 0.1,
    });
    mockChatLifecycle(context, { threadId });
    let transcriptionCalled = false;
    context.mocks.http.post("*/api/voice-io/stt", () => {
      transcriptionCalled = true;
      return new Response(JSON.stringify({ text: "first words" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Starting voice input"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Stop recording"));
    await waitFor(() => {
      expect(audioContextCloseCount).toBe(1);
    });
    audioReady.resolve(undefined);

    await waitFor(() => {
      expect(transcriptionCalled).toBeTruthy();
      expect(textarea).toHaveTextContent("first words");
      expect(audioContextCloseCount).toBe(1);
    });
  });

  it("closes the voice audio context when its activity monitor fails", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000031";
    const audioReady = context.mocks.deferred<void>();
    let audioContextCloseCount = 0;
    context.mocks.browser.voiceInput({
      audioContextReady: audioReady.promise,
      onAudioContextClose: () => {
        audioContextCloseCount += 1;
      },
      rms: 0.1,
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await user.click(await enabledVoiceInputButton());
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    audioReady.reject(new Error("Audio activity monitor failed to start"));

    await waitFor(() => {
      expect(audioContextCloseCount).toBe(1);
    });
    expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
  });

  it("closes the voice audio context when page navigation aborts recording", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000032";
    const nextThreadId = "e2000000-0000-4000-a000-000000000033";
    let audioContextCloseCount = 0;
    context.mocks.browser.voiceInput({
      rms: 0.1,
      onAudioContextClose: () => {
        audioContextCloseCount += 1;
      },
    });
    const lifecycle = mockChatLifecycle(context, { threadId });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: "Recording voice thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: nextThreadId,
        title: "Other voice thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await user.click(await enabledVoiceInputButton());
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    await user.click(
      await waitFor(() => {
        return linkByText("Other voice thread");
      }),
    );

    await waitFor(() => {
      expect(document.title).toBe("Other voice thread | VM0");
      expect(audioContextCloseCount).toBe(1);
    });
  });

  it("cancels silent voice input without calling transcription", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e2000000-0000-4000-a000-000000000013";
    let audioContextCloseCount = 0;
    context.mocks.browser.voiceInput({
      rms: 0,
      onAudioContextClose: () => {
        audioContextCloseCount += 1;
      },
    });
    mockChatLifecycle(context, { threadId });
    let transcriptionCalled = false;
    context.mocks.http.post("*/api/voice-io/stt", () => {
      transcriptionCalled = true;
      return new Response(JSON.stringify({ text: "unexpected" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
      expect(audioContextCloseCount).toBe(1);
    });
    expect(transcriptionCalled).toBeFalsy();
    expect(textarea.textContent ?? "").toBe("");
  });

  it("opens billing recovery when voice input quota is depleted", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "e2000000-0000-4000-a000-000000000014";
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "AUDIO_INPUT_QUOTA_EXCEEDED",
            message: "Audio input quota exceeded",
          },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Voice input limit reached. Upgrade to Pro or Team for higher limits.",
        { id: "voice-input-quota-limit" },
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Choose a plan" }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Stop recording")).toBeNull();
    });
    expect(toastError).not.toHaveBeenCalledWith(
      "Voice transcription failed. Try again.",
    );
  });

  it("opens billing recovery before recording when voice input quota is already depleted", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "e2000000-0000-4000-a000-000000000015";
    let transcriptionCalls = 0;
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: false, count: 10, limit: 10 });
    });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      transcriptionCalls += 1;
      return new Response(JSON.stringify({ text: "Should not upload" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const voiceInput = await screen.findByLabelText("Voice input");
    expect(voiceInput).toBeEnabled();
    await user.click(voiceInput);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Voice input limit reached. Upgrade to Pro or Team for higher limits.",
        { id: "voice-input-quota-limit" },
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Choose a plan" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Stop recording")).toBeNull();
    expect(transcriptionCalls).toBe(0);
  });

  it("shows member guidance without opening billing when voice input is limited", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "e2000000-0000-4000-a000-000000000017";
    context.mocks.browser.voiceInput({ rms: 0.1 });
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "member",
    });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: false, count: 10, limit: 10 });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Voice input limit reached. Ask a workspace admin to upgrade for higher limits.",
        { id: "voice-input-quota-limit" },
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens billing with Team upgrade guidance for a Pro workspace admin", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "e2000000-0000-4000-a000-000000000018";
    context.mocks.browser.voiceInput({ rms: 0.1 });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus("pro"));
    });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: false, count: 10, limit: 10 });
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Voice input limit reached. Upgrade to Team for higher limits.",
        { id: "voice-input-quota-limit" },
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Choose a plan" }),
      ).toBeInTheDocument();
    });
  });

  it("shows Team upgrade guidance without opening billing for a Pro workspace member", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "e2000000-0000-4000-a000-000000000019";
    context.mocks.browser.voiceInput({ rms: 0.1 });
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "member",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus("pro"));
    });
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: false, count: 10, limit: 10 });
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Voice input limit reached. Ask a workspace admin to upgrade to Team for higher limits.",
        { id: "voice-input-quota-limit" },
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["team", "custom"] as const)(
    "shows reset guidance without opening billing for a %s workspace admin",
    async (tier) => {
      const user = userEvent.setup({ delay: null });
      const toastError = vi.spyOn(toast, "error");
      const threadId =
        tier === "team"
          ? "e2000000-0000-4000-a000-000000000020"
          : "e2000000-0000-4000-a000-000000000021";
      context.mocks.browser.voiceInput({ rms: 0.1 });
      context.mocks.api(billingStatusContract.get, ({ respond }) => {
        return respond(200, billingStatus(tier));
      });
      context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
        return respond(200, { allowed: false, count: 10, limit: 10 });
      });
      mockChatLifecycle(context, { threadId });

      detachedSetupPage({ context, path: `/chats/${threadId}` });

      await user.click(await screen.findByLabelText("Voice input"));

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith(
          "Voice input limit reached. Please wait for your limit to reset.",
          { id: "voice-input-quota-limit" },
        );
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("opens billing recovery when voice input daily request limit is reached", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "e2000000-0000-4000-a000-000000000016";
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/voice-io/stt", () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "DAILY_RATE_LIMIT_EXCEEDED",
            message: "Daily request rate limit exceeded",
          },
          quota: { count: 10, limit: 10 },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Voice input limit reached. Upgrade to Pro or Team for higher limits.",
        { id: "voice-input-quota-limit" },
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Choose a plan" }),
      ).toBeInTheDocument();
    });
  });
});
