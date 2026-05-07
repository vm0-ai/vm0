/**
 * Tests for OrgProvidersTab — specifically the stale-session reconnect
 * banner button (#11980 replaces the broken cross-origin <a href> with a
 * button that opens the codex auth.json paste dialog in reconnect mode).
 *
 * Covers:
 * - Re-paste button opens the paste dialog with reconnect title
 * - Successful re-paste clears needsReconnect → banner unmounts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { server } from "../../../../../mocks/server.ts";
import { mockApi } from "../../../../../mocks/msw-contract.ts";
import { testContext } from "../../../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  fill,
} from "../../../../../__tests__/page-helper.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../../../mocks/handlers/api-org-model-providers.ts";
import { setCodexPasteDialogState$ } from "../../../../../signals/zero-page/settings/org-model-providers.ts";

vi.mock("@vm0/ui/components/ui/sonner", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@vm0/ui/components/ui/sonner");
  return {
    ...actual,
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

const context = testContext();

function makeStaleProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-0000000000a1",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: "CHATGPT_ACCESS_TOKEN",
    authMethod: "oauth",
    secretNames: [
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
    ],
    isDefault: true,
    selectedModel: null,
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
  };
}

function makeFreshProvider(): ModelProviderResponse {
  return {
    ...makeStaleProvider(),
    needsReconnect: false,
    lastRefreshErrorCode: null,
  };
}

beforeEach(() => {
  resetMockOrgModelProviders();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  context.store.set(setCodexPasteDialogState$, {
    open: false,
    mode: "connect",
  });
});

async function openProvidersPage(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

async function findRepasteButton(): Promise<HTMLElement> {
  return await screen.findByText("Re-paste auth.json");
}

function findReconnectDialogTitle(): HTMLElement | null {
  return screen.queryByText("Re-connect Codex");
}

describe("org-providers-tab — stale banner reconnect", () => {
  it("opens the paste dialog in reconnect mode when Re-paste button is clicked", async () => {
    setMockOrgModelProviders([makeStaleProvider()]);
    await openProvidersPage();

    click(await findRepasteButton());

    await waitFor(() => {
      expect(findReconnectDialogTitle()).toBeInTheDocument();
    });
  });

  it("clears the stale banner after a successful re-paste", async () => {
    setMockOrgModelProviders([makeStaleProvider()]);
    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ respond }) => {
        const fresh = makeFreshProvider();
        // Reflect the post-submit state so the next list refresh sees a
        // non-stale provider; the dialog drives the refresh via the
        // internal reload counter inside submitCodexAuthJson$.
        setMockOrgModelProviders([fresh]);
        return respond(200, { provider: fresh, created: false });
      }),
    );

    await openProvidersPage();

    await waitFor(() => {
      expect(
        screen.getByText(/ChatGPT session needs reconnection/i),
      ).toBeInTheDocument();
    });

    click(await findRepasteButton());

    await fill(
      await screen.findByTestId("codex-paste-textarea"),
      '{"OPENAI_API_KEY":"sk","tokens":{"access_token":"a"}}',
    );
    click(screen.getByTestId("codex-paste-submit"));

    await waitFor(() => {
      expect(
        screen.queryByText(/ChatGPT session needs reconnection/i),
      ).not.toBeInTheDocument();
    });
    expect(findReconnectDialogTitle()).not.toBeInTheDocument();
  });
});
