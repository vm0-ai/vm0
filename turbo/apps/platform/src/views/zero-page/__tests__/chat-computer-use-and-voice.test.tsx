import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@vm0/ui/components/ui/sonner";
import { describe, expect, it, vi } from "vitest";
import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { zeroComputerUseHostsContract } from "@vm0/api-contracts/contracts/zero-computer-use";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { fill } from "../../../__tests__/page-helper.ts";
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
  mockMacUserAgentData,
  computerUsePermissions,
  buttonByText,
  linkByText,
  queryLinkByText,
  chatComposerTextarea,
} from "./chat-lifecycle-test-helpers.ts";

function computerUseRow(switchName: string): HTMLElement {
  const row = screen
    .getByRole("switch", { name: switchName })
    .closest("div.cursor-pointer");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No computer use row found for switch: ${switchName}`);
  }
  return row;
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
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
      featureSwitches: { [FeatureSwitchKey.ZeroBrowser]: true },
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await screen.findByLabelText("Connectors"));
    expect(screen.getByText("Your computer")).toBeInTheDocument();
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
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
      featureSwitches: { [FeatureSwitchKey.ZeroBrowser]: true },
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await screen.findByLabelText("Connectors"));

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

  it("creates a new chat thread with Cloud browser on by default", async () => {
    const user = userEvent.setup({ delay: null });
    let sentCloudBrowserEnabled: boolean | undefined;
    let sentComputerUseHostId: string | null | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentCloudBrowserEnabled = body.cloudBrowserEnabled;
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.ZeroBrowser]: true },
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await screen.findByLabelText("Connectors"));
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

  it("creates a new chat thread without Cloud browser after turning it off", async () => {
    const user = userEvent.setup({ delay: null });
    let sentCloudBrowserEnabled: boolean | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentCloudBrowserEnabled = body.cloudBrowserEnabled;
      },
    });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.ZeroBrowser]: true },
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await screen.findByLabelText("Connectors"));
    await user.click(
      screen.getByRole("switch", { name: "Disable Cloud browser" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Enable Cloud browser" }),
      ).toHaveAttribute("aria-checked", "false");
    });
    await user.keyboard("{Escape}");

    await sendMessageInUI(user, textarea, "Keep the cloud browser closed");

    await waitFor(() => {
      expect(sentCloudBrowserEnabled).toBeUndefined();
    });
  });

  it("hides Cloud browser from a new chat thread when the feature is disabled", async () => {
    const user = userEvent.setup({ delay: null });
    let sentCloudBrowserEnabled: boolean | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentCloudBrowserEnabled = body.cloudBrowserEnabled;
      },
    });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await screen.findByLabelText("Connectors"));
    expect(screen.getByText("Your computer")).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Disable Cloud browser" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Enable Cloud browser" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await sendMessageInUI(user, textarea, "No cloud browser here");

    await waitFor(() => {
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
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
      featureSwitches: { [FeatureSwitchKey.ZeroBrowser]: true },
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(await screen.findByLabelText("Connectors"));
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
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
    await user.click(await screen.findByLabelText("Connectors"));

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
    const threadId = "computer-use-download";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await screen.findByLabelText("Connectors"));
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
      expect.stringContaining(
        "/api/zero/desktop/updates/stable/darwin/arm64/dmg",
      ),
    );
  });

  it("blocks the Computer Use download dialog on Intel Macs", async () => {
    mockMacUserAgentData("x86");
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-download-intel";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await screen.findByLabelText("Connectors"));
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
    const threadId = "computer-use-manual-selection";
    let sentComputerUseHostId: string | null | undefined;
    mockChatLifecycle(context, {
      threadId,
      onRunCreate: (body) => {
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
    await user.click(await screen.findByLabelText("Connectors"));
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
    const threadId = "computer-use-refresh";
    let hostOnline = true;
    let requestCount = 0;
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("computerUseHostsChanged"),
      ).toBeTruthy();
    });

    await waitFor(() => {
      return chatComposerTextarea();
    });
    await user.click(await screen.findByLabelText("Connectors"));

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
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
    await user.click(await screen.findByLabelText("Connectors"));
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
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
    await user.click(await screen.findByLabelText("Connectors"));

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
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
    await user.click(await screen.findByLabelText("Connectors"));

    const hostName = await screen.findByText("Studio Mac");
    expect(hostName).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Disconnect Studio Mac" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("shows a computer use empty state when host listing is unavailable", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-forbidden";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
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
    await user.click(await screen.findByLabelText("Connectors"));

    await waitFor(() => {
      expect(screen.getByText("No online computers")).toBeInTheDocument();
      expect(screen.getByText("Connect my computer")).toBeInTheDocument();
    });
  });

  it("transcribes voice input into the composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "voice-input-thread";
    const draftPatches: unknown[] = [];
    const toastError = vi.spyOn(toast, "error");
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.patch(
      "*/api/zero/chat-threads/:id",
      async ({ request }) => {
        draftPatches.push(await request.json());
        return new Response(null, { status: 200 });
      },
    );
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: "Summarize the standup" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
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
    } finally {
      toastError.mockRestore();
    }
  });

  it("transcribes a voice input segment after silence while recording", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "voice-input-segment-thread";
    const draftPatches: unknown[] = [];
    const uploadedAudio: string[] = [];
    const transcriptionRequested = context.mocks.deferred<void>();
    let transcriptionCalls = 0;
    context.mocks.browser.voiceInput({ rms: [0.1, 0.1, 0, 0, 0] });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.patch(
      "*/api/zero/chat-threads/:id",
      async ({ request }) => {
        draftPatches.push(await request.json());
        return new Response(null, { status: 200 });
      },
    );
    context.mocks.http.post("*/api/zero/voice-io/stt", async ({ request }) => {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return new Response(null, { status: 400 });
      }
      uploadedAudio.push(await file.text());
      transcriptionCalls += 1;
      transcriptionRequested.resolve(undefined);
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
    // The silence-triggered segment upload reaching the server proves the
    // capture rotated recorders instead of ending the session; recording may
    // legitimately auto-stop moments later, so check the label now rather
    // than after the transcription response renders.
    await transcriptionRequested.promise;
    expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
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
  });

  it("automatically stops voice input after extended silence", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "voice-input-auto-stop-thread";
    let transcriptionCalls = 0;
    context.mocks.browser.voiceInput({ rms: [0.1, 0.1, 0, 0, 0] });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroVoiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: 10 });
    });
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
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

  it("appends a delayed voice input segment to the current composer text", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "voice-input-append-current-thread";
    const transcriptionReady = context.mocks.deferred<void>();
    const transcriptionRequested = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({ rms: [0.1, 0.1, 0, 0, 0] });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/zero/voice-io/stt", async () => {
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
    const threadId = "voice-input-starting-thread";
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

  it("starts recording before the voice activity monitor is ready", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "voice-input-monitor-pending-thread";
    const audioReady = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({
      audioContextReady: audioReady.promise,
      rms: 0.1,
    });
    mockChatLifecycle(context, { threadId });
    let transcriptionCalled = false;
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
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
    audioReady.resolve(undefined);

    await waitFor(() => {
      expect(transcriptionCalled).toBeTruthy();
      expect(textarea).toHaveTextContent("first words");
    });
  });

  it("cancels silent voice input without calling transcription", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "silent-voice-input-thread";
    context.mocks.browser.voiceInput({ rms: 0 });
    mockChatLifecycle(context, { threadId });
    let transcriptionCalled = false;
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
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
    });
    expect(transcriptionCalled).toBeFalsy();
    expect(textarea.textContent ?? "").toBe("");
  });

  it("opens billing recovery when voice input quota is depleted", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "voice-input-quota-thread";
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
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

    try {
      detachedSetupPage({ context, path: `/chats/${threadId}` });

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
          screen.getByRole("heading", { name: "Compare plans" }),
        ).toBeInTheDocument();
        expect(
          screen.getByText("Upgrade or downgrade anytime."),
        ).toBeInTheDocument();
      });
    } finally {
      toastError.mockRestore();
    }
  });

  it("opens billing recovery before recording when voice input quota is already depleted", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "voice-input-preflight-quota-thread";
    let transcriptionCalls = 0;
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroVoiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: false, count: 10, limit: 10 });
    });
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
      transcriptionCalls += 1;
      return new Response(JSON.stringify({ text: "Should not upload" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      detachedSetupPage({ context, path: `/chats/${threadId}` });

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
          screen.getByRole("heading", { name: "Compare plans" }),
        ).toBeInTheDocument();
      });
      expect(screen.queryByLabelText("Stop recording")).toBeNull();
      expect(transcriptionCalls).toBe(0);
    } finally {
      toastError.mockRestore();
    }
  });

  it("opens billing recovery when voice input daily request limit is reached", async () => {
    const user = userEvent.setup({ delay: null });
    const toastError = vi.spyOn(toast, "error");
    const threadId = "voice-input-daily-rate-thread";
    context.mocks.browser.voiceInput({ rms: 0.1 });
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
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

    try {
      detachedSetupPage({ context, path: `/chats/${threadId}` });

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
          screen.getByRole("heading", { name: "Compare plans" }),
        ).toBeInTheDocument();
      });
    } finally {
      toastError.mockRestore();
    }
  });
});
