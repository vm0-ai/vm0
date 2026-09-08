import { act, screen, waitFor, within } from "@testing-library/react";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  publishConnectionDiagnostic,
  type ConnectionDiagnosticEventName,
  writeConnectionDiagnostic$,
} from "../../../signals/connection-diagnostics.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function diagnosticsButton(
  container: HTMLElement,
  name: string,
): HTMLButtonElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Connection diagnostics button not found: ${name}`);
  }
  return button;
}

async function openConnectionDiagnostics(): Promise<HTMLDetailsElement> {
  return await openDiagnosticsPanel("Realtime connection diagnostics");
}

async function openDiagnosticsPanel(
  titleText: string,
): Promise<HTMLDetailsElement> {
  const { details, summary } = await waitFor(() => {
    const title = screen.getAllByText(titleText).find((candidate) => {
      return candidate.closest("summary") !== null;
    });
    const summary = title?.closest("summary");
    const details = title?.closest("details");
    if (!(summary instanceof HTMLElement)) {
      throw new Error("Connection diagnostics summary not found");
    }
    if (!(details instanceof HTMLDetailsElement)) {
      throw new Error("Connection diagnostics disclosure not found");
    }
    return { details, summary };
  });

  click(summary);

  await waitFor(() => {
    expect(details).toHaveAttribute("open");
    expect(diagnosticsButton(details, "Copy JSON")).toBeInTheDocument();
  });
  return details;
}

function publishEvent(
  event: ConnectionDiagnosticEventName,
  errorMessage: string,
): void {
  publishConnectionDiagnostic({
    details: { errorMessage },
    event,
    phase: "instant",
  });
}

test("Connection diagnostics retain the most recent history", async () => {
  await setupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const diagnostics = await openConnectionDiagnostics();
  act(() => {
    for (let index = 0; index <= 500; index += 1) {
      publishEvent("realtime.connection", `history-event-${index}`);
    }
  });

  await waitFor(() => {
    expect(
      within(diagnostics).getByText("events: 500 / 500"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText(/"errorMessage":"history-event-500"/u),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText(/"errorMessage":"history-event-1"/u),
    ).toBeInTheDocument();
  });
  expect(
    within(diagnostics).queryByText(/"errorMessage":"history-event-0"/u),
  ).toBeNull();
});

test("Connection diagnostics remain available during startup", async () => {
  const featureSwitchRequestStarted = context.mocks.deferred<void>();
  const releaseFeatureSwitches = context.mocks.deferred<void>();
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      featureSwitchRequestStarted.resolve(undefined);
      await withSignal(releaseFeatureSwitches.promise);
      return respond(200, { effectiveSwitches: {}, switches: {} });
    },
  );
  await setupPage({
    context,
    path: "/?settings=debug",
    cachedFeatureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const diagnostics = await openConnectionDiagnostics();
  await featureSwitchRequestStarted.promise;

  await waitFor(() => {
    expect(
      within(diagnostics).getByText("connection: connected"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("channel: attached"),
    ).toBeInTheDocument();
    // The direct Worker test transport shares globalThis with the page, so both
    // valid connection spans can appear in the page capture.
    expect(
      within(diagnostics).queryAllByText(
        /realtime\.initial-connection · start/u,
      ),
    ).not.toHaveLength(0);
    expect(
      within(diagnostics).queryAllByText(
        /realtime\.initial-connection · finish/u,
      ),
    ).not.toHaveLength(0);
  });
  expect(releaseFeatureSwitches.settled()).toBeFalsy();
});

test("A user can inspect, refresh, and copy the shared worker capture", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.workerStore.set(writeConnectionDiagnostic$, {
    action: "set-enabled",
    enabled: true,
  });
  context.workerStore.set(writeConnectionDiagnostic$, {
    action: "append",
    event: {
      details: { errorMessage: "worker-capture-before-refresh" },
      event: "realtime.connection",
      phase: "instant",
    },
  });

  await setupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    sharedWorkerTestTransport: "message-port",
  });

  const diagnostics = await openDiagnosticsPanel(
    "Shared worker connection diagnostics",
  );
  expect(
    within(diagnostics).getByText(/worker-capture-before-refresh/u),
  ).toBeVisible();

  click(diagnosticsButton(diagnostics, "Copy JSON"));
  await waitFor(() => {
    expect(clipboard.writes).toHaveLength(1);
  });
  expect(clipboard.writes[0]).toContain("worker-capture-before-refresh");

  context.workerStore.set(writeConnectionDiagnostic$, {
    action: "append",
    event: {
      details: { errorMessage: "worker-capture-after-refresh" },
      event: "realtime.connection",
      phase: "instant",
    },
  });
  click(diagnosticsButton(diagnostics, "Refresh"));

  await waitFor(() => {
    expect(
      within(diagnostics).getByText(/worker-capture-after-refresh/u),
    ).toBeVisible();
  });
});
