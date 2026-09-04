import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  findButton,
  installRunChat,
  promptEvent,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const RUN_ID = "a0000000-0000-4000-a000-000000000281";

function artifactUrl(id: string, filename: string): string {
  return `https://cdn.vm7.io/artifacts/run-folding/${id}/${filename}`;
}

function assistantGroupFor(element: Element): HTMLElement {
  const group = element.closest<HTMLElement>('[data-role="assistant"]');
  if (!group) {
    throw new Error("Expected content inside one assistant response");
  }
  return group;
}

function expectDocumentOrder(...elements: readonly Element[]): void {
  for (let index = 1; index < elements.length; index += 1) {
    expect(
      elements[index - 1]!.compareDocumentPosition(elements[index]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
}

function viewAgentProfileLinks(): HTMLElement[] {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("aria-label") === "View agent profile";
  });
}

function namedLinks(name: string): HTMLElement[] {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("aria-label") === name;
  });
}

function queryNamedLink(name: string): HTMLElement | null {
  return namedLinks(name)[0] ?? null;
}

function findNamedLink(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const link = queryNamedLink(name);
    if (!link) {
      throw new Error(`Link ${name} was not visible`);
    }
    return link;
  });
}

async function setupArtifactRun(
  outputEvents: ReturnType<typeof assistantEvent>[],
): Promise<void> {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "artifact-projection-user",
        runId: RUN_ID,
        seqId: 1,
        text: "Prepare the artifact summary",
      }),
      ...outputEvents,
      completedEvent({
        id: "artifact-projection-complete",
        runId: RUN_ID,
        seqId: outputEvents.length + 2,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });
  await readyChat();
}

test("Carry an artifact referenced only by history below the main result", async () => {
  const reportUrl = artifactUrl("supporting-report", "supporting-report.pdf");
  await setupArtifactRun([
    assistantEvent({
      id: "history-only-artifact",
      runId: RUN_ID,
      seqId: 2,
      text: `Generated supporting evidence.\n\n${reportUrl}`,
    }),
    assistantEvent({
      id: "history-only-main",
      runId: RUN_ID,
      seqId: 3,
      text: "Final release summary",
    }),
  ]);

  const main = screen.getByText("Final release summary");
  const artifact = await findNamedLink(
    "Open pdf preview for supporting-report.pdf",
  );
  const assistantGroup = assistantGroupFor(main);
  const actions = assistantGroup.querySelector<HTMLElement>(
    '[data-testid="chat-event-actions"]',
  );
  if (!actions) {
    throw new Error("Expected the main result action bar");
  }
  expect(actions).toBeVisible();
  expectDocumentOrder(main, artifact, actions);
  expect(screen.queryByText("Generated supporting evidence.")).toBeNull();
  expect(assistantGroupFor(artifact)).toBe(assistantGroup);
  const mainMessage = main.closest<HTMLElement>("[data-chat-run-work-main]");
  if (!mainMessage) {
    throw new Error("Expected the artifact inside the main message region");
  }
  expect(mainMessage).toContainElement(actions);
  await expect(findButton("Expand work history")).resolves.toBeVisible();
  expect(viewAgentProfileLinks()).toHaveLength(1);
});

test("Subtract final artifacts after ordered URL deduplication", async () => {
  const appendixUrl = artifactUrl("appendix", "appendix.pdf");
  const repeatedUrl = artifactUrl("repeated", "repeated.pdf");
  const sourceUrl = artifactUrl("source", "source.pdf");
  await setupArtifactRun([
    assistantEvent({
      id: "artifact-difference-first-history",
      runId: RUN_ID,
      seqId: 2,
      text: ["First historical output", appendixUrl, repeatedUrl].join("\n\n"),
    }),
    assistantEvent({
      id: "artifact-difference-second-history",
      runId: RUN_ID,
      seqId: 3,
      text: ["Second historical output", repeatedUrl, sourceUrl].join("\n\n"),
    }),
    assistantEvent({
      id: "artifact-difference-main",
      runId: RUN_ID,
      seqId: 4,
      text: ["Final artifact summary", repeatedUrl].join("\n\n"),
    }),
  ]);

  const main = screen.getByText("Final artifact summary");
  await findNamedLink("Open pdf preview for repeated.pdf");
  const repeatedArtifacts = namedLinks("Open pdf preview for repeated.pdf");
  expect(repeatedArtifacts).toHaveLength(1);
  const repeated = repeatedArtifacts[0]!;
  const appendix = await findNamedLink("Open pdf preview for appendix.pdf");
  const source = await findNamedLink("Open pdf preview for source.pdf");
  expect(screen.queryByText("First historical output")).toBeNull();
  expect(screen.queryByText("Second historical output")).toBeNull();
  expectDocumentOrder(main, repeated, appendix, source);
  expect(assistantGroupFor(appendix)).toBe(assistantGroupFor(main));
  expect(assistantGroupFor(source)).toBe(assistantGroupFor(main));
});

test("Keep artifacts with the same filename distinct when their URLs differ", async () => {
  const firstUrl = artifactUrl("first-report", "report.pdf");
  const secondUrl = artifactUrl("second-report", "report.pdf");
  await setupArtifactRun([
    assistantEvent({
      id: "same-name-first-history",
      runId: RUN_ID,
      seqId: 2,
      text: `First report version\n\n${firstUrl}`,
    }),
    assistantEvent({
      id: "same-name-second-history",
      runId: RUN_ID,
      seqId: 3,
      text: `Second report version\n\n${secondUrl}`,
    }),
    assistantEvent({
      id: "same-name-main",
      runId: RUN_ID,
      seqId: 4,
      text: "Final same-name report summary",
    }),
  ]);

  await findNamedLink("Open pdf preview for report.pdf");
  await waitFor(() => {
    expect(namedLinks("Open pdf preview for report.pdf")).toHaveLength(2);
  });
  const main = screen.getByText("Final same-name report summary");
  const artifacts = namedLinks("Open pdf preview for report.pdf");
  expectDocumentOrder(main, ...artifacts);
  expect(artifacts[0]).toHaveAttribute("href", firstUrl);
  expect(artifacts[1]).toHaveAttribute("href", secondUrl);
  expect(screen.queryByText("First report version")).toBeNull();
  expect(screen.queryByText("Second report version")).toBeNull();
});

test("Do not carry inline media or action cards out of historical messages", async () => {
  await setupArtifactRun([
    assistantEvent({
      id: "non-artifact-history",
      runId: RUN_ID,
      seqId: 2,
      text: [
        "Historical rich output",
        "![Inline chart](https://example.com/inline-chart.png)",
        "[Compare plans](/?settings=billing&billingView=plans)",
      ].join("\n\n"),
    }),
    assistantEvent({
      id: "non-artifact-main",
      runId: RUN_ID,
      seqId: 3,
      text: "Final result without artifacts",
    }),
  ]);

  expect(screen.getByText("Final result without artifacts")).toBeVisible();
  expect(screen.queryByText("Historical rich output")).toBeNull();
  expect(screen.queryByAltText("Inline chart")).toBeNull();
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();
  await expect(findButton("Expand work history")).resolves.toBeVisible();
});

test("Carry artifacts across every run in the same run group", async () => {
  const runGroupId = "e0000000-0000-4000-a000-000000000282";
  const nextRunId = "a0000000-0000-4000-a000-000000000282";
  const earlierUrl = artifactUrl("earlier-run", "earlier-run.pdf");
  const automationInput = (
    id: string,
    runId: string,
    seqId: number,
  ): MockChatEventInput => {
    return {
      id,
      role: "user",
      eventType: "input.automation",
      content: null,
      runId,
      runGroupId,
      seqId,
      createdAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: "artifact-review",
            automationBrief: "Review generated artifacts",
          },
        ],
      },
    };
  };
  const inRunGroup = (event: MockChatEventInput): MockChatEventInput => {
    return { ...event, runGroupId };
  };
  installRunChat({
    chatEvents: [
      automationInput("earlier-run-input", RUN_ID, 1),
      inRunGroup(
        assistantEvent({
          id: "earlier-run-artifact",
          runId: RUN_ID,
          seqId: 2,
          text: `Earlier run output\n\n${earlierUrl}`,
        }),
      ),
      inRunGroup(
        completedEvent({
          id: "earlier-run-complete",
          runId: RUN_ID,
          seqId: 3,
        }),
      ),
      automationInput("next-run-input", nextRunId, 4),
      inRunGroup(
        assistantEvent({
          id: "next-run-main",
          runId: nextRunId,
          seqId: 5,
          text: "Latest run result",
        }),
      ),
      inRunGroup(
        completedEvent({
          id: "next-run-complete",
          runId: nextRunId,
          seqId: 6,
        }),
      ),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });
  await readyChat();

  const main = screen.getByText("Latest run result");
  const artifact = await findNamedLink("Open pdf preview for earlier-run.pdf");
  expect(screen.queryByText("Earlier run output")).toBeNull();
  expectDocumentOrder(main, artifact);
  expect(assistantGroupFor(artifact)).toBe(assistantGroupFor(main));
  expect(queryButton("Expand grouped run history")).toBeNull();
  await expect(findButton("Expand work history")).resolves.toBeVisible();
});

test("Ignore artifacts from revoked output messages", async () => {
  const obsoleteUrl = artifactUrl("obsolete", "obsolete.pdf");
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "revoked-artifact-user",
        runId: RUN_ID,
        seqId: 1,
        text: "Replace the obsolete artifact",
      }),
      assistantEvent({
        id: "revoked-artifact-output",
        runId: RUN_ID,
        seqId: 2,
        text: obsoleteUrl,
      }),
      {
        id: "revoked-artifact-replacement",
        eventType: "output.message",
        role: "assistant",
        content: "The obsolete artifact was withdrawn",
        runId: RUN_ID,
        revokesEventId: "revoked-artifact-output",
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      },
      completedEvent({
        id: "revoked-artifact-complete",
        runId: RUN_ID,
        seqId: 4,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatRunWorkFolding]: true },
  });
  await readyChat();

  expect(screen.getByText("The obsolete artifact was withdrawn")).toBeVisible();
  expect(queryNamedLink("Open pdf preview for obsolete.pdf")).toBeNull();
  expect(queryButton("Expand work history")).toBeNull();
});
