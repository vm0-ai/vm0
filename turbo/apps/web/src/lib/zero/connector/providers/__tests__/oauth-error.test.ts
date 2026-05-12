import { describe, it, expect } from "vitest";
import { throwOAuthError } from "@vm0/connectors/oauth-providers/providers/oauth-error";

function makeResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: "Bad Request" });
}

describe("throwOAuthError", () => {
  it("includes error and error_description from JSON response", async () => {
    const response = makeResponse(
      400,
      JSON.stringify({
        error: "invalid_grant",
        error_description: "The refresh token is expired",
      }),
    );

    await expect(
      throwOAuthError("Notion", "refresh", response),
    ).rejects.toThrow(
      "Notion token refresh failed: 400 invalid_grant (The refresh token is expired)",
    );
  });

  it("includes error code alone when no description", async () => {
    const response = makeResponse(
      401,
      JSON.stringify({ error: "unauthorized_client" }),
    );

    await expect(
      throwOAuthError("Figma", "exchange", response),
    ).rejects.toThrow("Figma token exchange failed: 401 unauthorized_client");
  });

  it("includes raw text for non-JSON response", async () => {
    const response = makeResponse(500, "Internal Server Error");

    await expect(
      throwOAuthError("GitHub", "exchange", response),
    ).rejects.toThrow(
      "GitHub token exchange failed: 500 Internal Server Error",
    );
  });

  it("handles empty response body", async () => {
    const response = makeResponse(502, "");

    await expect(
      throwOAuthError("Slack", "exchange", response),
    ).rejects.toThrow("Slack token exchange failed: 502");
  });

  it("truncates long response bodies", async () => {
    const longBody = "x".repeat(600);
    const response = makeResponse(400, longBody);

    const error = await throwOAuthError("Notion", "refresh", response).catch(
      (e: Error) => {
        return e;
      },
    );

    expect(error.message).toContain("Notion token refresh failed: 400 ");
    expect(error.message).toMatch(/\.\.\.$/);
    // 500 chars + "..." = truncated
    const detail = error.message.replace(
      "Notion token refresh failed: 400 ",
      "",
    );
    expect(detail.length).toBeLessThanOrEqual(504); // 500 + "..."
  });

  it("includes full JSON body when no standard error fields", async () => {
    const response = makeResponse(
      400,
      JSON.stringify({ message: "something went wrong", code: 123 }),
    );

    await expect(
      throwOAuthError("Stripe", "refresh", response),
    ).rejects.toThrow("Stripe token refresh failed: 400 ");
  });
});
