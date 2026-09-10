import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  cancelledEvent,
  completedEvent,
  context,
  findButton,
  findLink,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  readyChat,
  RUN_PATH,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";

const RUN_ID = "d0000000-0000-4000-a000-000000000841";
const NEXT_RUN_ID = "d0000000-0000-4000-a000-000000000842";
const PREPARATION = "Preparing the launch checklist";
const ACTIVITY = "Checking the release evidence";
const LEGACY_FALLBACK =
  /^(Brewing up a response|Piecing things together|Spinning up|On it|Assembling the pieces|Sketching the details|Mapping it out|Wiring it together|Shaping the response|Tuning in)\.\.\.$/;
const featureSwitches = Object.freeze({
  [FeatureSwitchKey.ThreadActivitySummary]: true,
});

function summary(
  overrides: Partial<ActivitySummaryResponse> = {},
): ActivitySummaryResponse {
  return {
    runId: RUN_ID,
    messages: [{ id: PREPARATION, text: PREPARATION }],
    status: "fresh",
    sourceRevision: "source-z",
    summaryRevision: "summary-z",
    sourceSequence: 2,
    summarySequence: 2,
    messageCursor: 1,
    summaryMessageCursor: 1,
    summarizedAt: "2026-09-09T08:00:00.000Z",
    retryAfterMs: 15_000,
    ...overrides,
  };
}

function installActiveRun() {
  mockNow(new Date("2026-09-09T08:00:00.000Z"), context.signal);
  const events = [
    promptEvent({
      id: "activity-prompt",
      runId: RUN_ID,
      seqId: 1,
      text: "Prepare a launch checklist",
    }),
  ];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID, NEXT_RUN_ID] });
  return events;
}

test("Feature off retains initial thinking and makes no summary demand", async () => {
  const events = installActiveRun();
  events.push(
    thinkingEvent({
      id: "old-thinking",
      runId: RUN_ID,
      seqId: 2,
      text: "Preparing the original response",
    }),
  );
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      requests++;
      return respond(200, summary());
    },
  );

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });

  await expect(
    screen.findByLabelText("Preparing the original response"),
  ).resolves.toBeVisible();
  expect(requests).toBe(0);
});

test("A chat event starts demand for the newly active run without idle polling", async () => {
  const events: ReturnType<typeof promptEvent>[] = [];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      requests++;
      return respond(200, summary());
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await readyChat();
  expect(requests).toBe(0);

  events.push(
    promptEvent({
      id: "event-driven-prompt",
      runId: RUN_ID,
      seqId: 1,
      text: "Start the release review",
    }),
  );
  publishRunUpdate();

  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  expect(requests).toBeGreaterThan(0);
});

test.each(["pending", "cooldown", 500] as const)(
  "A %s response uses the fallback and recovers on a later loop tick",
  async (status) => {
    installActiveRun();
    let recovered = false;
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      ({ respond }) => {
        if (recovered) {
          return respond(200, summary());
        }
        return status === 500
          ? respond(500, {
              error: {
                message: "Summary unavailable",
                code: "INTERNAL_SERVER_ERROR",
              },
            })
          : respond(
              200,
              summary({ status, messages: [], summaryRevision: null }),
            );
      },
    );

    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

    recovered = true;
    await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  },
);

test("The fallback follows a saved language change and stays stable when reopening the thread", async () => {
  installActiveRun();
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      return respond(200, summary({ status: "pending", messages: [] }));
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

  click(await findLink("Agents"));
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  click(await findLink("Run conversation"));
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

  click(await findButton("Test User"));
  const menu = await screen.findByRole("menu");
  const settings = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Settings";
  });
  expect(settings).toBeDefined();
  click(settings!);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(within(dialog).getByRole("combobox", { name: "Language" }));
  click(await screen.findByRole("option", { name: "日本語" }));

  await expect(screen.findByText("考え中...")).resolves.toBeVisible();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
});

test("Authoritative switch hydration starts demand in the mounted thread", async () => {
  installActiveRun();
  const featureResponse = createDeferredPromise<void>(context.signal);
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    await featureResponse.promise;
    return respond(200, {
      switches: featureSwitches,
      effectiveSwitches: featureSwitches,
    });
  });
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      return respond(200, summary({ status: "pending", messages: [] }));
    },
  );

  await setupPage({ context, path: RUN_PATH });
  await expect(screen.findByText(LEGACY_FALLBACK)).resolves.toBeVisible();

  featureResponse.resolve(undefined);
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  expect(screen.queryByText(LEGACY_FALLBACK)).not.toBeInTheDocument();
});

test("The loop keeps polling while hidden and does not adopt retryAfterMs", async () => {
  context.mocks.browser.visibilityState("hidden");
  installActiveRun();
  const secondStarted = createDeferredPromise<void>(context.signal);
  const releaseSecond = createDeferredPromise<void>(context.signal);
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ respond }) => {
      requests++;
      if (requests === 1) {
        return respond(200, summary({ retryAfterMs: 60_000 }));
      }
      if (!secondStarted.settled()) {
        secondStarted.resolve(undefined);
      }
      await releaseSecond.promise;
      return respond(
        200,
        summary({
          messages: [{ id: ACTIVITY, text: ACTIVITY }],
          summaryRevision: "summary-next",
          summarySequence: 3,
          summaryMessageCursor: 3,
        }),
      );
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  await act(async () => {
    await secondStarted.promise;
  });
  expect(requests).toBeGreaterThanOrEqual(2);

  releaseSecond.resolve(undefined);
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
});

test("The last resolved summary remains visible while a refresh is loading", async () => {
  installActiveRun();
  const refreshStarted = createDeferredPromise<void>(context.signal);
  const refreshResponse = createDeferredPromise<void>(context.signal);
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ respond }) => {
      requests++;
      if (requests === 1) {
        return respond(200, summary());
      }
      if (!refreshStarted.settled()) {
        refreshStarted.resolve(undefined);
      }
      await refreshResponse.promise;
      return respond(
        200,
        summary({ messages: [{ id: ACTIVITY, text: ACTIVITY }] }),
      );
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  await act(async () => {
    await refreshStarted.promise;
  });
  expect(screen.getByText(PREPARATION)).toBeVisible();

  refreshResponse.resolve(undefined);
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
});

test.each(["completed", "cancelled", "replaced", "queued"] as const)(
  "A %s run aborts its demand loop",
  async (outcome) => {
    const events = installActiveRun();
    const firstRequestStarted = createDeferredPromise<AbortSignal>(
      context.signal,
    );
    const oldRunResponse = createDeferredPromise<void>(context.signal);
    const requestedRuns: string[] = [];
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      async ({ body, signal, respond }) => {
        requestedRuns.push(body.runId);
        if (body.runId === RUN_ID) {
          if (!firstRequestStarted.settled()) {
            firstRequestStarted.resolve(signal);
          }
          await oldRunResponse.promise;
        }
        return respond(
          200,
          summary({
            runId: body.runId,
            messages: [
              {
                id: "current",
                text: body.runId === RUN_ID ? PREPARATION : ACTIVITY,
              },
            ],
          }),
        );
      },
    );

    await setupPage({ context, path: RUN_PATH, featureSwitches });
    const demandSignal = await firstRequestStarted.promise;
    await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

    if (outcome === "replaced") {
      events.push(
        promptEvent({
          id: "replacement",
          runId: NEXT_RUN_ID,
          seqId: 3,
          text: "Prepare another checklist",
        }),
      );
    } else if (outcome === "queued") {
      events.push({
        id: "queued-run",
        role: "assistant",
        content: null,
        eventType: "run.queued",
        runEventId: "queue:queued",
        runId: RUN_ID,
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      });
    } else {
      events.push(
        outcome === "completed"
          ? completedEvent({ id: "completed", runId: RUN_ID, seqId: 3 })
          : cancelledEvent({ id: "cancelled", runId: RUN_ID, seqId: 3 }),
      );
    }
    publishRunUpdate();

    await waitFor(() => {
      expect(demandSignal.aborted).toBeTruthy();
    });
    oldRunResponse.resolve(undefined);

    const outcomeIndicator =
      outcome === "replaced"
        ? screen.findByText(ACTIVITY)
        : outcome === "queued"
          ? findButton("queue...")
          : outcome === "completed"
            ? findButton("Send")
            : screen.findByText(
                "Paused mid-thought — pick it back up whenever.",
              );
    await expect(outcomeIndicator).resolves.toBeVisible();
    expect(requestedRuns.includes(NEXT_RUN_ID)).toBe(outcome === "replaced");
    expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  },
);

test.each([403, 404, "ineligible"] as const)(
  "A %s response clears copy without blocking a later loop retry",
  async (status) => {
    installActiveRun();
    let phase: "fresh" | "failed" | "recovered" = "fresh";
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      ({ respond }) => {
        if (phase === "fresh") {
          return respond(200, summary());
        }
        if (phase === "recovered") {
          return respond(
            200,
            summary({ messages: [{ id: ACTIVITY, text: ACTIVITY }] }),
          );
        }
        return status === "ineligible"
          ? respond(
              200,
              summary({ status, messages: [], summaryRevision: null }),
            )
          : respond(status, {
              error: { message: "Unavailable", code: "FORBIDDEN" },
            });
      },
    );

    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();

    phase = "failed";
    await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
    expect(screen.queryByText(PREPARATION)).not.toBeInTheDocument();

    phase = "recovered";
    await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
  },
);

test("A replacement run cannot display the previous run's last result", async () => {
  const events = installActiveRun();
  const nextRunStarted = createDeferredPromise<void>(context.signal);
  const nextRunResponse = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ body, respond }) => {
      if (body.runId === RUN_ID) {
        return respond(200, summary());
      }
      if (!nextRunStarted.settled()) {
        nextRunStarted.resolve(undefined);
      }
      await nextRunResponse.promise;
      return respond(
        200,
        summary({
          runId: NEXT_RUN_ID,
          messages: [{ id: ACTIVITY, text: ACTIVITY }],
        }),
      );
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();

  events.push(
    promptEvent({
      id: "replacement",
      runId: NEXT_RUN_ID,
      seqId: 2,
      text: "Prepare another checklist",
    }),
  );
  publishRunUpdate();
  await act(async () => {
    await nextRunStarted.promise;
  });

  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();

  nextRunResponse.resolve(undefined);
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
});

test("Navigating away aborts the owned demand loop and its request", async () => {
  installActiveRun();
  const requestStarted = createDeferredPromise<AbortSignal>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ signal, respond }) => {
      requests++;
      if (!requestStarted.settled()) {
        requestStarted.resolve(signal);
      }
      await response.promise;
      return respond(200, summary());
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  const demandSignal = await requestStarted.promise;
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

  click(await findLink("Agents"));
  await waitFor(() => {
    expect(demandSignal.aborted).toBeTruthy();
  });
  response.resolve(undefined);
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();

  expect(requests).toBeGreaterThan(0);
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
});
