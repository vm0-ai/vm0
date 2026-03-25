import { describe, it, expect, afterEach } from "vitest";
import { delay } from "signal-timers";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  slackConnectStatus$,
  effectiveStatus$,
  effectiveError$,
  connectSlackAccount$,
} from "../slack-connect-signals.ts";
import { updateSearchParams$ } from "../../route.ts";
import { setMockSlackConnectData } from "../../../mocks/handlers/api-integrations-slack-connect.ts";

const context = testContext();

// The signal code sets window.location.href = "slack://open" on success,
// which changes happy-dom's location and corrupts subsequent tests.
// Reset the href after each test to prevent location pollution.
afterEach(() => {
  if (!window.location.href.startsWith("http://localhost")) {
    window.location.href = "http://localhost/slack/connect";
  }
});

async function setup(path: string) {
  await setupPage({
    context,
    path,
    withoutRender: true,
  });
  // Allow the async init command (detached via Reason.Entrance) to complete
  await delay(50);
}

describe("slack-connect-page signals", () => {
  describe("init: check connection status on mount", () => {
    it("should set status to success when already connected", async () => {
      setMockSlackConnectData({ isConnected: true });
      await setup("/slack/connect?w=ws1&u=user1");

      expect(context.store.get(slackConnectStatus$)).toBe("success");
    });

    it("should stay idle when not connected", async () => {
      setMockSlackConnectData({ isConnected: false });
      await setup("/slack/connect?w=ws1&u=user1");

      expect(context.store.get(slackConnectStatus$)).toBe("idle");
    });

    it("should skip connection check when no workspace param", async () => {
      await setup("/slack/connect");

      expect(context.store.get(slackConnectStatus$)).toBe("idle");
    });
  });

  describe("effective status from URL params", () => {
    it("should return success when status=connected in URL", async () => {
      await setup("/slack/connect?status=connected");

      expect(context.store.get(effectiveStatus$)).toBe("success");
    });

    it("should return error when error param in URL", async () => {
      await setup("/slack/connect?error=Something+went+wrong");

      expect(context.store.get(effectiveStatus$)).toBe("error");
      expect(context.store.get(effectiveError$)).toBe("Something went wrong");
    });

    it("should return idle when no special URL params", async () => {
      await setup("/slack/connect");

      expect(context.store.get(effectiveStatus$)).toBe("idle");
    });
  });

  describe("connectSlackAccount$", () => {
    it("should set status to success on successful connect", async () => {
      setMockSlackConnectData({ isConnected: false });
      // Setup without w param to avoid init fetch, then add params for connect
      await setup("/slack/connect");
      context.store.set(
        updateSearchParams$,
        new URLSearchParams("w=ws1&u=user1"),
      );

      await context.store.set(connectSlackAccount$);

      expect(context.store.get(slackConnectStatus$)).toBe("success");
    });

    it("should set status to error on failed connect", async () => {
      setMockSlackConnectData({ postError: "Account already linked" });
      // Setup without w param to avoid init fetch, then add params for connect
      await setup("/slack/connect");
      context.store.set(
        updateSearchParams$,
        new URLSearchParams("w=ws1&u=user1"),
      );

      await context.store.set(connectSlackAccount$);

      expect(context.store.get(slackConnectStatus$)).toBe("error");
      expect(context.store.get(effectiveError$)).toBe("Account already linked");
    });

    it("should not connect without workspace and user params", async () => {
      await setup("/slack/connect");

      await context.store.set(connectSlackAccount$);

      expect(context.store.get(slackConnectStatus$)).toBe("idle");
    });
  });
});
