import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  creditUsage,
  followupEvent,
  findButton,
  findLink,
  installRunChat,
  promptEvent,
  queryButton,
  RUN_PATH,
  usageEvent,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000401";
const RUN_B = "a0000000-0000-4000-a000-000000000402";
const FINISHED_AT = "2026-08-01T14:35:00.000Z";

function fullUsage() {
  return creditUsage(75, [
    {
      kind: "model/claude-sonnet-4-6/tokens.input",
      credits: 8,
      providers: [{ provider: "anthropic", credits: 8 }],
    },
    {
      kind: "image/flux-pro/output_image",
      credits: 10,
      providers: [{ provider: "fal-ai/flux-pro", credits: 10 }],
    },
    {
      kind: "video/veo-3/output_video",
      credits: 12,
      providers: [{ provider: "google/veo-3", credits: 12 }],
    },
    {
      kind: "model/joggai-talking-avatar",
      credits: 5,
      providers: [{ provider: "joggai-talking-avatar", credits: 5 }],
    },
    {
      kind: "connector",
      credits: 4,
      providers: [{ provider: "slack", credits: 4 }],
    },
    {
      kind: "web-search",
      credits: 9,
      providers: [{ provider: "internal_web_search_v2", credits: 9 }],
    },
    {
      kind: "maps",
      credits: 7,
      providers: [{ provider: "internal_maps_v1", credits: 7 }],
    },
    {
      kind: "finance",
      credits: 11,
      providers: [{ provider: "internal_finance_v1", credits: 11 }],
    },
    {
      kind: "weather",
      credits: 9,
      providers: [{ provider: "internal_weather_v1", credits: 9 }],
    },
  ]);
}

function installCompletedFollowup(): void {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "localized-user",
        runId: RUN_A,
        seqId: 1,
        text: "Summarize the release",
      }),
      assistantEvent({
        id: "localized-answer",
        runId: RUN_A,
        seqId: 2,
        text: "The release summary is ready.",
      }),
      completedEvent({
        id: "localized-complete",
        runId: RUN_A,
        seqId: 3,
        createdAt: FINISHED_AT,
      }),
      followupEvent({ id: "localized-followup", runId: RUN_A, seqId: 4 }),
    ],
  });
}

function localizedTimestamp(locale: string): string {
  return new Date(FINISHED_AT).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

test("Inspect friendly credit usage for a run", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "usage-user",
        runId: RUN_A,
        seqId: 1,
        text: "Produce the campaign assets",
      }),
      assistantEvent({
        id: "usage-answer",
        runId: RUN_A,
        seqId: 2,
        text: "The campaign assets are complete.",
      }),
      completedEvent({ id: "usage-complete", runId: RUN_A, seqId: 3 }),
      usageEvent({
        id: "usage-settlement",
        runId: RUN_A,
        seqId: 4,
        usage: fullUsage(),
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await expect(
    screen.findByText("The campaign assets are complete."),
  ).resolves.toBeVisible();
  const usageButton = await findButton("Credit usage 75");
  expect(usageButton).toBeVisible();
  await user.click(usageButton);

  const details = await screen.findByText("Credit usage");
  expect(details).toBeVisible();
  for (const name of [
    "Claude Sonnet 4.6",
    "Flux Pro",
    "Veo 3",
    "Avatar",
    "Slack",
    "Web Search",
    "Maps",
    "Finance",
    "Weather",
  ]) {
    for (const label of screen.getAllByText(name)) {
      expect(label).toBeVisible();
    }
  }
  expect(document.body).not.toHaveTextContent("internal_web_search_v2");

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByText("Credit usage")).not.toBeInTheDocument();
  });
  await user.click(usageButton);

  await waitFor(() => {
    expect(screen.getAllByText("Claude Sonnet 4.6").length).toBeGreaterThan(1);
  });
  expect(screen.getByText("Web Search")).toBeVisible();
});

test("Show managed-service credit usage in Portuguese", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "pt-usage-user",
        runId: RUN_A,
        seqId: 1,
        text: "Verifique o mercado",
      }),
      assistantEvent({
        id: "pt-usage-answer",
        runId: RUN_A,
        seqId: 2,
        text: "A verificação terminou.",
      }),
      completedEvent({ id: "pt-usage-complete", runId: RUN_A, seqId: 3 }),
      usageEvent({
        id: "pt-usage-settlement",
        runId: RUN_A,
        seqId: 4,
        usage: creditUsage(20, [
          {
            kind: "web-search",
            credits: 5,
            providers: [{ provider: "raw_web_provider", credits: 5 }],
          },
          {
            kind: "maps",
            credits: 5,
            providers: [{ provider: "raw_maps_provider", credits: 5 }],
          },
          {
            kind: "finance",
            credits: 5,
            providers: [{ provider: "raw_finance_provider", credits: 5 }],
          },
          {
            kind: "weather",
            credits: 5,
            providers: [{ provider: "raw_weather_provider", credits: 5 }],
          },
        ]),
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH, locale: "pt-BR" });

  await expect(
    screen.findByText("A verificação terminou."),
  ).resolves.toBeVisible();
  const usageButton = await findButton("Uso de créditos 20");
  expect(usageButton).toBeVisible();
  await user.click(usageButton);

  await expect(screen.findByText("Uso de créditos")).resolves.toBeVisible();
  expect(screen.getByText("Pesquisa na web")).toBeVisible();
  expect(screen.getByText("Mapas")).toBeVisible();
  expect(screen.getByText("Finanças")).toBeVisible();
  expect(screen.getByText("Clima")).toBeVisible();
  expect(document.body).not.toHaveTextContent("raw_web_provider");
});

test("Show cancellation-recovery guidance in Portuguese", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "pt-recovery-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare a entrega",
      }),
      cancelledEvent({
        id: "pt-recovery-cancelled",
        runId: RUN_A,
        seqId: 2,
      }),
      {
        id: "pt-recovery-automation",
        eventType: "input.automation",
        role: "user",
        content: null,
        runId: undefined,
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "Verificações de implantação",
              automationBrief: "Executar as verificações pendentes",
            },
          ],
        },
      },
    ],
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: true,
    });
  });

  await setupPage({ context, path: RUN_PATH, locale: "pt-BR" });

  await expect(
    screen.findByText("Pausado no meio do raciocínio — retome quando quiser."),
  ).resolves.toBeVisible();
  await expect(
    screen.findByText("Executar as verificações pendentes"),
  ).resolves.toBeVisible();
  click(await findButton("Sobre este evento de automação"));
  await expect(screen.findByText("Evento de automação")).resolves.toBeVisible();
  expect(
    screen.getAllByText(
      "Finalizando a execução cancelada antes de continuar o trabalho na fila.",
    ),
  ).toHaveLength(2);
});

test("Show completed-run details in Portuguese", async () => {
  installCompletedFollowup();

  await setupPage({ context, path: RUN_PATH, locale: "pt-BR" });

  const label = `Continuar · ${localizedTimestamp("pt-BR")}`;
  await expect(
    screen.findByText("The release summary is ready."),
  ).resolves.toBeVisible();
  await expect(screen.findByText(label)).resolves.toBeVisible();
});

test("Show completed-run details in Korean", async () => {
  installCompletedFollowup();

  await setupPage({ context, path: RUN_PATH, locale: "ko-KR" });

  const label = `계속 진행 · ${localizedTimestamp("ko-KR")}`;
  await expect(
    screen.findByText("The release summary is ready."),
  ).resolves.toBeVisible();
  await expect(screen.findByText(label)).resolves.toBeVisible();
});

test("Show completed-run details in Japanese", async () => {
  installCompletedFollowup();

  await setupPage({ context, path: RUN_PATH, locale: "ja-JP" });

  const label = `続ける · ${localizedTimestamp("ja-JP")}`;
  await expect(
    screen.findByText("The release summary is ready."),
  ).resolves.toBeVisible();
  await expect(screen.findByText(label)).resolves.toBeVisible();
});

test("Show completed-run details in Spanish", async () => {
  installCompletedFollowup();

  await setupPage({ context, path: RUN_PATH, locale: "es-ES" });

  const label = `Sigue adelante · ${localizedTimestamp("es-ES")}`;
  await expect(
    screen.findByText("The release summary is ready."),
  ).resolves.toBeVisible();
  await expect(screen.findByText(label)).resolves.toBeVisible();
});

test("Return to the conversation that started a chat message", async () => {
  const user = userEvent.setup({ delay: null });
  const sources = [
    {
      id: "source-slack",
      kind: "slack" as const,
      label: "Open original message in Slack",
      href: "https://slack.com/archives/C123/p456",
    },
    {
      id: "source-feishu",
      kind: "feishu" as const,
      label: "Open original chat in Feishu",
      href: "https://open.feishu.cn/chat/ch_123",
    },
    {
      id: "source-teams",
      kind: "teams" as const,
      label: "Open original message in Microsoft Teams",
      href: "https://teams.microsoft.com/l/message/19:abc/123",
    },
    {
      id: "source-github",
      kind: "github" as const,
      label: "Open original issue or pull request in GitHub",
      href: "https://github.com/vm0-ai/vm0/issues/123",
    },
    {
      id: "source-telegram",
      kind: "telegram" as const,
      label: "Open original message in Telegram",
      href: "https://t.me/example/123",
    },
  ];
  const events: MockChatEventInput[] = sources.map((source, index) => {
    return {
      id: source.id,
      eventType: "input.prompt",
      role: "user",
      content: null,
      runId: RUN_A,
      seqId: index + 1,
      createdAt: `2026-08-01T10:00:0${String(index)}.000Z`,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: `Request from ${source.kind}` },
          { type: "source", kind: source.kind, href: source.href },
        ],
      },
    };
  });
  events.push(
    {
      id: "source-agentphone",
      eventType: "input.prompt",
      role: "user",
      content: null,
      runId: RUN_A,
      seqId: 6,
      createdAt: "2026-08-01T10:00:06.000Z",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Request from agentphone" },
          { type: "source", kind: "agentphone" },
        ],
      },
    },
    assistantEvent({
      id: "source-answer",
      runId: RUN_A,
      seqId: 7,
      text: "All imported requests were reviewed.",
    }),
    completedEvent({ id: "source-complete", runId: RUN_A, seqId: 8 }),
  );
  installRunChat({ chatEvents: events });

  await setupPage({ context, path: RUN_PATH });

  await expect(
    screen.findByText("All imported requests were reviewed."),
  ).resolves.toBeVisible();
  for (const source of sources) {
    const link = await findLink(source.label);
    expect(link).toHaveAttribute("href", source.href);
    expect(link).toHaveAttribute("target", "_blank");
  }
  const slackLink = await findLink("Open original message in Slack");
  await user.click(slackLink);
  expect(slackLink).toHaveAttribute(
    "href",
    "https://slack.com/archives/C123/p456",
  );

  const agentPhoneLabel = screen.getByText("AgentPhone");
  expect(agentPhoneLabel).toBeVisible();
  expect(agentPhoneLabel.closest("a")).toBeNull();
});

test("Show the current usage settlement on the correct run", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "settlement-a-user",
        runId: RUN_A,
        seqId: 1,
        text: "First costed run",
      }),
      assistantEvent({
        id: "settlement-a-answer",
        runId: RUN_A,
        seqId: 2,
        text: "First answer",
      }),
      completedEvent({ id: "settlement-a-complete", runId: RUN_A, seqId: 3 }),
      usageEvent({
        id: "settlement-old",
        runId: RUN_A,
        seqId: 4,
        usage: creditUsage(5, [
          {
            kind: "model",
            credits: 5,
            providers: [{ provider: "gpt-5.6-sol", credits: 5 }],
          },
        ]),
      }),
      usageEvent({
        id: "settlement-replacement",
        runId: RUN_A,
        seqId: 5,
        revokesEventId: "settlement-old",
        usage: creditUsage(8, [
          {
            kind: "model",
            credits: 8,
            providers: [{ provider: "gpt-5.6-sol", credits: 8 }],
          },
        ]),
      }),
      promptEvent({
        id: "settlement-b-user",
        runId: RUN_B,
        seqId: 6,
        text: "Second connector run",
      }),
      assistantEvent({
        id: "settlement-b-answer",
        runId: RUN_B,
        seqId: 7,
        text: "Second answer",
      }),
      completedEvent({ id: "settlement-b-complete", runId: RUN_B, seqId: 8 }),
      usageEvent({
        id: "settlement-b-usage",
        runId: RUN_B,
        seqId: 9,
        usage: creditUsage(3, [
          {
            kind: "connector",
            credits: 3,
            providers: [{ provider: "slack", credits: 3 }],
          },
        ]),
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await expect(screen.findByText("First answer")).resolves.toBeVisible();
  await expect(screen.findByText("Second answer")).resolves.toBeVisible();
  expect(queryButton("Credit usage 5")).toBeNull();
  await expect(findButton("Credit usage 8")).resolves.toBeVisible();
  const secondUsage = await findButton("Credit usage 3");
  expect(secondUsage).toBeVisible();

  await user.click(secondUsage);

  const slackUsage = await screen.findByText("Slack");
  expect(slackUsage).toBeVisible();
  expect(slackUsage.parentElement).toHaveTextContent("3");
  expect(screen.queryByText("GPT 5.6 Sol")).not.toBeInTheDocument();
});
