/**
 * Navigation tests for Link component (views/router/link.tsx).
 * Tests href computation, children rendering, and click behavior.
 * Uses the sidebar navigation links as the host.
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([]);
    }),
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({ composes: [] });
    }),
  );
}

describe("link component", () => {
  it("computed href attribute renders correctly (INFRA-D-010)", async () => {
    mockAPIs();
    await setupPage({ context, path: "/" });

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

    try {
      await setupPage({ context, path: "/" });

      const link = await waitFor(() => {
        return screen.getByText("Agents").closest("a")!;
      });

      const user = userEvent.setup();
      await user.click(link!);

      await waitFor(() => {
        expect(pathname()).toBe("/agents");
      });

      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("modifier click opens new tab (INFRA-D-013)", async () => {
    mockAPIs();

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    try {
      await setupPage({ context, path: "/" });

      const link = await waitFor(() => {
        return screen.getByText("Agents").closest("a")!;
      });

      const user = userEvent.setup();

      // meta click
      await user.keyboard("{Meta>}");
      await user.click(link!);
      await user.keyboard("{/Meta}");

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith(
          expect.stringContaining("/agents"),
          "_blank",
        );
      });

      openSpy.mockClear();

      // ctrl click
      await user.keyboard("{Control>}");
      await user.click(link!);
      await user.keyboard("{/Control}");

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith(
          expect.stringContaining("/agents"),
          "_blank",
        );
      });

      openSpy.mockClear();

      // shift click
      await user.keyboard("{Shift>}");
      await user.click(link!);
      await user.keyboard("{/Shift}");

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith(
          expect.stringContaining("/agents"),
          "_blank",
        );
      });
    } finally {
      openSpy.mockRestore();
    }
  });
});
