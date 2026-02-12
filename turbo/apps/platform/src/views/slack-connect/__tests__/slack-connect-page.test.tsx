import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$, searchParams$ } from "../../../signals/route.ts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

describe("slack connect page", () => {
  it("redirects to provider-setup when no provider configured", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    // The redirect during setup causes an AbortError which is expected
    await setupPage({
      context,
      path: "/slack/connect?w=T123&u=U456&c=C789",
    }).catch(() => {});

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/provider-setup");
    });
    const params = context.store.get(searchParams$);
    // Should encode the return path back to /slack/connect with original params
    const returnUrl = params.get("return");
    expect(returnUrl).toContain("/slack/connect");
    expect(returnUrl).toContain("w=T123");
    expect(returnUrl).toContain("u=U456");
    expect(returnUrl).toContain("c=C789");
  });

  it("shows error when required params are missing", async () => {
    server.use(
      http.get("*/api/integrations/slack/link", () => {
        return HttpResponse.json({
          isLinked: false,
          workspaceName: null,
          agents: [],
        });
      }),
    );

    await setupPage({
      context,
      path: "/slack/connect",
    });

    // Without w and u params, initSlackConnect$ sets error state
    await vi.waitFor(() => {
      expect(
        screen.getByText("Invalid link. Missing required parameters."),
      ).toBeInTheDocument();
    });
  });

  it("shows connect page when provider exists and user is not linked", async () => {
    server.use(
      http.get("*/api/integrations/slack/link", () => {
        return HttpResponse.json({
          isLinked: false,
          workspaceName: "Test Workspace",
          isAdmin: false,
          defaultAgent: null,
          agents: [
            { id: "agent-1", name: "my-agent" },
            { id: "agent-2", name: "helper-bot" },
          ],
        });
      }),
    );

    await setupPage({
      context,
      path: "/slack/connect?w=T123&u=U456",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByText(
          "VM0 for Slack would like to connect to your VM0 account",
        ),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: "Authorize" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("shows already-connected state when user is linked", async () => {
    server.use(
      http.get("*/api/integrations/slack/link", () => {
        return HttpResponse.json({
          isLinked: true,
          workspaceName: "Test Workspace",
          isAdmin: true,
          defaultAgent: { id: "agent-1", name: "my-agent" },
          agents: [{ id: "agent-1", name: "my-agent" }],
        });
      }),
    );

    await setupPage({
      context,
      path: "/slack/connect?w=T123&u=U456",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Already Connected")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Your Slack account is already connected to VM0/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
  });

  it("calls link API and navigates to success page on Authorize", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/integrations/slack/link", () => {
        return HttpResponse.json({
          isLinked: false,
          workspaceName: "Test Workspace",
          isAdmin: false,
          defaultAgent: null,
          agents: [{ id: "agent-1", name: "my-agent" }],
        });
      }),
      http.post("*/api/integrations/slack/link", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({
      context,
      path: "/slack/connect?w=T123&u=U456&c=C789",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Authorize" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.slackUserId).toBe("U456");
    expect(capturedBody!.workspaceId).toBe("T123");
    expect(capturedBody!.channelId).toBe("C789");

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/slack/connect/success");
    });
    const params = context.store.get(searchParams$);
    expect(params.get("w")).toBe("T123");
    expect(params.get("c")).toBe("C789");
  });
});
