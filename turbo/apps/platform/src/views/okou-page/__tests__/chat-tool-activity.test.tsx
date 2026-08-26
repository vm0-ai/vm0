import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OutputToolPayload } from "@okouai/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";

const RUN_ID = "f7000000-0000-4000-a000-000000000001";

function toolEvent(args: {
  readonly id: string;
  readonly createdAt: string;
  readonly toolUseId: string;
  readonly action: OutputToolPayload["action"];
  readonly status: OutputToolPayload["status"];
  readonly summary: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    eventType: "output.tool",
    content: null,
    runId: RUN_ID,
    createdAt: args.createdAt,
    toolUseId: args.toolUseId,
    action: args.action,
    status: args.status,
    summary: args.summary,
  };
}

function expectBefore(first: Element, second: Element): void {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

function toolActivityCopyMatrixEvents(): MockChatEventInput[] {
  let second = 0;
  const createdAt = () => {
    return `2026-08-25T11:00:${(second++).toString().padStart(2, "0")}Z`;
  };
  const separator = (id: string): MockChatEventInput => {
    return {
      id,
      role: "assistant",
      content: id,
      runId: RUN_ID,
      createdAt: createdAt(),
    };
  };
  const operation = (
    id: string,
    toolUseId: string,
    action: OutputToolPayload["action"],
    status: OutputToolPayload["status"],
    summary: string,
  ): MockChatEventInput => {
    return toolEvent({
      id,
      createdAt: createdAt(),
      toolUseId,
      action,
      status,
      summary,
    });
  };

  return [
    operation(
      "matrix-pending-singular-run",
      "matrix-pending-singular-run",
      "run",
      "pending",
      "Running command-a",
    ),
    operation(
      "matrix-pending-singular-read",
      "matrix-pending-singular-read",
      "read",
      "pending",
      "Reading file-a",
    ),
    operation(
      "matrix-pending-singular-change",
      "matrix-pending-singular-change",
      "write",
      "pending",
      "Writing file-b",
    ),
    separator("matrix-separator-a"),
    operation(
      "matrix-pending-plural-run-a",
      "matrix-pending-plural-run-a",
      "run",
      "pending",
      "Running command-b",
    ),
    operation(
      "matrix-pending-plural-run-b",
      "matrix-pending-plural-run-b",
      "run",
      "pending",
      "Running command-c",
    ),
    operation(
      "matrix-pending-plural-read-a",
      "matrix-pending-plural-read-a",
      "read",
      "pending",
      "Reading file-c",
    ),
    operation(
      "matrix-pending-plural-read-b",
      "matrix-pending-plural-read-b",
      "read",
      "pending",
      "Reading file-d",
    ),
    operation(
      "matrix-pending-plural-change-a",
      "matrix-pending-plural-change-a",
      "write",
      "pending",
      "Writing file-e",
    ),
    operation(
      "matrix-pending-plural-change-b",
      "matrix-pending-plural-change-b",
      "edit",
      "pending",
      "Editing file-f",
    ),
    separator("matrix-separator-b"),
    operation(
      "matrix-terminal-singular-run-pending",
      "matrix-terminal-singular-run",
      "run",
      "pending",
      "Running command-d",
    ),
    operation(
      "matrix-terminal-singular-run-success",
      "matrix-terminal-singular-run",
      "run",
      "success",
      "Ran command-d",
    ),
    operation(
      "matrix-terminal-singular-read",
      "matrix-terminal-singular-read",
      "read",
      "error",
      "Read file-g",
    ),
    operation(
      "matrix-terminal-singular-change",
      "matrix-terminal-singular-change",
      "edit",
      "cancelled",
      "Edited file-h",
    ),
    separator("matrix-separator-c"),
    operation(
      "matrix-terminal-plural-run-a",
      "matrix-terminal-plural-run-a",
      "run",
      "success",
      "Ran command-e",
    ),
    operation(
      "matrix-terminal-plural-run-b",
      "matrix-terminal-plural-run-b",
      "run",
      "error",
      "Ran command-f",
    ),
    operation(
      "matrix-terminal-plural-read-a",
      "matrix-terminal-plural-read-a",
      "read",
      "success",
      "Read file-i",
    ),
    operation(
      "matrix-terminal-plural-read-b",
      "matrix-terminal-plural-read-b",
      "read",
      "cancelled",
      "Read file-j",
    ),
    operation(
      "matrix-terminal-plural-change-a",
      "matrix-terminal-plural-change-a",
      "write",
      "success",
      "Wrote file-k",
    ),
    operation(
      "matrix-terminal-plural-change-b",
      "matrix-terminal-plural-change-b",
      "edit",
      "error",
      "Edited file-l",
    ),
  ];
}

const TOOL_ACTIVITY_LOCALE_CASES = [
  {
    locale: "en-US",
    labels: [
      ["Running a command", "Reading a file", "Changing a file"],
      ["Running commands", "Reading files", "Changing files"],
      ["Ran a command", "Read a file", "Changed a file"],
      ["Ran commands", "Read files", "Changed files"],
    ],
  },
  {
    locale: "de-DE",
    labels: [
      ["Befehl wird ausgeführt", "Datei wird gelesen", "Datei wird geändert"],
      [
        "Befehle werden ausgeführt",
        "Dateien werden gelesen",
        "Dateien werden geändert",
      ],
      ["Befehl ausgeführt", "Datei gelesen", "Datei geändert"],
      ["Befehle ausgeführt", "Dateien gelesen", "Dateien geändert"],
    ],
  },
  {
    locale: "es-ES",
    labels: [
      ["Ejecutando un comando", "Leyendo un archivo", "Modificando un archivo"],
      ["Ejecutando comandos", "Leyendo archivos", "Modificando archivos"],
      ["Comando ejecutado", "Archivo leído", "Archivo modificado"],
      ["Comandos ejecutados", "Archivos leídos", "Archivos modificados"],
    ],
  },
  {
    locale: "fr-FR",
    labels: [
      [
        "Exécution d’une commande",
        "Lecture d’un fichier",
        "Modification d’un fichier",
      ],
      [
        "Exécution de commandes",
        "Lecture de fichiers",
        "Modification de fichiers",
      ],
      ["Commande exécutée", "Fichier lu", "Fichier modifié"],
      ["Commandes exécutées", "Fichiers lus", "Fichiers modifiés"],
    ],
  },
  {
    locale: "hi-IN",
    labels: [
      ["एक कमांड चला रहे हैं", "एक फ़ाइल पढ़ रहे हैं", "एक फ़ाइल बदल रहे हैं"],
      ["कमांड चला रहे हैं", "फ़ाइलें पढ़ रहे हैं", "फ़ाइलें बदल रहे हैं"],
      ["एक कमांड चलाया", "एक फ़ाइल पढ़ी", "एक फ़ाइल बदली"],
      ["कमांड चलाए", "फ़ाइलें पढ़ीं", "फ़ाइलें बदलीं"],
    ],
  },
  {
    locale: "id-ID",
    labels: [
      [
        "Sedang menjalankan sebuah perintah",
        "Sedang membaca sebuah file",
        "Sedang mengubah sebuah file",
      ],
      [
        "Sedang menjalankan perintah",
        "Sedang membaca file",
        "Sedang mengubah file",
      ],
      [
        "Sebuah perintah telah dijalankan",
        "Sebuah file telah dibaca",
        "Sebuah file telah diubah",
      ],
      ["Perintah telah dijalankan", "File telah dibaca", "File telah diubah"],
    ],
  },
  {
    locale: "it-IT",
    labels: [
      ["Esecuzione di un comando", "Lettura di un file", "Modifica di un file"],
      ["Esecuzione di comandi", "Lettura di file", "Modifica di file"],
      ["Comando eseguito", "File letto", "File modificato"],
      ["Comandi eseguiti", "File letti", "File modificati"],
    ],
  },
  {
    locale: "ja-JP",
    labels: [
      ["コマンドを実行中", "ファイルを読み取り中", "ファイルを変更中"],
      [
        "複数のコマンドを実行中",
        "複数のファイルを読み取り中",
        "複数のファイルを変更中",
      ],
      ["コマンドを実行", "ファイルを読み取り", "ファイルを変更"],
      [
        "複数のコマンドを実行",
        "複数のファイルを読み取り",
        "複数のファイルを変更",
      ],
    ],
  },
  {
    locale: "ko-KR",
    labels: [
      ["명령 실행 중", "파일 읽는 중", "파일 변경 중"],
      ["여러 명령 실행 중", "여러 파일 읽는 중", "여러 파일 변경 중"],
      ["명령 실행", "파일 읽음", "파일 변경"],
      ["여러 명령 실행", "여러 파일 읽음", "여러 파일 변경"],
    ],
  },
  {
    locale: "pt-BR",
    labels: [
      ["Executando um comando", "Lendo um arquivo", "Alterando um arquivo"],
      ["Executando comandos", "Lendo arquivos", "Alterando arquivos"],
      ["Comando executado", "Arquivo lido", "Arquivo alterado"],
      ["Comandos executados", "Arquivos lidos", "Arquivos alterados"],
    ],
  },
] as const;

describe("chat tool activity", () => {
  it("keeps retained tool rows out of the rendered timeline while the switch is off", async () => {
    const threadId = "f7000000-0000-4000-a000-000000000002";
    mockChatLifecycle(context, {
      threadId,
      activeRunIds: [RUN_ID],
      chatEvents: [
        {
          id: "switch-off-message-a",
          role: "assistant",
          content: "Message before retained activity",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:00:00Z",
        },
        toolEvent({
          id: "switch-off-tool",
          createdAt: "2026-08-25T10:00:01Z",
          toolUseId: "switch-off-tool-use-id",
          action: "read",
          status: "success",
          summary: "Read retained/private-provider-input.txt",
        }),
        {
          id: "switch-off-message-b",
          role: "assistant",
          content: "Message after retained activity",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ChatToolActivity]: false },
    });

    await expect(
      screen.findByText("Message before retained activity"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByText("Message after retained activity"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Expand tool activity")).toBeNull();
    expect(
      screen.queryByText("Read retained/private-provider-input.txt"),
    ).toBeNull();
    expect(document.body).not.toHaveTextContent("switch-off-tool-use-id");
  });

  it.each(TOOL_ACTIVITY_LOCALE_CASES)(
    "renders the lifecycle and operation-number copy matrix in $locale",
    async ({ locale, labels }) => {
      const threadId = crypto.randomUUID();
      context.mocks.data.userPreferences({ locale });
      mockChatLifecycle(context, {
        threadId,
        activeRunIds: [RUN_ID],
        chatEvents: toolActivityCopyMatrixEvents(),
      });

      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.ChatToolActivity]: true },
      });

      await waitFor(() => {
        const buttons = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-chat-tool-activity] > button",
          ),
        );
        expect(buttons).toHaveLength(labels.length);
        for (const [index, expectedLabels] of labels.entries()) {
          const button = buttons[index]!;
          for (const expectedLabel of expectedLabels) {
            expect(button).toHaveTextContent(expectedLabel);
          }
          const text = button.textContent ?? "";
          expect(text.indexOf(expectedLabels[0])).toBeLessThan(
            text.indexOf(expectedLabels[1]),
          );
          expect(text.indexOf(expectedLabels[1])).toBeLessThan(
            text.indexOf(expectedLabels[2]),
          );
        }
        for (const button of buttons.slice(0, 2)) {
          expect(button).toHaveTextContent(/…$/u);
        }
        for (const button of buttons.slice(2)) {
          expect(button).not.toHaveTextContent(/…$/u);
        }
      });
    },
  );

  it("renders message-bound groups for all actions with accessible latest-state rows", async () => {
    const user = userEvent.setup();
    const threadId = "f7000000-0000-4000-a000-000000000003";
    mockChatLifecycle(context, {
      threadId,
      activeRunIds: [RUN_ID],
      chatEvents: [
        {
          id: "tool-plan-message-a",
          role: "assistant",
          content: "Message A",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:01:00Z",
        },
        toolEvent({
          id: "tool-run-pending-anchor",
          createdAt: "2026-08-25T10:01:01Z",
          toolUseId: "opaque-run-tool-use-id",
          action: "run",
          status: "pending",
          summary: "Running secret/provider command input",
        }),
        toolEvent({
          id: "tool-run-success-snapshot",
          createdAt: "2026-08-25T10:01:02Z",
          toolUseId: "opaque-run-tool-use-id",
          action: "run",
          status: "success",
          summary: "Ran git status --short",
        }),
        {
          id: "tool-plan-invisible-metadata",
          role: "assistant",
          eventType: "output.thinking",
          content: null,
          thinking: "",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:01:03Z",
        },
        toolEvent({
          id: "tool-read-pending",
          createdAt: "2026-08-25T10:01:04Z",
          toolUseId: "opaque-read-tool-use-id",
          action: "read",
          status: "pending",
          summary: "Reading src/auth/session.ts",
        }),
        {
          id: "tool-plan-message-b",
          role: "assistant",
          content: "Message B",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:01:05Z",
        },
        toolEvent({
          id: "tool-write-error",
          createdAt: "2026-08-25T10:01:06Z",
          toolUseId: "opaque-write-tool-use-id",
          action: "write",
          status: "error",
          summary: "Wrote generated/report.md",
        }),
        toolEvent({
          id: "tool-edit-cancelled",
          createdAt: "2026-08-25T10:01:07Z",
          toolUseId: "opaque-edit-tool-use-id",
          action: "edit",
          status: "cancelled",
          summary: "Edited src/auth/session.ts",
        }),
        {
          id: "tool-plan-message-final",
          role: "assistant",
          content: "Final message",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:01:08Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ChatToolActivity]: true },
    });

    const expandButtons = await screen.findAllByLabelText(
      "Expand tool activity",
    );
    expect(expandButtons).toHaveLength(2);
    expect(expandButtons[0]).toHaveAttribute("aria-expanded", "false");
    expect(expandButtons[1]).toHaveAttribute("aria-expanded", "false");
    expect(expandButtons[0]).toHaveTextContent("Ran a command");
    expect(expandButtons[0]).toHaveTextContent("Reading a file");
    expect(expandButtons[0]).toHaveTextContent(/…$/u);
    expect(expandButtons[1]).toHaveTextContent("Changed files");
    expect(expandButtons[1]).not.toHaveTextContent(/…$/u);
    for (const button of expandButtons) {
      expect(button).not.toHaveTextContent(
        /Completed|Failed|Cancelled|In progress/u,
      );
    }
    expect(screen.queryByText("Ran git status --short")).toBeNull();
    expect(screen.queryByText("Reading src/auth/session.ts")).toBeNull();

    expectBefore(screen.getByText("Message A"), expandButtons[0]!);
    expectBefore(expandButtons[0]!, screen.getByText("Message B"));
    expectBefore(screen.getByText("Message B"), expandButtons[1]!);
    expectBefore(expandButtons[1]!, screen.getByText("Final message"));

    expandButtons[0]!.focus();
    await user.keyboard("{Enter}");
    const firstCollapse = screen.getByLabelText("Collapse tool activity");
    expect(firstCollapse).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Ran git status --short")).toBeInTheDocument();
    expect(screen.getByText("Reading src/auth/session.ts")).toBeInTheDocument();
    expect(
      screen.queryByText("Running secret/provider command input"),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("In progress");
    expect(screen.getByText("In progress")).toHaveClass("sr-only");
    expect(screen.getByText("Completed")).toHaveClass("sr-only");
    expect(
      document.querySelector(
        '[data-chat-scroll-anchor-event-id="tool-run-pending-anchor"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-chat-scroll-anchor-event-id="tool-run-success-snapshot"]',
      ),
    ).toBeNull();

    expandButtons[1]!.focus();
    await user.keyboard(" ");
    expect(screen.getAllByLabelText("Collapse tool activity")).toHaveLength(2);
    expect(screen.getByText("Wrote generated/report.md")).toBeInTheDocument();
    expect(screen.getByText("Edited src/auth/session.ts")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText("Cancelled")).toBeVisible();

    const activityRows = document.querySelectorAll(
      "[data-chat-tool-activity] li",
    );
    expect(activityRows).toHaveLength(4);
    for (const row of activityRows) {
      expect(row.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }
    expect(document.body).not.toHaveTextContent("opaque-run-tool-use-id");
    expect(document.body).not.toHaveTextContent("opaque-read-tool-use-id");
    expect(document.body).not.toHaveTextContent(
      "secret/provider command input",
    );
  });

  it("keeps Tool Activity collapsed inside expanded completed work", async () => {
    const user = userEvent.setup();
    const threadId = "f7000000-0000-4000-a000-000000000004";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "nested-user",
          role: "user",
          content: "Summarize the implementation",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:02:00Z",
        },
        {
          id: "nested-intermediate-message",
          role: "assistant",
          content: "Checking the implementation.",
          runId: RUN_ID,
          createdAt: "2026-08-25T10:02:01Z",
        },
        toolEvent({
          id: "nested-tool-pending",
          createdAt: "2026-08-25T10:02:02Z",
          toolUseId: "nested-tool-use-id",
          action: "read",
          status: "pending",
          summary: "Reading src/chat/timeline.ts",
        }),
        toolEvent({
          id: "nested-tool-success",
          createdAt: "2026-08-25T10:02:03Z",
          toolUseId: "nested-tool-use-id",
          action: "read",
          status: "success",
          summary: "Read src/chat/timeline.ts",
        }),
        {
          id: "nested-final-message",
          role: "assistant",
          content: "Implementation summarized.",
          runId: RUN_ID,
          runLifecycleEvent: "completed",
          createdAt: "2026-08-25T10:02:04Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ChatToolActivity]: true },
    });

    const expandWork = await screen.findByLabelText("Expand work history");
    expect(expandWork).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Expand tool activity")).toBeNull();
    expect(screen.queryByText("Read src/chat/timeline.ts")).toBeNull();

    await user.click(expandWork);
    const expandTool = await screen.findByLabelText("Expand tool activity");
    expect(expandTool).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Collapse work history")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("Read src/chat/timeline.ts")).toBeNull();

    await user.click(expandTool);
    expect(screen.getByText("Read src/chat/timeline.ts")).toBeInTheDocument();
    expect(screen.getByLabelText("Collapse tool activity")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps one expanded anchor while realtime lifecycle snapshots and retries arrive", async () => {
    const user = userEvent.setup();
    const threadId = "f7000000-0000-4000-a000-000000000005";
    const chatEvents: MockChatEventInput[] = [
      toolEvent({
        id: "stream-tool-pending",
        createdAt: "2026-08-25T10:03:00Z",
        toolUseId: "stream-tool-use-id",
        action: "run",
        status: "pending",
        summary: "Running pnpm lint",
      }),
      {
        id: "stream-message-after-tool",
        role: "assistant",
        content: "Waiting for lint to finish.",
        runId: RUN_ID,
        createdAt: "2026-08-25T10:03:01Z",
      },
    ];
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      activeRunIds: [RUN_ID],
      chatEvents,
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ChatToolActivity]: true },
    });

    const expandTool = await screen.findByLabelText("Expand tool activity");
    expect(expandTool).toHaveTextContent("Running a command…");
    await user.click(expandTool);
    expect(screen.getByText("Running pnpm lint")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("In progress");
    expect(screen.getByText("In progress")).toHaveClass("sr-only");

    chatEvents.push(
      toolEvent({
        id: "stream-tool-success",
        createdAt: "2026-08-25T10:03:02Z",
        toolUseId: "stream-tool-use-id",
        action: "run",
        status: "success",
        summary: "Ran pnpm lint",
      }),
    );
    lifecycle.setRunOutput("unused");

    await waitFor(() => {
      expect(screen.getByText("Ran pnpm lint")).toBeInTheDocument();
      expect(screen.queryByText("Running pnpm lint")).toBeNull();
      expect(screen.getByLabelText("Collapse tool activity")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByLabelText("Collapse tool activity")).toHaveTextContent(
        "Ran a command",
      );
    });
    expect(screen.getAllByLabelText("Collapse tool activity")).toHaveLength(1);

    chatEvents.push(
      toolEvent({
        id: "stream-tool-success-retry",
        createdAt: "2026-08-25T10:03:03Z",
        toolUseId: "stream-tool-use-id",
        action: "run",
        status: "success",
        summary: "Ran pnpm lint",
      }),
    );
    lifecycle.setRunOutput("unused again");

    await waitFor(() => {
      expect(screen.getAllByText("Ran pnpm lint")).toHaveLength(1);
      expect(screen.getAllByLabelText("Collapse tool activity")).toHaveLength(
        1,
      );
    });
    const activity = screen
      .getByLabelText("Collapse tool activity")
      .closest("[data-chat-tool-activity]");
    expect(activity).not.toBeNull();
    expect(
      within(activity as HTMLElement).getAllByRole("listitem"),
    ).toHaveLength(1);
  });
});
