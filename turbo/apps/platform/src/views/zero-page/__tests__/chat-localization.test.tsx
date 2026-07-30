import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { setLocale$ } from "../../../signals/locale.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  findComposerEditor,
  mockAgent,
  mockOrgModelRoutes,
  mockThread,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const localeCases = [
  {
    locale: "en-US",
    placeholder: "Ask me to automate workflows, manage tasks...",
    attach: "Attach",
    send: "Send",
  },
  {
    locale: "pt-BR",
    placeholder:
      "Peça para automatizar fluxos de trabalho, gerenciar tarefas...",
    attach: "Anexar",
    send: "Enviar",
  },
  {
    locale: "ko-KR",
    placeholder: "워크플로 자동화, 작업 관리 등을 요청하세요...",
    attach: "첨부",
    send: "전송",
  },
] as const;

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
});

describe("chat localization", () => {
  it.each(localeCases)(
    "renders and sends a representative chat lifecycle in $locale",
    async ({ locale, placeholder, attach, send }) => {
      const user = userEvent.setup({ delay: null });
      const sentPrompts: string[] = [];
      const authoredMessage = `Keep this authored message in ${locale}`;
      context.mocks.data.userPreferences({ locale });
      mockOrgModelRoutes("kimi-k2.7-code");
      mockAgent();
      mockChatLifecycle(context, {
        onRunCreate: (body) => {
          if (body.prompt) {
            sentPrompts.push(body.prompt);
          }
        },
      });

      detachedSetupPage({
        context,
        featureSwitches: {
          [FeatureSwitchKey.LanguagePreference]: true,
        },
        path: `/agents/${AGENT_ID}/chat`,
      });

      await expect(screen.findByText(placeholder)).resolves.toBeInTheDocument();
      expect(screen.getByLabelText(attach)).toBeInTheDocument();
      expect(screen.getByLabelText(send)).toBeDisabled();

      const editor = await findComposerEditor();
      await user.click(editor);
      await user.keyboard(authoredMessage);
      await waitFor(() => {
        expect(screen.getByLabelText(send)).toBeEnabled();
      });
      await user.click(screen.getByLabelText(send));

      await waitFor(() => {
        expect(sentPrompts).toContain(authoredMessage);
      });
      await expect(
        screen.findByText(authoredMessage),
      ).resolves.toBeInTheDocument();
      expect(document.documentElement.lang).toBe(locale);
    },
  );

  it("switches locale without replacing the open thread or its draft", async () => {
    const user = userEvent.setup({ delay: null });
    const authoredDraft = "Keep this draft while the language changes";
    context.mocks.data.userPreferences({ locale: "en-US" });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    await expect(
      screen.findByText("Ask me to automate workflows, manage tasks..."),
    ).resolves.toBeInTheDocument();
    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard(authoredDraft);
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeEnabled();
    });
    const pathBeforeSwitch = pathname();

    await act(async () => {
      await context.store.set(setLocale$, "pt-BR", context.signal);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Anexar")).toBeInTheDocument();
      expect(screen.getByLabelText("Enviar")).toBeEnabled();
    });
    await expect(findComposerEditor()).resolves.toBe(editor);
    expect(editor).toHaveAccessibleName("Mensagem");
    expect(editor).toHaveTextContent(authoredDraft);
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "My thread",
    );
    expect(pathname()).toBe(pathBeforeSwitch);
    expect(document.documentElement.lang).toBe("pt-BR");
  });

  it("keeps cancellation state semantic while its presentation follows the locale", async () => {
    const user = userEvent.setup({ delay: null });
    const runId = "run-localized-cancellation";
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: [runId],
      chatEvents: [
        {
          id: "msg-localized-cancellation-user",
          role: "user",
          content: "Interrompa esta execução",
          runId,
          createdAt: "2026-07-30T00:00:00Z",
        },
        {
          id: "msg-localized-cancellation-assistant",
          role: "assistant",
          content: null,
          runId,
          createdAt: "2026-07-30T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    await user.click(await screen.findByLabelText("Parar"));

    await expect(
      screen.findByText(
        "Pausado no meio do raciocínio — retome quando quiser.",
      ),
    ).resolves.toBeInTheDocument();

    await act(async () => {
      await context.store.set(setLocale$, "en-US", context.signal);
    });

    await expect(
      screen.findByText("Paused mid-thought — pick it back up whenever."),
    ).resolves.toBeInTheDocument();
  });
});
