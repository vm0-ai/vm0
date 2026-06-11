import { fireEvent, screen, waitFor } from "@testing-library/react";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockAPIs(): void {
  context.mocks.data.composesList([]);
  context.mocks.data.team([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(200, {
      pinned: [],
      threads: [],
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
    });
  });
}

describe("link navigation", () => {
  it("renders the not found page for unknown routes", async () => {
    detachedSetupPage({ context, path: "/missing-platform-route" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Page not found" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("The page you are looking for does not exist."),
      ).toBeInTheDocument();
    });
  });

  it("navigates in-app normally and opens a new tab for modified clicks", async () => {
    mockAPIs();
    const openedTargets = context.mocks.browser.open();

    detachedSetupPage({ context, path: "/" });

    const link = await waitFor(() => {
      return screen.getByText("Agents").closest("a");
    });
    expect(link).not.toBeNull();

    fireEvent.click(link!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /agents/i }),
      ).toBeInTheDocument();
    });
    expect(openedTargets.calls).toStrictEqual([]);

    fireEvent.click(link!, { metaKey: true });

    await waitFor(() => {
      expect(openedTargets.calls).toStrictEqual([
        expect.objectContaining({
          target: "_blank",
          url: expect.stringContaining("/agents"),
        }),
      ]);
    });
  });

  it("completes a sign-in token route and returns home", async () => {
    mockAPIs();

    detachedSetupPage({
      context,
      path: "/sign-in-token?token=clerk-ticket",
      user: null,
      session: null,
    });

    await waitFor(() => {
      expect(pathname()).toBe("/");
    });
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      strategy: "ticket",
      ticket: "clerk-ticket",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      session: "test-created-session-id",
    });
  });
});
