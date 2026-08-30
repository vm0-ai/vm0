import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, vi } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function latestClipboardWrite(writes: readonly string[]): string {
  const latest = writes.at(-1);
  if (latest === undefined) {
    throw new Error("Expected a clipboard write");
  }
  return latest;
}

function setupDiagnosticsPage(): void {
  detachedSetupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });
}

async function findDiagnosticsSummary(): Promise<HTMLElement> {
  const title = await screen.findByText("Realtime connection diagnostics");
  const summary = title.closest("summary");
  if (!summary) {
    throw new Error("Connection diagnostics summary not found");
  }
  return summary;
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.includes(text) ?? false;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

describe("connection diagnostics settings", () => {
  it("captures startup waits while feature switch hydration is pending", async () => {
    const user = userEvent.setup();
    const featureSwitchRequestStarted = context.mocks.deferred<void>();
    const releaseFeatureSwitchResponse = context.mocks.deferred<void>();
    context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
      featureSwitchRequestStarted.resolve();
      await releaseFeatureSwitchResponse.promise;
      return respond(200, {
        switches: { [FeatureSwitchKey.OkouDebug]: true },
        effectiveSwitches: { [FeatureSwitchKey.OkouDebug]: true },
      });
    });

    detachedSetupPage({
      context,
      path: "/?settings=debug",
      cachedFeatureSwitches: {
        [FeatureSwitchKey.OkouDebug]: true,
      },
    });

    await featureSwitchRequestStarted.promise;
    const diagnosticsSummary = await findDiagnosticsSummary();
    await waitFor(() => {
      expect(diagnosticsSummary).toHaveTextContent("connection: connected");
      expect(diagnosticsSummary).toHaveTextContent("channel: attached");
    });

    await user.click(diagnosticsSummary);
    await waitFor(() => {
      expect(
        screen.getByText(/realtime\.initial-connection · start/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/realtime\.initial-connection · finish/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/realtime\.auth-callback · finish/),
      ).toBeInTheDocument();
    });
    expect(releaseFeatureSwitchResponse.settled()).toBeFalsy();

    releaseFeatureSwitchResponse.resolve();
  });

  it("exports lifecycle, foreground catch-up, and sanitized Ably state events", async () => {
    const user = userEvent.setup();
    const clipboard = context.mocks.browser.clipboardWriteText();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
    });

    setupDiagnosticsPage();

    const diagnosticsSummary = await findDiagnosticsSummary();
    await waitFor(() => {
      expect(diagnosticsSummary).toHaveTextContent("connection: connected");
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    await user.click(diagnosticsSummary);
    await waitFor(() => {
      expect(
        screen.getByText(/foreground\.subscriber-catch-up · finish/),
      ).toBeInTheDocument();
    });

    act(() => {
      context.mocks.ably.triggerConnectionState("disconnected", {
        channelPrefix: "user:",
        code: 80_003,
        message:
          "request for user_test-user-123 and person@example.test failed at https://realtime.example.test/client/123e4567-e89b-42d3-a456-426614174000",
        retryIn: 5000,
        statusCode: 500,
      });
    });

    await waitFor(() => {
      expect(diagnosticsSummary).toHaveTextContent("connection: disconnected");
      expect(
        screen.getAllByText(/realtime\.connection · instant/).length,
      ).toBeGreaterThan(0);
    });

    await user.click(buttonByText("Copy JSON"));
    await waitFor(() => {
      expect(clipboard.writes).toHaveLength(1);
    });
    const exported = latestClipboardWrite(clipboard.writes);
    expect(exported).toContain('"event": "foreground.subscriber-catch-up"');
    expect(exported).toContain('"connectionState": "disconnected"');
    expect(exported).toContain('"retryInMs": 5000');
    expect(exported).toContain("[url]");
    expect(exported).toContain("[id]");
    expect(exported).not.toContain("user_test-user-123");
    expect(exported).not.toContain("person@example.test");
    expect(exported).not.toContain("realtime.example.test");
    expect(exported).not.toContain("123e4567-e89b-42d3-a456-426614174000");

    await user.click(buttonByText("Clear"));
    expect(
      screen.getByText("No diagnostic events recorded."),
    ).toBeInTheDocument();
    expect(screen.getByText("events: 0 / 500")).toBeInTheDocument();
  });

  it("keeps only the latest 500 diagnostic events", async () => {
    const user = userEvent.setup();
    const clipboard = context.mocks.browser.clipboardWriteText();
    setupDiagnosticsPage();

    const diagnosticsSummary = await findDiagnosticsSummary();
    await waitFor(() => {
      expect(diagnosticsSummary).toHaveTextContent("connection: connected");
    });

    act(() => {
      for (let index = 0; index < 510; index += 1) {
        context.mocks.ably.triggerConnectionState(
          index % 2 === 0 ? "disconnected" : "suspended",
          { channelPrefix: "user:" },
        );
      }
    });

    await user.click(diagnosticsSummary);
    expect(screen.getByText("events: 500 / 500")).toBeInTheDocument();
    await user.click(buttonByText("Copy JSON"));
    await waitFor(() => {
      expect(clipboard.writes).toHaveLength(1);
    });

    const exported: unknown = JSON.parse(
      latestClipboardWrite(clipboard.writes),
    );
    if (
      typeof exported !== "object" ||
      exported === null ||
      !("events" in exported) ||
      !Array.isArray(exported.events)
    ) {
      throw new Error("Connection diagnostics export is missing events");
    }
    expect(exported.events).toHaveLength(500);
  });
});
