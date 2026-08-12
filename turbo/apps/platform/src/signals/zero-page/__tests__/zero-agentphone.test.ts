import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  agentPhoneConnectDialogOpen$,
  agentPhonePhoneForm$,
  agentPhoneVerificationPhone$,
  completeAgentPhoneConnectDialogClose$,
  setAgentPhoneConnectDialogOpen$,
  setAgentPhonePhoneForm$,
  setAgentPhoneVerificationPhone$,
} from "../zero-agentphone.ts";

const context = testContext();
const PHONE_HANDLE = "+15555550123";

async function setupAgentPhoneSignals(): Promise<void> {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  await setupPage({ context, path: "/works", withoutRender: true });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("agentphone:changed"),
    ).toBeTruthy();
  });
}

function startVerificationDraft(): void {
  context.store.set(setAgentPhoneConnectDialogOpen$, true);
  context.store.set(setAgentPhonePhoneForm$, PHONE_HANDLE);
  context.store.set(setAgentPhoneVerificationPhone$, PHONE_HANDLE);
}

function publishLinkedStatus(): void {
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: PHONE_HANDLE,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.ably.trigger("agentphone:changed");
}

describe("agentPhone dialog lifecycle", () => {
  it("cleans a successful verification after its automatic close completes", async () => {
    await setupAgentPhoneSignals();
    startVerificationDraft();

    publishLinkedStatus();

    await waitFor(() => {
      expect(context.store.get(agentPhoneConnectDialogOpen$)).toBeFalsy();
    });
    expect(context.store.get(agentPhonePhoneForm$)).toBe(PHONE_HANDLE);
    expect(context.store.get(agentPhoneVerificationPhone$)).toBe(PHONE_HANDLE);

    context.store.set(completeAgentPhoneConnectDialogClose$);

    expect(context.store.get(agentPhonePhoneForm$)).toBe("");
    expect(context.store.get(agentPhoneVerificationPhone$)).toBeNull();
  });

  it("cleans a verification that succeeds after the dialog has closed", async () => {
    await setupAgentPhoneSignals();
    startVerificationDraft();
    context.store.set(setAgentPhoneConnectDialogOpen$, false);
    context.store.set(completeAgentPhoneConnectDialogClose$);
    expect(context.store.get(agentPhonePhoneForm$)).toBe(PHONE_HANDLE);
    expect(context.store.get(agentPhoneVerificationPhone$)).toBe(PHONE_HANDLE);

    publishLinkedStatus();

    await waitFor(() => {
      expect(context.store.get(agentPhonePhoneForm$)).toBe("");
      expect(context.store.get(agentPhoneVerificationPhone$)).toBeNull();
    });
  });
});
