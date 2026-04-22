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
import { mockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract } from "@vm0/core";
import {
  setMockComposesList,
  setMockTeam,
} from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

function mockAPIs() {
  setMockComposesList([]);
  setMockTeam([]);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads: [] });
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
