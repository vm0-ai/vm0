import { describe, it, expect, vi, afterEach } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  slackConnectStatus$,
  effectiveStatus$,
  effectiveError$,
  connectSlackAccount$,
} from "../slack-connect-signals.ts";
import { updateSearchParams$ } from "../../route.ts";
import { setMockSlackConnectData } from "../../../mocks/handlers/api-integrations-slack-connect.ts";
import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

// The signal code sets window.location.href = "slack://open" on success,
// which changes happy-dom's location and corrupts subsequent tests.
// Reset the href after each test to prevent location pollution.
afterEach(() => {
  if (!window.location.href.startsWith("http://localhost")) {
    window.location.href = "http://localhost/settings/slack";
  }
});

function setup(path: string) {
  detachedSetupPage({
    context,
    path,
    withoutRender: true,
  });
}

describe("slack-connect-page signals", () => {
  describe("init: check connection status on mount", () => {
    it("should set status to success when already connected", async () => {
      setMockSlackConnectData({ isConnected: true });
      await setup("/settings/slack?w=ws1&u=user1");

      await vi.waitFor(() => {
        expect(context.store.get(slackConnectStatus$)).toBe("success");
      });
    });

    it("should stay idle when not connected", async () => {
      let checkCalled = false;
      server.use(
        mockApi(zeroSlackConnectContract.getStatus, ({ respond }) => {
          checkCalled = true;
          return respond(200, { isConnected: false, isAdmin: false });
        }),
      );
      await setup("/settings/slack?w=ws1&u=user1");

      await vi.waitFor(() => {
        expect(checkCalled).toBeTruthy();
      });
      expect(context.store.get(slackConnectStatus$)).toBe("idle");
    });

    it("should skip connection check when no workspace param", async () => {
      await setup("/settings/slack");

      expect(context.store.get(slackConnectStatus$)).toBe("idle");
    });
  });

  describe("effective status from URL params", () => {
    it("should return success when status=connected in URL", async () => {
      await setup("/settings/slack?status=connected");

      expect(context.store.get(effectiveStatus$)).toBe("success");
    });

    it("should return error when error param in URL", async () => {
      await setup("/settings/slack?error=Something+went+wrong");

      expect(context.store.get(effectiveStatus$)).toBe("error");
      expect(context.store.get(effectiveError$)).toBe("Something went wrong");
    });

    it("should return idle when no special URL params", async () => {
      await setup("/settings/slack");

      expect(context.store.get(effectiveStatus$)).toBe("idle");
    });
  });

  describe("connectSlackAccount$", () => {
    it("should set status to success on successful connect", async () => {
      setMockSlackConnectData({ isConnected: false });
      // Setup without w param to avoid init fetch, then add params for connect
      await setup("/settings/slack");
      context.store.set(
        updateSearchParams$,
        new URLSearchParams("w=ws1&u=user1"),
      );

      await context.store.set(connectSlackAccount$, context.signal);

      expect(context.store.get(slackConnectStatus$)).toBe("success");
    });

    it("should set status to error on failed connect", async () => {
      setMockSlackConnectData({ postError: "Account already linked" });
      // Setup without w param to avoid init fetch, then add params for connect
      await setup("/settings/slack");
      context.store.set(
        updateSearchParams$,
        new URLSearchParams("w=ws1&u=user1"),
      );

      // Error is handled via signal state — promise resolves without rejecting
      await context.store.set(connectSlackAccount$, context.signal);

      expect(context.store.get(slackConnectStatus$)).toBe("error");
      expect(context.store.get(effectiveError$)).toBe("Account already linked");
    });

    it("should not connect without workspace and user params", async () => {
      await setup("/settings/slack");

      await context.store.set(connectSlackAccount$, context.signal);

      expect(context.store.get(slackConnectStatus$)).toBe("idle");
    });
  });
});
