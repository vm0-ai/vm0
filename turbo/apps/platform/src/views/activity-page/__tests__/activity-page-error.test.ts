import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { logsListContract } from "@vm0/core";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("activity page error", () => {
  it("should show error state when /api/zero/logs returns 403", async () => {
    setMockComposesList([]);
    server.use(
      mockApi(logsListContract.list, ({ respond }) => {
        return respond(403, {
          error: { message: "Internal Server Error", code: "INTERNAL" },
        });
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
