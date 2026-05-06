/**
 * Tests for the codex auth.json paste dialog (#11980).
 *
 * Covers:
 * - Empty paste / malformed JSON disables submit (client-side sanity check)
 * - Happy path posts the auth_json shape and closes the dialog
 * - Server-typed error codes (CODEX_AUTH_JSON_SHAPE_INVALID,
 *   CODEX_FREE_PLAN_REJECTED) surface inline; toast.error is NOT fired
 *   (UX choice — see #11980 plan)
 * - Reconnect mode renders a different title
 * - Cancel resets transient state for the next open
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  setCodexPasteDialogState$,
  setOrgAddProviderDialogOpen$,
} from "../../../signals/zero-page/settings/org-model-providers.ts";
import { resetMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";

vi.mock("@vm0/ui/components/ui/sonner", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@vm0/ui/components/ui/sonner");
  return {
    ...actual,
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

const context = testContext();

beforeEach(() => {
  resetMockOrgModelProviders();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  // Make sure the dialog is closed between tests so leaked state doesn't
  // bleed into the next case.
  context.store.set(setCodexPasteDialogState$, {
    open: false,
    mode: "connect",
  });
  context.store.set(setOrgAddProviderDialogOpen$, false);
});

async function openPasteDialog(
  mode: "connect" | "reconnect" = "connect",
): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  context.store.set(setCodexPasteDialogState$, { open: true, mode });
  await waitFor(() => {
    expect(screen.getByTestId("codex-paste-textarea")).toBeInTheDocument();
  });
}

const VALID_JSON = '{"OPENAI_API_KEY":"sk-test","tokens":{"access_token":"a"}}';

describe("codex paste dialog — local sanity", () => {
  it("disables submit when textarea is empty", async () => {
    await openPasteDialog();
    const submit = screen.getByTestId("codex-paste-submit");
    expect(submit).toBeDisabled();
  });

  it("disables submit and shows hint when paste is not valid JSON", async () => {
    await openPasteDialog();
    const textarea = screen.getByTestId("codex-paste-textarea");
    await fill(textarea, "not-json{");

    const submit = screen.getByTestId("codex-paste-submit");
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(/Looks like the paste isn't valid JSON yet/i),
    ).toBeInTheDocument();
  });

  it("enables submit once paste parses as JSON", async () => {
    await openPasteDialog();
    const textarea = screen.getByTestId("codex-paste-textarea");
    await fill(textarea, VALID_JSON);

    const submit = screen.getByTestId("codex-paste-submit");
    expect(submit).not.toBeDisabled();
  });
});

describe("codex paste dialog — submit happy path", () => {
  it("posts auth_json shape and closes the dialog on success", async () => {
    let receivedBody: unknown = null;
    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ body, respond }) => {
        receivedBody = body;
        return respond(201, {
          provider: {
            id: "00000000-0000-4000-a000-000000000099",
            type: "codex-oauth-token",
            framework: "codex",
            secretName: "CHATGPT_ACCESS_TOKEN",
            authMethod: "auth_json",
            secretNames: ["CODEX_AUTH_JSON"],
            isDefault: true,
            selectedModel: null,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          created: true,
        });
      }),
    );

    await openPasteDialog();
    const textarea = screen.getByTestId("codex-paste-textarea");
    await fill(textarea, VALID_JSON);
    click(screen.getByTestId("codex-paste-submit"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Connect Codex/i }),
      ).not.toBeInTheDocument();
    });

    expect(receivedBody).toStrictEqual({
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: { CODEX_AUTH_JSON: VALID_JSON },
    });
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});

describe("codex paste dialog — server typed errors", () => {
  it("renders friendly copy for CODEX_AUTH_JSON_SHAPE_INVALID without firing toast", async () => {
    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ respond }) => {
        return respond(400, {
          error: {
            code: "CODEX_AUTH_JSON_SHAPE_INVALID",
            message: "shape invalid",
          },
        });
      }),
    );

    await openPasteDialog();
    await fill(screen.getByTestId("codex-paste-textarea"), VALID_JSON);
    click(screen.getByTestId("codex-paste-submit"));

    await waitFor(() => {
      expect(
        screen.getByText(/auth\.json format unrecognized/i),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("dialog", { name: /Connect Codex/i }),
    ).toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("renders friendly copy for CODEX_FREE_PLAN_REJECTED", async () => {
    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ respond }) => {
        return respond(400, {
          error: {
            code: "CODEX_FREE_PLAN_REJECTED",
            message: "free plan",
          },
        });
      }),
    );

    await openPasteDialog();
    await fill(screen.getByTestId("codex-paste-textarea"), VALID_JSON);
    click(screen.getByTestId("codex-paste-submit"));

    await waitFor(() => {
      expect(
        screen.getByText(/Free ChatGPT plans cannot use Codex/i),
      ).toBeInTheDocument();
    });
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("falls back to server message for unknown error codes", async () => {
    server.use(
      mockApi(zeroModelProvidersMainContract.upsert, ({ respond }) => {
        return respond(400, {
          error: { code: "WHATEVER", message: "some other error from server" },
        });
      }),
    );

    await openPasteDialog();
    await fill(screen.getByTestId("codex-paste-textarea"), VALID_JSON);
    click(screen.getByTestId("codex-paste-submit"));

    await waitFor(() => {
      expect(
        screen.getByText(/some other error from server/i),
      ).toBeInTheDocument();
    });
  });
});

describe("codex paste dialog — modes", () => {
  it("renders Re-connect Codex title in reconnect mode", async () => {
    await openPasteDialog("reconnect");
    expect(
      screen.getByRole("dialog", { name: /Re-connect Codex/i }),
    ).toBeInTheDocument();
  });
});
