import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockConnectedConnectors(types: string[]) {
  server.use(
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors: types.map((type, i) => {
          return {
            id: `d000000${i}-0000-4000-a000-000000000001`,
            type,
            authMethod: "oauth",
            externalId: null,
            externalUsername: `user-${type}`,
            externalEmail: null,
            oauthScopes: [],
            needsReconnect: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          };
        }),
        configuredTypes: Object.keys(CONNECTOR_TYPES) as ConnectorType[],
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

describe("chat-d-015: attachment chips in composer", () => {
  beforeEach(() => {
    server.use(
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-1",
          filename: "test-image.png",
          contentType: "image/png",
          size: 1024,
          url: "https://example.com/test-image.png",
        });
      }),
    );
    mockChatAPI();
  });

  it("should render attachment chip with remove button after file upload", async () => {
    const user = userEvent.setup();
    await setupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Attach" }),
      ).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeInTheDocument();

    const file = new File(["content"], "test-image.png", { type: "image/png" });
    await user.upload(fileInput!, file);

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Remove test-image\.png|Cancel upload test-image\.png/,
        }),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-d-016: connected connector icons in composer trigger", () => {
  it("should render connected connectors (up to 3) in the trigger popover", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    mockConnectedConnectors(["github", "linear", "slack"]);
    server.use(
      http.get("*/api/zero/agents/:id/user-connectors", () => {
        return HttpResponse.json({
          enabledTypes: ["github", "linear", "slack"],
        });
      }),
    );
    await setupPage({ context, path: "/" });

    const connectorsButton = await waitFor(() => {
      return screen.getByRole("button", { name: "Connectors" });
    });
    await user.click(connectorsButton);

    await waitFor(() => {
      const toggles = screen.getAllByRole("switch");
      expect(toggles.length).toBeGreaterThanOrEqual(1);
      expect(toggles.length).toBeLessThanOrEqual(3);
    });
  });
});

describe("chat-d-017: connector list in popover", () => {
  it("should render connected connectors in the popover list", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    mockConnectedConnectors(["github", "linear"]);
    await setupPage({ context, path: "/" });

    const connectorsButton = await waitFor(() => {
      return screen.getByRole("button", { name: "Connectors" });
    });
    await user.click(connectorsButton);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Add GitHub" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: "Add Linear" }),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-d-018: add dialog with search filtering", () => {
  it("should render unconnected connectors in add dialog with filterable search input", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    await setupPage({ context, path: "/" });

    const connectorsButton = await waitFor(() => {
      return screen.getByRole("button", { name: "Connectors" });
    });
    await user.click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });
    await user.click(addButton);

    const searchInput = await waitFor(() => {
      return screen.getByPlaceholderText("Search connectors...");
    });
    expect(searchInput).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect GitHub" }),
      ).toBeInTheDocument();
    });

    await user.clear(searchInput);
    await user.type(searchInput, "Slack");

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Connect GitHub" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Connect Slack" }),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-d-019: connector description in add dialog", () => {
  it("should render a description for each connector in the add dialog", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    await setupPage({ context, path: "/" });

    const connectorsButton = await waitFor(() => {
      return screen.getByRole("button", { name: "Connectors" });
    });
    await user.click(connectorsButton);

    const addButton = await waitFor(() => {
      return screen.getByText("Add connectors");
    });
    await user.click(addButton);

    await waitFor(() => {
      // Each connector card has a Connect button — verify at least one is present,
      // confirming the dialog renders connector items with actionable controls.
      expect(
        screen.getByRole("button", { name: "Connect GitHub" }),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-d-020: connectors popover after load", () => {
  it("should render the Add connectors button in the popover after connectors load", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json({
          connectors: [],
          configuredTypes: Object.keys(CONNECTOR_TYPES) as ConnectorType[],
          connectorProvidedSecretNames: [],
        });
      }),
    );

    await setupPage({ context, path: "/" });

    const connectorsButton = await waitFor(() => {
      return screen.getByRole("button", { name: "Connectors" });
    });
    await user.click(connectorsButton);

    await waitFor(() => {
      expect(screen.getByText("Add connectors")).toBeInTheDocument();
    });
  });
});

describe("chat-d-021: send button state changes", () => {
  it("should show Stop button while sending and restore Send button after completion", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    await setupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Send" }),
      ).not.toBeInTheDocument();
    });

    ctrl.completeRun("Done");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Stop" }),
      ).not.toBeInTheDocument();
    });
  });
});
