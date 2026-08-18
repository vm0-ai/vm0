import {
  zeroTeamContract,
  type TeamComposeItem,
} from "@okouai/api-contracts/contracts/zero-team";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const LAST_USED_AGENT_STORAGE_KEY = "zero.lastUsedAgentId";
const { set$: setLastUsedAgentId$, clear$: clearLastUsedAgentId$ } =
  localStorageSignals(LAST_USED_AGENT_STORAGE_KEY);

const DEFAULT_AGENT = {
  id: "c0000000-0000-4000-a000-000000000001",
  displayName: "Zero",
  description: null,
  sound: null,
  avatarUrl: null,
  headVersionId: "version_1",
  updatedAt: "2026-08-18T00:00:00Z",
} satisfies TeamComposeItem;

describe("settings deep-link handoff", () => {
  it("waits for the stable agent route before opening settings", async () => {
    context.store.set(setLastUsedAgentId$, DEFAULT_AGENT.id);
    const teamRequestStarted = context.mocks.deferred<void>();
    const releaseTeamRequest = context.mocks.deferred<void>();
    context.mocks.api(zeroTeamContract.list, async ({ respond }) => {
      teamRequestStarted.resolve(undefined);
      await releaseTeamRequest.promise;
      return respond(200, [DEFAULT_AGENT]);
    });

    detachedSetupPage({
      context,
      path: "/?settings=billing&billingView=plans",
    });

    await teamRequestStarted.promise;
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Compare plans" }),
    ).not.toBeInTheDocument();

    releaseTeamRequest.resolve(undefined);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${DEFAULT_AGENT.id}/chat`);
    });
    await expect(
      screen.findByRole("dialog", { name: "Settings" }),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByRole("heading", { name: "Compare plans" }),
    ).resolves.toBeInTheDocument();
  });

  it("processes settings on the root route when no home agent exists", async () => {
    context.store.set(clearLastUsedAgentId$);
    context.mocks.data.onboardingStatus({
      hasDefaultAgent: false,
      defaultAgentId: null,
    });

    detachedSetupPage({
      context,
      path: "/?settings=billing",
    });

    await expect(
      screen.findByRole("dialog", { name: "Settings" }),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByRole("heading", { name: "Billing" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/");
  });
});
