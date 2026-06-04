import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { mockUploadSuccess } from "../../../mocks/upload-helpers.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { setMockUserModelPreference } from "../../../mocks/handlers/api-user-model-preference.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const CHAT_PATH = `/agents/${AGENT_ID}/chat`;

interface TestClipboardItemInstance {
  items: Record<string, Blob>;
}

class TestClipboardItem implements TestClipboardItemInstance {
  readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

function setupRichClipboardCapture() {
  const writeMock = vi.fn<(items: ClipboardItem[]) => Promise<void>>();
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    value: {
      write: writeMock,
      writeText: vi.fn<(data: string) => Promise<void>>(),
    },
    writable: true,
    configurable: true,
  });
  return writeMock;
}

function mockConnectors() {
  setMockConnectors([
    {
      id: "d0000001-0000-4000-a000-000000000001",
      type: "github",
      authMethod: "oauth",
      externalId: null,
      externalUsername: "testuser",
      externalEmail: null,
      oauthScopes: ["repo"],
      needsReconnect: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "d0000002-0000-4000-a000-000000000002",
      type: "linear",
      authMethod: "oauth",
      externalId: null,
      externalUsername: "linearuser",
      externalEmail: null,
      oauthScopes: [],
      needsReconnect: false,
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: ["github"] });
    }),
    mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
      return respond(200, { enabledTypes: ["github", "linear"] });
    }),
  );
}

describe("zero chat composer - textarea interaction", () => {
  // CHAT-I-022
  it("updates textarea value to reflect typed text", async () => {
    mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await fill(textarea, "Hello world");

    expect(textarea.value).toBe("Hello world");
  });
});

describe("zero chat composer - file input", () => {
  beforeEach(() => {
    // Pin a vision-capable model — the workspace default model does not accept
    // image/video attachments, which the composer silently drops.
    setMockUserModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  });

  // CHAT-I-022
  it("renders attachment button with correct accessible label", async () => {
    mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    // Attachment button renders with aria-label for accessibility
    const attachButton = screen.getByLabelText("Attach");
    expect(attachButton).toBeInTheDocument();
  });

  it("allows common office document extensions in the file picker", async () => {
    mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(fileInput.getAttribute("accept")).toContain(".xlsx");
    expect(fileInput.getAttribute("accept")).toContain(".pptx");
    expect(fileInput.getAttribute("accept")).toContain(".docx");
  });

  // CHAT-I-023
  it("shows attachment chip after a file is selected via the file input", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();
    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "test.png",
        contentType: "image/png",
        size: 1024,
        url: "https://example.com/test.png",
      }),
    );

    detachedSetupPage({ context, path: CHAT_PATH });

    // Wait for the chat composer to be fully rendered
    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(fileInput).toBeInTheDocument();

    const file = new File(["content"], "test.png", { type: "image/png" });
    await user.upload(fileInput, file);

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open image preview for test.png"),
      ).toBeInTheDocument();
    });
  });

  it("restores copied chat message attachments when pasted into the composer", async () => {
    const writeMock = setupRichClipboardCapture();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Review this",
          createdAt: "2026-03-10T00:00:00Z",
          attachFiles: [
            {
              id: "file-1",
              filename: "spec.pdf",
              contentType: "application/pdf",
              size: 1234,
              url: "https://cdn.vm7.io/artifacts/user-1/file-1/spec.pdf",
            },
          ],
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const copyButton = await waitFor(() => {
      return screen.getByLabelText("Copy message");
    });
    click(copyButton);

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith([expect.any(TestClipboardItem)]);
    });
    const item = writeMock.mock.calls[0]?.[0][0] as unknown as
      | TestClipboardItemInstance
      | undefined;
    const html = await item!.items["text/html"]!.text();
    const text = await item!.items["text/plain"]!.text();

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/html"
            ? html
            : type === "text/plain"
              ? text
              : "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Review this");
      expect(screen.getByLabelText("Remove spec.pdf")).toBeInTheDocument();
    });
  });

  it("preserves clipboard text when pasting files from a mixed external clipboard", async () => {
    mockChatLifecycle();
    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "photo.png",
        contentType: "image/png",
        size: 3,
        url: "https://example.com/photo.png",
      }),
    );

    detachedSetupPage({ context, path: CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    const file = new File(["png"], "photo.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/plain" ? "Please use this image" : "";
        },
        items: [
          {
            kind: "file",
            getAsFile: () => {
              return file;
            },
          },
        ],
      },
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Please use this image");
      expect(
        screen.getByLabelText("Open image preview for photo.png"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero chat composer - connectors popover", () => {
  // CHAT-I-024
  it("opens popover displaying connected connectors when clicked", async () => {
    mockChatLifecycle();
    mockConnectors();

    detachedSetupPage({ context, path: CHAT_PATH });

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });

    click(connectorsButton);

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });
  });

  // CHAT-I-025
  it("updates connector switch label in UI after toggling a connector", async () => {
    mockChatLifecycle();

    // Stateful connector: starts with GitHub enabled; after PUT, GET returns empty
    let githubEnabled = true;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, {
          connectors: [
            {
              id: "d0000001-0000-4000-a000-000000000001",
              type: "github",
              authMethod: "oauth",
              externalId: null,
              externalUsername: "testuser",
              externalEmail: null,
              oauthScopes: ["repo"],
              needsReconnect: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          configuredTypes: [],
          connectorProvidedBindings: [],
        });
      }),
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: githubEnabled ? ["github"] : [] });
      }),
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        githubEnabled = false;
        return respond(200, { enabledTypes: [] });
      }),
    );

    detachedSetupPage({ context, path: CHAT_PATH });

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });
    click(connectorsButton);

    // GitHub is enabled, so the switch label should be "Remove GitHub"
    const githubSwitch = await waitFor(() => {
      return screen.getByRole("switch", { name: "Remove GitHub" });
    });

    click(githubSwitch);

    // After toggling, the UI should reflect that GitHub is now removed
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Add GitHub" }),
      ).toBeInTheDocument();
    });
  });

  // CHAT-I-026
  it("shows add connectors dialog when Add connectors button is clicked", async () => {
    mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });
    click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });
    click(addButton);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: /Available connectors to connect/,
        }),
      ).toBeInTheDocument();
    });
  });
});

describe("zero chat composer - send and stop actions", () => {
  // CHAT-I-027
  it("sends message when Send button is clicked", async () => {
    mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await fill(textarea, "Hello");

    const sendButton = await waitFor(() => {
      return screen.getByLabelText("Send");
    });
    click(sendButton);

    // After sending, the Stop button should appear (message is being processed)
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  // CHAT-I-028
  it("displays Stop button while sending and cancels when clicked", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Hello");

    // Stop button should appear during send
    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop");
    });
    expect(stopButton).toBeInTheDocument();

    ctrl.cancelRun();
    click(stopButton);

    // After cancellation, send button should return
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  // CHAT-C-031
  it("shows Stop button only during an active sending operation", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    // Initially: no Stop button, Send button is present
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Stop")).toBeNull();

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Hello");

    // While sending: Stop button visible, Send hidden
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();
    });

    ctrl.completeRun("Done");

    // After completion: Stop gone, Send returns
    await waitFor(() => {
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });
});

describe("zero chat composer - add connectors dialog", () => {
  // CHAT-I-029
  it("filters connector list based on search query", async () => {
    mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });
    click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });
    click(addButton);

    const searchInput = await waitFor(() => {
      return screen.getByPlaceholderText("Find connectors...");
    });

    // Before filtering: GitHub should be visible
    await waitFor(() => {
      expect(screen.getByLabelText("Connect GitHub")).toBeInTheDocument();
    });

    // Type a filter that won't match GitHub
    await fill(searchInput, "Slack");

    await waitFor(() => {
      expect(screen.queryByLabelText("Connect GitHub")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Connect Slack")).toBeInTheDocument();
    });
  });

  // CHAT-I-030
  it("opens ConnectModal when a Connect button is clicked", async () => {
    mockChatLifecycle();

    detachedSetupPage({ context, path: CHAT_PATH });

    const connectorsButton = await waitFor(() => {
      return screen.getByLabelText("Connectors");
    });
    click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });
    click(addButton);

    // Verify unconnected connectors are listed
    const connectGitHubButton = await waitFor(() => {
      return screen.getByLabelText("Connect GitHub");
    });
    click(connectGitHubButton);

    // ConnectModal should appear as a dialog
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});
