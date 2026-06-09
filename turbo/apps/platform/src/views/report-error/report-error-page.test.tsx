import { screen, waitFor } from "@testing-library/react";
import { zeroReportErrorContract } from "@vm0/api-contracts/contracts/zero-report-error";
import { zeroRunsByIdContract } from "@vm0/api-contracts/contracts/zero-runs";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

const failedRunId = "33333333-3333-4333-8333-333333333333";

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function mockReportErrorStory(): void {
  context.mocks.api(zeroRunsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      runId: params.id,
      agentComposeVersionId: null,
      status: "failed",
      prompt: "Sync the billing export",
      appendSystemPrompt: null,
      result: { agentSessionId: "session-1", output: "stack trace" },
      createdAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(zeroReportErrorContract.submit, ({ respond }) => {
    return respond(200, { reference: "ERR-2026-0001" });
  });
}

describe("report error page", () => {
  it("submits a failed run error report and shows the reference", async () => {
    mockReportErrorStory();

    detachedSetupPage({
      context,
      path: `/runs/${failedRunId}/report-error`,
    });

    await waitFor(() => {
      expect(screen.getByText("Report error to developer")).toBeInTheDocument();
    });
    expect(screen.getByText("What will be sent")).toBeInTheDocument();
    expect(buttonByText("Send Report")).toBeDisabled();

    await fill(screen.getByLabelText("Title"), "Billing export failed");
    await fill(
      screen.getByLabelText("Description"),
      "The run stopped before producing the billing CSV.",
    );

    click(buttonByText("Send Report"));

    await waitFor(() => {
      expect(screen.getByText("Report sent")).toBeInTheDocument();
    });
    expect(screen.getByText("Reference: ERR-2026-0001")).toBeInTheDocument();
  });
});
