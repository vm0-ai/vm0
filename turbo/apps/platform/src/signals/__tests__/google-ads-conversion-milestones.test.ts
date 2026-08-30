import { describe, expect, it, vi } from "vitest";
import {
  acquisitionAttributionContract,
  type GoogleAdsConversionMilestone,
} from "@okouai/api-contracts/contracts/acquisition-attribution";

import { setupBootstrap } from "../../__tests__/page-helper.ts";
import { syncGoogleAdsConversionMilestones$ } from "../bootstrap/google-ads-conversion-milestones.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

type GtagFn = (...args: unknown[]) => void;
type WindowWithGtag = Window & { gtag?: GtagFn };

async function setupSignedInBootstrap(userId = "test-user-123"): Promise<void> {
  await setupBootstrap({
    context,
    path: "/error",
    user: {
      id: userId,
      fullName: "Test User",
      email: "test@example.com",
      createdAt: new Date("2026-08-25T00:00:00.000Z"),
    },
    session: { token: "test-token" },
    org: {
      activeOrg: { id: "org_default", name: "Default Org" },
      memberships: [{ id: "org_default" }],
    },
  });
}

const MILESTONE_CASES: readonly {
  readonly kind: GoogleAdsConversionMilestone["kind"];
  readonly sendTo: string;
  readonly value: number;
}[] = [
  {
    kind: "free_trial_completed",
    sendTo: "AW-18407336975/kS5jCP6RrOccEI_YpslE",
    value: 15,
  },
  {
    kind: "first_run_completed",
    sendTo: "AW-18407336975/uEoeCIGSrOccEI_YpslE",
    value: 5,
  },
  {
    kind: "second_run_completed",
    sendTo: "AW-18407336975/0S04CISSrOccEI_YpslE",
    value: 10,
  },
  {
    kind: "multi_day_run_completed",
    sendTo: "AW-18407336975/ZGzhCI2SrOccEI_YpslE",
    value: 15,
  },
  {
    kind: "one_connector_connected",
    sendTo: "AW-18407336975/QpfCCIeSrOccEI_YpslE",
    value: 8,
  },
  {
    kind: "two_connectors_connected",
    sendTo: "AW-18407336975/DFtNCIqSrOccEI_YpslE",
    value: 15,
  },
];

function installGtagMock(): ReturnType<typeof vi.fn<GtagFn>> {
  const windowWithGtag = window as WindowWithGtag;
  const originalGtag = windowWithGtag.gtag;
  const gtag = vi.fn<GtagFn>();
  Object.defineProperty(windowWithGtag, "gtag", {
    configurable: true,
    value: gtag,
    writable: true,
  });
  context.signal.addEventListener("abort", () => {
    if (originalGtag) {
      Object.defineProperty(windowWithGtag, "gtag", {
        configurable: true,
        value: originalGtag,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(windowWithGtag, "gtag");
    }
  });
  return gtag;
}

describe("google ads conversion milestone sync", () => {
  it("baselines existing milestones and emits only newly achieved ones", async () => {
    const gtag = installGtagMock();
    let milestones: readonly GoogleAdsConversionMilestone[] = [
      {
        kind: "first_run_completed",
        transactionId: "gdm-first_run_completed-test-user-123",
      },
    ];
    context.mocks.api(
      acquisitionAttributionContract.googleAdsMilestones,
      ({ respond }) => {
        return respond(200, { milestones: [...milestones] });
      },
    );

    await setupSignedInBootstrap();
    expect(gtag).not.toHaveBeenCalled();

    milestones = [
      ...milestones,
      {
        kind: "second_run_completed",
        transactionId: "gdm-second_run_completed-test-user-123",
      },
    ];
    await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);
    await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);

    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: "AW-18407336975/0S04CISSrOccEI_YpslE",
      value: 10,
      currency: "USD",
      transaction_id: "gdm-second_run_completed-test-user-123",
    });
  });

  it.each(MILESTONE_CASES)(
    "emits $kind with the configured action and value",
    async ({ kind, sendTo, value }) => {
      const userId = `test-user-${kind}`;
      const gtag = installGtagMock();
      let milestones: readonly GoogleAdsConversionMilestone[] = [];
      context.mocks.api(
        acquisitionAttributionContract.googleAdsMilestones,
        ({ respond }) => {
          return respond(200, { milestones: [...milestones] });
        },
      );

      await setupSignedInBootstrap(userId);
      expect(gtag).not.toHaveBeenCalled();

      const transactionId = `transaction-${kind}-${userId}`;
      milestones = [{ kind, transactionId }];
      await context.store.set(
        syncGoogleAdsConversionMilestones$,
        context.signal,
      );
      await context.store.set(
        syncGoogleAdsConversionMilestones$,
        context.signal,
      );

      expect(gtag).toHaveBeenCalledTimes(1);
      expect(gtag).toHaveBeenCalledWith("event", "conversion", {
        send_to: sendTo,
        value,
        currency: "USD",
        transaction_id: transactionId,
      });
    },
  );
});
