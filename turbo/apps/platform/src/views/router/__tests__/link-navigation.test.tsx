/**
 * Navigation tests for Link component (views/router/link.tsx).
 * Tests href computation, children rendering, and click behavior.
 * Uses the sidebar navigation links as the host.
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  setMockComposesList,
  setMockTeam,
} from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIs() {
  setMockComposesList([]);
  // Seed the team with the default agent so setupAgentChatPage$ (reached
  // via the home redirect) does not treat the default agent as missing and
  // trigger an unhandled detached navigation rejection after the test ends.
  setMockTeam([
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
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        pinned: [],
        threads: [],
        hasMore: false,
        nextCursor: null,
        totalCount: 0,
      });
    }),
  );
}

describe("link component", () => {
  it("computed href attribute renders correctly (INFRA-D-010)", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/" });

    const link = await waitFor(() => {
      return screen.getByText("Agents").closest("a");
    });

    expect(link).toHaveAttribute("href", "/agents");
  });

  it("click navigates via custom handler (INFRA-D-012)", async () => {
    mockAPIs();

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    detachedSetupPage({ context, path: "/" });

    const link = await waitFor(() => {
      return screen.getByText("Agents").closest("a")!;
    });

    fireEvent.click(link!);

    await waitFor(() => {
      expect(pathname()).toBe("/agents");
    });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it("modifier click opens new tab (INFRA-D-013)", async () => {
    mockAPIs();

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    detachedSetupPage({ context, path: "/" });

    const link = await waitFor(() => {
      return screen.getByText("Agents").closest("a")!;
    });

    // meta click
    fireEvent.click(link!, { metaKey: true });

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/agents"),
        "_blank",
      );
    });

    openSpy.mockClear();

    // ctrl click
    fireEvent.click(link!, { ctrlKey: true });

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/agents"),
        "_blank",
      );
    });

    openSpy.mockClear();

    // shift click
    fireEvent.click(link!, { shiftKey: true });

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/agents"),
        "_blank",
      );
    });
  });
});
