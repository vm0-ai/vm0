/**
 * Tests for the /_/redemption-codes platform page.
 *
 * Covers:
 *   - page renders with nothing gated when the RedemptionCodes feature switch is OFF
 *     (the tabs + Mint/History sections stay hidden; the page surfaces only the
 *     header copy),
 *   - the Mint tab submits to the mint contract and renders the returned codes,
 *   - switching to the History tab fetches the list and renders rows,
 *   - a successful mint invalidates the history cache so the newly-minted codes
 *     appear on the History tab without a manual refresh.
 *
 * See: turbo/apps/platform/src/views/redemption-codes-page/redemption-codes-page.tsx
 * See: turbo/apps/platform/src/signals/redemption-codes-page/redemption-codes.ts
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FeatureSwitchKey,
  zeroRedemptionCodesListContract,
  zeroRedemptionCodesMintContract,
} from "@vm0/core";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

const PATH = "/_/redemption-codes";

function getButtonByText(label: string): HTMLButtonElement {
  const match = screen.getAllByRole("button").find((el) => {
    return el.textContent?.trim() === label;
  });
  if (!match) {
    throw new Error(`No button with text "${label}"`);
  }
  return match as HTMLButtonElement;
}

function getTabByName(name: "Mint" | "History"): HTMLElement {
  const match = screen.getAllByRole("tab").find((el) => {
    return el.textContent?.trim() === name;
  });
  if (!match) {
    throw new Error(`No tab named "${name}"`);
  }
  return match;
}

describe("/_/redemption-codes page", () => {
  it("renders only the header when the RedemptionCodes feature switch is off", async () => {
    detachedSetupPage({ context, path: PATH });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Redemption Codes" }),
      ).toBeInTheDocument();
    });

    // Tabs + both sections are gated behind the feature switch — none should
    // render when the switch is off.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText("Mint new codes")).not.toBeInTheDocument();
    expect(screen.queryByText("Minted codes")).not.toBeInTheDocument();
  });

  it("submits the mint form and renders the returned codes", async () => {
    const user = userEvent.setup();

    let capturedBody: unknown;
    server.use(
      mockApi(zeroRedemptionCodesMintContract.mint, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, {
          codes: [
            {
              code: "VM0-AAAA-BBBB-CCCC-DDDD",
              creditsPerCode: 2500,
              expiresAt: "2026-05-20T00:00:00Z",
            },
            {
              code: "VM0-EEEE-FFFF-GGGG-HHHH",
              creditsPerCode: 2500,
              expiresAt: "2026-05-20T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(zeroRedemptionCodesListContract.list, ({ respond }) => {
        return respond(200, { codes: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: PATH,
      featureSwitches: { [FeatureSwitchKey.RedemptionCodes]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Mint new codes")).toBeInTheDocument();
    });

    await user.click(getButtonByText("Generate"));

    await waitFor(() => {
      expect(screen.getByText("VM0-AAAA-BBBB-CCCC-DDDD")).toBeInTheDocument();
    });
    expect(screen.getByText("VM0-EEEE-FFFF-GGGG-HHHH")).toBeInTheDocument();
    // Mint form defaults — credits=10000, quantity=1. The "2" here is the mocked
    // response size (2 codes), not the input. We only assert the submitted body.
    expect(capturedBody).toStrictEqual({ creditsPerCode: 10_000, quantity: 1 });
  });

  it("fetches and renders rows on the History tab", async () => {
    const user = userEvent.setup();

    const redeemedAt = new Date().toISOString();
    server.use(
      mockApi(zeroRedemptionCodesListContract.list, ({ respond }) => {
        return respond(200, {
          codes: [
            {
              code: "VM0-HIST-OUT1",
              creditsPerCode: 100,
              createdAt: "2026-04-10T00:00:00Z",
              createdByUserId: "user_staff",
              expiresAt: "2026-05-10T00:00:00Z",
              redeemedAt: null,
              redeemedByUserId: null,
              redeemedByOrgId: null,
            },
            {
              code: "VM0-HIST-RED1",
              creditsPerCode: 200,
              createdAt: "2026-04-11T00:00:00Z",
              createdByUserId: "user_staff",
              expiresAt: "2026-05-11T00:00:00Z",
              redeemedAt,
              redeemedByUserId: "user_redeemer",
              redeemedByOrgId: "org_redeemer",
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: PATH,
      featureSwitches: { [FeatureSwitchKey.RedemptionCodes]: true },
    });

    const historyTab = await waitFor(() => {
      return getTabByName("History");
    });
    await user.click(historyTab);

    await waitFor(() => {
      expect(screen.getByText("VM0-HIST-OUT1")).toBeInTheDocument();
    });
    expect(screen.getByText("VM0-HIST-RED1")).toBeInTheDocument();
    expect(screen.getByText("Outstanding")).toBeInTheDocument();
    expect(screen.getByText("Redeemed")).toBeInTheDocument();
  });

  it("refetches history after a successful mint so new codes appear on the History tab", async () => {
    const user = userEvent.setup();

    let listCallCount = 0;
    server.use(
      mockApi(zeroRedemptionCodesMintContract.mint, ({ respond }) => {
        return respond(200, {
          codes: [
            {
              code: "VM0-NEWLY-MINTED",
              creditsPerCode: 500,
              expiresAt: "2026-05-20T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(zeroRedemptionCodesListContract.list, ({ respond }) => {
        listCallCount += 1;
        // First call (History tab initial load): empty.
        // Post-mint call (cache invalidated by mintCodes$): includes the new code.
        if (listCallCount === 1) {
          return respond(200, { codes: [] });
        }
        return respond(200, {
          codes: [
            {
              code: "VM0-NEWLY-MINTED",
              creditsPerCode: 500,
              createdAt: "2026-04-20T00:00:00Z",
              createdByUserId: "user_staff",
              expiresAt: "2026-05-20T00:00:00Z",
              redeemedAt: null,
              redeemedByUserId: null,
              redeemedByOrgId: null,
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: PATH,
      featureSwitches: { [FeatureSwitchKey.RedemptionCodes]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Mint new codes")).toBeInTheDocument();
    });

    // Visit History first so the cache populates (empty) and we can prove the
    // post-mint refetch replaces it rather than masking a slow first load.
    await user.click(getTabByName("History"));
    await waitFor(() => {
      expect(screen.getByText(/No codes minted yet/i)).toBeInTheDocument();
    });

    // Back to Mint, press Generate.
    await user.click(getTabByName("Mint"));
    await waitFor(() => {
      expect(screen.getByText("Mint new codes")).toBeInTheDocument();
    });
    await user.click(getButtonByText("Generate"));

    await waitFor(() => {
      expect(screen.getByText("VM0-NEWLY-MINTED")).toBeInTheDocument();
    });

    // Switch back to History and verify the newly-minted code is rendered
    // without clicking Refresh — mint invalidated the cache.
    await user.click(getTabByName("History"));
    await waitFor(() => {
      // The new code shows up in the history table.
      const matches = screen.getAllByText("VM0-NEWLY-MINTED");
      expect(matches.length).toBeGreaterThan(0);
    });
    expect(listCallCount).toBeGreaterThanOrEqual(2);
  });
});
