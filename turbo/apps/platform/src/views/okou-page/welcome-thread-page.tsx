import { useGet, useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { assistantName$ } from "../../signals/branding.ts";
import { agentChatComposerSignals$ } from "../../signals/okou-page/agent-composer-signals.ts";
import type { WelcomeThreadContentSignals } from "../../signals/okou-page/welcome-thread-content.ts";
import { MarkdownEventBody } from "../components/markdown.tsx";
import { Link } from "../router/link.tsx";
import { ChatAssistantMessageBody } from "./chat-message-surface.tsx";
import { ChatComposer } from "./chat-composer.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";
import { AgentAvatarImg } from "./sidebar-shared.tsx";

function WelcomeThreadAvatar() {
  const { t } = useTranslation();
  const agentId = useLastResolved(currentChatAgentId$) ?? null;
  const avatar = (
    <AgentAvatarImg
      name={agentId ?? ""}
      alt=""
      className="h-7 w-7 rounded-full object-cover object-top @[900px]:h-9 @[900px]:w-9"
    />
  );

  return agentId ? (
    <Link
      pathname="/agents/:agentId"
      options={{ pathParams: { agentId } }}
      className="h-7 w-7 shrink-0 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-state-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 @[900px]:mt-0.5 @[900px]:h-9 @[900px]:w-9"
      aria-label={t(($) => {
        return $.chat.agentPage.viewAgentProfile;
      })}
    >
      {avatar}
    </Link>
  ) : (
    <span className="h-7 w-7 shrink-0 @[900px]:mt-0.5 @[900px]:h-9 @[900px]:w-9">
      {avatar}
    </span>
  );
}

function WelcomeThreadMessage({
  content,
}: {
  readonly content: WelcomeThreadContentSignals;
}) {
  const tree = useGet(content.tree$);

  return (
    <div data-role="assistant" className="flex flex-col gap-1">
      <div className="flex flex-col gap-2 @[900px]:-ml-[46px] @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:items-start @[900px]:gap-2.5">
        <WelcomeThreadAvatar />
        <div className="relative flex flex-col gap-2">
          <ChatAssistantMessageBody
            data-testid="welcome-thread-content"
            className="pt-2.5"
          >
            <MarkdownEventBody tree={tree} mediaPreview />
          </ChatAssistantMessageBody>
        </div>
      </div>
    </div>
  );
}

function WelcomeThreadComposer() {
  const composerSignals = useGet(agentChatComposerSignals$);

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 bg-[hsl(var(--background))] pb-[max(0.5rem-var(--sab),0px)]"
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-[21px] bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div className="overflow-y-auto pb-2 pl-4 pr-4 pt-3 [scrollbar-gutter:stable] sm:pl-6 sm:pr-6">
        <div className="mx-auto max-w-[900px]">
          <ChatComposer signals={composerSignals} />
        </div>
      </div>
    </footer>
  );
}

export function WelcomeThreadPage({
  content,
}: {
  readonly content: WelcomeThreadContentSignals;
}) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const title = t(
    ($) => {
      return $.chat.welcomeThread.title;
    },
    { assistantName },
  );

  return (
    <section
      aria-label={t(($) => {
        return $.chat.thread.ariaLabel;
      })}
      className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col bg-transparent focus:outline-none"
      data-chat-thread-container-id="welcome"
      data-testid="welcome-thread-page"
    >
      <header className="hidden h-14 shrink-0 items-center justify-between bg-transparent px-6 sm:flex">
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          data-testid="chat-thread-header-title"
        >
          {title}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <div className="flex h-full min-w-0 flex-col">
          <div className="relative min-h-0 flex-1 isolate">
            <div
              data-scroll-container
              tabIndex={-1}
              className="absolute inset-0 overflow-y-auto focus:outline-none [overflow-anchor:none] [scrollbar-gutter:stable]"
            >
              <main className="items-center px-4 py-4 @container sm:px-6">
                <div
                  data-message-container
                  className="mx-auto flex w-full max-w-[900px] flex-col gap-6 overflow-visible pb-4"
                >
                  <WelcomeThreadMessage content={content} />
                </div>
              </main>
            </div>
          </div>
          <WelcomeThreadComposer />
        </div>
      </div>

      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </section>
  );
}
