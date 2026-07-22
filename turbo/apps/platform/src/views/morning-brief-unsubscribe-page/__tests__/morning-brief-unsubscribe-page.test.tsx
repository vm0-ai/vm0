import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { MOCK_MORNING_BRIEF_UNSUBSCRIBE_TOKEN } from "../../../mocks/handlers/api-email-morning-brief-unsubscribe.ts";

const context = testContext();

describe("morning brief unsubscribe page", () => {
  it("unsubscribes with a valid token from the email link", async () => {
    detachedSetupPage({
      context,
      path: `/email/morning-brief/unsubscribe?token=${MOCK_MORNING_BRIEF_UNSUBSCRIBE_TOKEN}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Morning Brief turned off")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/no longer receive the daily Morning Brief email/),
    ).toBeInTheDocument();
  });

  it("shows the invalid state when the API rejects the token", async () => {
    detachedSetupPage({
      context,
      path: "/email/morning-brief/unsubscribe?token=tampered-token",
    });

    await waitFor(() => {
      expect(screen.getByText("This link is invalid")).toBeInTheDocument();
    });
  });

  it("shows the invalid state without calling the API when the token is missing", async () => {
    detachedSetupPage({ context, path: "/email/morning-brief/unsubscribe" });

    await waitFor(() => {
      expect(screen.getByText("This link is invalid")).toBeInTheDocument();
    });
  });
});
