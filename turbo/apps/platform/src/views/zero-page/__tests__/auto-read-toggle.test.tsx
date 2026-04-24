import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { mockSubagentThread } from "./chat-test-helpers.ts";
import { autoReadEnabled$ } from "../../../signals/voice-io/voice-io-settings.ts";

const context = testContext();

const THREAD_ID = "thread-auto-read-test";

describe("auto-read toggle", () => {
  it("renders on chat thread pages", async () => {
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Toggle auto-read").length,
      ).toBeGreaterThan(0);
    });
  });

  it("starts turned off", async () => {
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Toggle auto-read").length,
      ).toBeGreaterThan(0);
    });

    expect(context.store.get(autoReadEnabled$)).toBeFalsy();
  });

  it("toggles on after one click", async () => {
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const toggleBtn = await waitFor(() => {
      return screen.getAllByLabelText("Toggle auto-read")[0];
    });

    click(toggleBtn);

    expect(context.store.get(autoReadEnabled$)).toBeTruthy();
  });

  it("toggles back off after two clicks", async () => {
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const toggleBtn = await waitFor(() => {
      return screen.getAllByLabelText("Toggle auto-read")[0];
    });

    click(toggleBtn);
    click(toggleBtn);

    expect(context.store.get(autoReadEnabled$)).toBeFalsy();
  });

  it("stays hidden on non-chat routes", async () => {
    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });

    expect(screen.queryAllByLabelText("Toggle auto-read")).toHaveLength(0);
  });

  it("renders in the mobile top bar on chat routes", async () => {
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Toggle auto-read").length,
      ).toBeGreaterThan(0);
    });
  });
});
