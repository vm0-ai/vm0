import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { HttpResponse } from "msw";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockNow, now } from "../../../lib/time.ts";
import {
  assistantEvent,
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
  RUN_THREAD_ID,
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
    phrase: PREPARATION,
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

function advanceTime(milliseconds: number) {
  mockNow(now() + milliseconds, context.signal);
}

function changeVisibility(
  visibility: ReturnType<typeof context.mocks.browser.visibilityState>,
  state: DocumentVisibilityState,
) {
  act(() => {
    visibility.changeTo(state);
  });
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

test.each(["pending", "cooldown", 500] as const)(
  "A %s response without copy keeps one fallback before and after commentary until a summary arrives",
  async (status) => {
    context.mocks.browser.visibilityState("visible");
    const events = installActiveRun();
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
              summary({ status, phrase: null, summaryRevision: null }),
            );
      },
    );
    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

    events.push(
      assistantEvent({
        id: "fallback-commentary",
        runId: RUN_ID,
        seqId: 2,
        text: "The main run continues while the summary is unavailable.",
      }),
    );
    publishRunUpdate();
    await expect(
      screen.findByText(
        "The main run continues while the summary is unavailable.",
      ),
    ).resolves.toBeVisible();
    expect(screen.getByText("Thinking...")).toBeVisible();

    recovered = true;
    advanceTime(60_001);
    await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  },
);

test("The fallback follows a saved language change and stays stable when reopening the thread", async () => {
  context.mocks.browser.visibilityState("visible");
  installActiveRun();
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      return respond(200, summary({ status: "pending", phrase: null }));
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

test("Authoritative switch activation replaces the legacy fallback in the mounted thread", async () => {
  context.mocks.browser.visibilityState("visible");
  const events = installActiveRun();
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
      return respond(200, summary({ status: "pending", phrase: null }));
    },
  );
  const page = startPage({
    context,
    path: RUN_PATH,
    cachedFeatureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });
  await expect(screen.findByText(LEGACY_FALLBACK)).resolves.toBeVisible();
  featureResponse.resolve(undefined);
  await (
    await page
  ).ready;
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  expect(screen.queryByText(LEGACY_FALLBACK)).not.toBeInTheDocument();
  events.push(
    assistantEvent({
      id: "after-switch-activation",
      runId: RUN_ID,
      seqId: 2,
      text: "The run continues after enabling activity summaries.",
    }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("The run continues after enabling activity summaries."),
  ).resolves.toBeVisible();
  expect(screen.getByText("Thinking...")).toBeVisible();
});

test("Only a visible main thread requests and later copy survives commentary and a completed animation", async () => {
  const initialTime = new Date("2026-09-09T08:00:00.000Z").getTime();
  mockNow(initialTime, context.signal);
  const visibility = context.mocks.browser.visibilityState("hidden");
  const events = installActiveRun();
  const requests: { threadId: string; body: unknown }[] = [];
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ params, body, respond }) => {
      requests.push({ threadId: params.id, body });
      return respond(
        200,
        summary(
          requests.length > 1
            ? {
                phrase: ACTIVITY,
                // Hash order decreases while the actual summary advances.
                summaryRevision: "summary-a",
                summarySequence: 3,
                summaryMessageCursor: 3,
                summarizedAt: "2026-09-09T08:00:15.000Z",
              }
            : {},
        ),
      );
    },
  );
  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await readyChat();
  expect(screen.getByText("Thinking...")).toBeVisible();
  expect(requests).toHaveLength(0);
  changeVisibility(visibility, "visible");
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  expect(requests).toStrictEqual([
    { threadId: RUN_THREAD_ID, body: { runId: RUN_ID } },
  ]);
  mockNow(initialTime + 14_999, context.signal);
  events.push(
    assistantEvent({
      id: "activity-commentary",
      runId: RUN_ID,
      seqId: 2,
      text: "I have started checking the release.",
    }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("I have started checking the release."),
  ).resolves.toBeVisible();
  expect(requests).toHaveLength(1);
  // Advance the production clock; keep real timers and the viewer mounted.
  mockNow(initialTime + 15_001, context.signal);
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
  expect(requests).toHaveLength(2);
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
});

test.each(["pending", "cooldown", "stale"] as const)(
  "A cached %s phrase keeps its actual provenance and identical text stays readable",
  async (status) => {
    const visibility = context.mocks.browser.visibilityState("visible");
    installActiveRun();
    let result = summary({
      status,
      sourceRevision: "new-source",
      sourceSequence: 100,
      messageCursor: 100,
    });
    const refreshed = createDeferredPromise<void>(context.signal);
    let requests = 0;
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      ({ respond }) => {
        requests++;
        if (requests === 2) {
          refreshed.resolve(undefined);
        }
        return respond(200, result);
      },
    );
    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      mutations.push(...records);
    });
    const label = screen.getByLabelText(PREPARATION);
    observer.observe(label, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    context.signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
    result = summary({
      status,
      sourceRevision: "new-source",
      sourceSequence: 100,
      messageCursor: 100,
      retryAfterMs: 60_000,
    });
    changeVisibility(visibility, "hidden");
    advanceTime(15_001);
    changeVisibility(visibility, "visible");
    await act(async () => {
      await refreshed.promise;
    });
    expect(screen.getByText(PREPARATION)).toBeVisible();
    expect(screen.getByLabelText(PREPARATION)).toBe(label);
    // A newer current source must not relabel old copy as a new summary.
    result = summary({
      phrase: ACTIVITY,
      summaryRevision: "summary-a",
      summarySequence: 3,
      summaryMessageCursor: 3,
      summarizedAt: "2026-09-09T08:00:15.000Z",
    });
    changeVisibility(visibility, "hidden");
    advanceTime(60_001);
    changeVisibility(visibility, "visible");
    await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
    expect(mutations).toHaveLength(0);
  },
);

test("Hide and reopen aborts old demand and ignores its late response", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  installActiveRun();
  const started = createDeferredPromise<AbortSignal>(context.signal);
  const oldResponse = createDeferredPromise<void>(context.signal);
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ signal, respond }) => {
      requests++;
      if (requests === 1) {
        started.resolve(signal);
        await oldResponse.promise;
        return respond(200, summary());
      }
      return respond(
        200,
        summary({
          phrase: ACTIVITY,
          summaryRevision: "a",
          summarySequence: 4,
          summarizedAt: "2026-09-09T08:00:15.000Z",
        }),
      );
    },
  );
  await setupPage({ context, path: RUN_PATH, featureSwitches });
  const requestSignal = await started.promise;
  changeVisibility(visibility, "hidden");
  await waitFor(() => {
    expect(requestSignal.aborted).toBeTruthy();
  });
  expect(requests).toBe(1);
  changeVisibility(visibility, "visible");
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
  oldResponse.resolve(undefined);
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
  expect(screen.getByText(ACTIVITY)).toBeVisible();
});

test("An outstanding request cannot overlap another interval or survive navigation", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const events = installActiveRun();
  const started = createDeferredPromise<AbortSignal>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ signal, respond }) => {
      requests++;
      started.resolve(signal);
      await response.promise;
      return respond(200, summary());
    },
  );
  await setupPage({ context, path: RUN_PATH, featureSwitches });
  const requestSignal = await started.promise;
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  advanceTime(120_000);
  events.push(
    assistantEvent({
      id: "while-summary-pending",
      runId: RUN_ID,
      seqId: 2,
      text: "The main run continues while summary is pending.",
    }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("The main run continues while summary is pending."),
  ).resolves.toBeVisible();
  expect(screen.getByText("Thinking...")).toBeVisible();
  expect(requests).toBe(1);
  expect(requestSignal.aborted).toBeFalsy();
  click(await findLink("Agents"));
  await waitFor(() => {
    expect(requestSignal.aborted).toBeTruthy();
  });
  response.resolve(undefined);
  changeVisibility(visibility, "hidden");
  changeVisibility(visibility, "visible");
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
  expect(requests).toBe(1);
});

test("Server cooldown survives hide and reopen before demand can refresh", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const events = installActiveRun();
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      requests++;
      return respond(
        200,
        summary({
          status: "cooldown",
          phrase: requests === 1 ? PREPARATION : ACTIVITY,
          retryAfterMs: 60_000,
        }),
      );
    },
  );
  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  changeVisibility(visibility, "hidden");
  advanceTime(15_001);
  changeVisibility(visibility, "visible");
  events.push(
    assistantEvent({
      id: "during-cooldown",
      runId: RUN_ID,
      seqId: 2,
      text: "Progress is available during cooldown.",
    }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("Progress is available during cooldown."),
  ).resolves.toBeVisible();
  expect(requests).toBe(1);
  advanceTime(45_000);
  await expect(screen.findByLabelText(ACTIVITY)).resolves.toBeVisible();
  expect(requests).toBe(2);
});

test("Optional service failures have a bounded retry budget across visibility changes", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const events = installActiveRun();
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      requests++;
      return respond(200, summary({ status: "unavailable", phrase: null }));
    },
  );
  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  for (const attempt of [1, 2, 3]) {
    await waitFor(() => {
      expect(requests).toBe(attempt);
    });
    events.push(
      assistantEvent({
        id: `during-failure-${attempt}`,
        runId: RUN_ID,
        seqId: attempt + 1,
        text: `Main run progress ${attempt}`,
      }),
    );
    publishRunUpdate();
    await expect(
      screen.findByText(`Main run progress ${attempt}`),
    ).resolves.toBeVisible();
    expect(screen.getByText("Thinking...")).toBeVisible();
    changeVisibility(visibility, "hidden");
    advanceTime(60_001);
    changeVisibility(visibility, "visible");
  }
  await readyChat();
  expect(requests).toBe(3);
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
});

test.each(["completed", "cancelled", "replaced", "queued"] as const)(
  "A %s run cancels outstanding work and cannot revive its indicator",
  async (outcome) => {
    context.mocks.browser.visibilityState("visible");
    const events = installActiveRun();
    const started = createDeferredPromise<AbortSignal>(context.signal);
    const response = createDeferredPromise<void>(context.signal);
    const requestedRuns: string[] = [];
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      async ({ body, signal, respond }) => {
        requestedRuns.push(body.runId);
        if (body.runId === RUN_ID) {
          started.resolve(signal);
          await response.promise;
        }
        return respond(
          200,
          summary({
            runId: body.runId,
            phrase: body.runId === RUN_ID ? PREPARATION : ACTIVITY,
          }),
        );
      },
    );
    await setupPage({ context, path: RUN_PATH, featureSwitches });
    const requestSignal = await started.promise;
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
      expect(requestSignal.aborted).toBeTruthy();
    });
    response.resolve(undefined);
    const activityLabel =
      outcome === "replaced"
        ? await screen.findByLabelText(ACTIVITY)
        : screen.queryByLabelText(ACTIVITY);
    expect(activityLabel !== null).toBe(outcome === "replaced");
    expect(requestedRuns).toStrictEqual(
      outcome === "replaced" ? [RUN_ID, NEXT_RUN_ID] : [RUN_ID],
    );
    expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
    const outcomeIndicator =
      outcome === "queued"
        ? await findButton("queue...")
        : outcome === "completed"
          ? await findButton("Send")
          : await screen.findByText(
              outcome === "cancelled"
                ? "Paused mid-thought — pick it back up whenever."
                : ACTIVITY,
            );
    expect(outcomeIndicator).toBeVisible();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  },
);

test.each([403, 404, "ineligible"] as const)(
  "A %s response clears copy and stops retries across visibility changes",
  async (status) => {
    const visibility = context.mocks.browser.visibilityState("visible");
    installActiveRun();
    let requests = 0;
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      ({ respond }) => {
        requests++;
        if (requests === 1) {
          return respond(200, summary());
        }
        return status === "ineligible"
          ? respond(
              200,
              summary({ status, phrase: null, summaryRevision: null }),
            )
          : respond(status, {
              error: { message: "Unavailable", code: "FORBIDDEN" },
            });
      },
    );
    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
    changeVisibility(visibility, "hidden");
    advanceTime(15_001);
    changeVisibility(visibility, "visible");
    await waitFor(() => {
      expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
    });
    changeVisibility(visibility, "hidden");
    changeVisibility(visibility, "visible");
    await readyChat();
    expect(requests).toBe(2);
  },
);

test("A new app with an unavailable or malformed API retains a usable current-run phrase", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  installActiveRun();
  let requests = 0;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      requests++;
      return respond(
        200,
        summary(
          requests === 1
            ? {}
            : { phrase: null, status: "unavailable", retryAfterMs: 60_000 },
        ),
      );
    },
  );
  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  changeVisibility(visibility, "hidden");
  advanceTime(15_001);
  changeVisibility(visibility, "visible");
  await waitFor(() => {
    expect(requests).toBe(2);
  });
  expect(screen.getByText(PREPARATION)).toBeVisible();
  const malformed = createDeferredPromise<void>(context.signal);
  context.mocks.http.post("*/api/chat-threads/:id/activity-summary", () => {
    malformed.resolve(undefined);
    return HttpResponse.json({ oldApi: true });
  });
  changeVisibility(visibility, "hidden");
  advanceTime(60_001);
  changeVisibility(visibility, "visible");
  await malformed.promise;
  expect(screen.getByText(PREPARATION)).toBeVisible();
});

test("Authoritative switch rollback aborts a request started from cached feature state", async () => {
  context.mocks.browser.visibilityState("visible");
  const events = installActiveRun();
  const featureResponse = createDeferredPromise<void>(context.signal);
  const summaryResponse = createDeferredPromise<void>(context.signal);
  const started = createDeferredPromise<AbortSignal>(context.signal);
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    await featureResponse.promise;
    return respond(200, {
      switches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
      effectiveSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
    });
  });
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ signal, respond }) => {
      started.resolve(signal);
      await summaryResponse.promise;
      return respond(200, summary());
    },
  );
  const page = startPage({
    context,
    path: RUN_PATH,
    cachedFeatureSwitches: featureSwitches,
  });
  const requestSignal = await started.promise;
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  featureResponse.resolve(undefined);
  await (
    await page
  ).ready;
  await readyChat();
  await expect(screen.findByText(LEGACY_FALLBACK)).resolves.toBeVisible();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  await waitFor(() => {
    expect(requestSignal.aborted).toBeTruthy();
  });
  summaryResponse.resolve(undefined);
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
  events.push(
    assistantEvent({
      id: "after-switch-rollback",
      runId: RUN_ID,
      seqId: 2,
      text: "The run continues with the original indicator.",
    }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("The run continues with the original indicator."),
  ).resolves.toBeVisible();
  expect(screen.getByText(LEGACY_FALLBACK)).toBeVisible();
});
