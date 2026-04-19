import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

describe("activity page error", () => {
  it("should show error state when /api/zero/logs returns 500", async () => {
    setMockComposesList([]);
    server.use(
      http.get("*/api/zero/logs", () => {
        return HttpResponse.json(
          { error: { message: "Internal Server Error", code: "INTERNAL" } },
          { status: 500 },
        );
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Failed to load activity data"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Something went wrong. Please try again later."),
    ).toBeInTheDocument();
  });
});
