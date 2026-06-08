import { describe, expect, it } from "vitest";

import {
  CHAT_RUN_TRANSIENT_ERROR_MESSAGE,
  formatRunErrorForExternalSurface,
  INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE,
  isActionableRunError,
  isGenericRunErrorForDisplay,
} from "../errors";

describe("formatRunErrorForExternalSurface", () => {
  it("preserves allowlisted run errors like Web chat", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "NO_MODEL_PROVIDER",
        message: "No model provider configured",
      }),
    ).toBe("No model provider configured");
  });

  it("preserves non-guidance allowlisted run errors", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Cannot continue session with this provider",
      }),
    ).toBe("Cannot continue session with this provider");
  });

  it("appends Add credits link for admins on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: true,
          addCreditsUrl:
            "https://app.example.test/?settings=billing&billingView=credits",
        },
      }),
    ).toBe(
      "Insufficient credits. Please add credits to continue.\n\nAdd credits: https://app.example.test/?settings=billing&billingView=credits",
    );
  });

  it("asks non-admins to contact an admin on insufficient credits", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits. Please add credits to continue.",
        insufficientCredits: {
          canManageBilling: false,
          addCreditsUrl:
            "https://app.example.test/?settings=billing&billingView=credits",
        },
      }),
    ).toBe(INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE);
  });

  it("shows Codex usage limit errors verbatim", () => {
    const codexUsageLimit =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:17 AM.";
    const formatted = formatRunErrorForExternalSurface({
      code: "UNKNOWN",
      message: codexUsageLimit,
    });
    expect(formatted).toBe(codexUsageLimit);
    expect(formatted).not.toContain("switch to another model");
  });

  it("shows Claude session limit errors verbatim", () => {
    const sessionLimit =
      "You've hit your session limit · resets 12:50pm (Asia/Shanghai)";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: sessionLimit,
      }),
    ).toBe(sessionLimit);
  });

  it("shows Claude weekly limit errors verbatim", () => {
    const weeklyLimit =
      "You've hit your weekly limit · resets 10am (Asia/Shanghai)";
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: weeklyLimit,
      }),
    ).toBe(weeklyLimit);
  });

  it("falls back to the Web generic message for unallowlisted errors", () => {
    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: "Something failed",
      }),
    ).toBe("Oops, something went wrong. Please try again later.");
  });

  it("shows reconnect guidance for Codex OAuth reconnect-required refresh failures", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token. The connector may need to be reconnected.","permission":"model-provider:codex-oauth-token","base":"https://chatgpt.com/backend-api/codex","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';
    const expectedMessage =
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.";

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(expectedMessage);
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
    expect(isActionableRunError(expectedMessage)).toBe(true);
    expect(isGenericRunErrorForDisplay(expectedMessage)).toBe(false);
  });

  it("ignores braces after the embedded reconnect-required error body", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Refresh failed for {codex} token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/{response_id}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("skips unrelated objects before the reconnect-required error body", () => {
    const rawRunError =
      'request metadata {"traceId":"abc","status":502}: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("skips non-JSON brace templates before the reconnect-required error body", () => {
    const rawRunError =
      'request template {response_id: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("shows reconnect guidance for firewall auth API error envelopes", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":{"message":"Access token expired and refresh failed for: codex-oauth-token.","code":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(
      "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    );
    expect(isActionableRunError(rawRunError)).toBe(true);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(false);
  });

  it("does not match nested debug objects inside unrelated error bodies", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"SOMETHING_ELSE","debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("does not match nested debug objects inside unrelated metadata bodies", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"traceId":"abc","debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("does not match nested debug objects inside incomplete JSON-looking bodies", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"traceId":"abc","debug":{"error":"TOKEN_REFRESH_FAILED","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("keeps upstream Codex token refresh failures generic", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"upstream_provider"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("does not show reconnect guidance when upstream provider marker is present", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token after reconnect_required state.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"upstream_provider"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("requires reconnect-required to be the failure reason field", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token refresh failed for: codex-oauth-token after reconnect_required state.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"]}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("requires token refresh failed to be the error code field", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"SOMETHING_ELSE","message":"TOKEN_REFRESH_FAILED for codex-oauth-token.","permission":"model-provider:codex-oauth-token","connectors":["codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("keeps non-Codex token refresh failures generic", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: zendesk.","permission":"connector:zendesk","connectors":["zendesk"],"failureReason":"reconnect_required"}, url: https://example.zendesk.com/api/v2/tickets';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });

  it("keeps mixed connector token refresh failures generic", () => {
    const rawRunError =
      'unexpected status 502 Bad Gateway: {"error":"TOKEN_REFRESH_FAILED","message":"Access token expired and refresh failed for: notion, codex-oauth-token. The connector may need to be reconnected.","connectors":["notion","codex-oauth-token"],"failureReason":"reconnect_required"}, url: https://chatgpt.com/backend-api/codex/responses';

    expect(
      formatRunErrorForExternalSurface({
        code: "UNKNOWN",
        message: rawRunError,
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    expect(isActionableRunError(rawRunError)).toBe(false);
    expect(isGenericRunErrorForDisplay(rawRunError)).toBe(true);
  });
});
