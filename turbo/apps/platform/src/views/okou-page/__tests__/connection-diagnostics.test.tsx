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
  const title = await screen.findByText("Realtime connection diagnostics");
  const summary = title.closest("summary");
  const details = title.closest("details");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("Connection diagnostics summary not found");
  }
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Connection diagnostics disclosure not found");
  }

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
    expect(
      within(diagnostics).getByText(/realtime\.initial-connection · start/u),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText(/realtime\.initial-connection · finish/u),
    ).toBeInTheDocument();
  });
  expect(releaseFeatureSwitches.settled()).toBeFalsy();
});
