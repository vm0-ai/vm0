import type {
  SharedMessage,
  SharedThreadResponse,
} from "@okouai/api-contracts/contracts/shared-threads";
import type { Root } from "hast";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MarkdownEventBody } from "../components/markdown.tsx";

/**
 * A shared message with the tree its body parsed into. The page setup command
 * parses assistant bodies and embeds their diagram signals before rendering.
 */
export type SharedDisplayMessage = SharedMessage & { readonly tree?: Root };

export type SharedDisplayThread = Omit<SharedThreadResponse, "messages"> & {
  readonly messages: readonly SharedDisplayMessage[];
};

interface SharedMessageGroup {
  readonly key: number;
  readonly role: SharedMessage["role"];
  readonly messages: readonly SharedDisplayMessage[];
}

function shouldMergeSharedMessage(
  group: SharedMessageGroup,
  message: SharedDisplayMessage,
): boolean {
  if (group.role !== message.role) {
    return false;
  }
  if (group.role === "user") {
    return true;
  }
  const groupRunIndex = group.messages.find((candidate) => {
    return candidate.runIndex !== undefined;
  })?.runIndex;
  if (groupRunIndex === undefined || message.runIndex === undefined) {
    return true;
  }
  return groupRunIndex === message.runIndex;
}

function groupSharedMessages(
  messages: readonly SharedDisplayMessage[],
): readonly SharedMessageGroup[] {
  const groups: SharedMessageGroup[] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (previous && shouldMergeSharedMessage(previous, message)) {
      groups[groups.length - 1] = {
        ...previous,
        messages: [...previous.messages, message],
      };
      continue;
    }
    groups.push({
      key: message.messageIndex,
      role: message.role,
      messages: [message],
    });
  }
  return groups;
}

function SharedUserGroup({ group }: { readonly group: SharedMessageGroup }) {
  return (
    <div className="flex flex-col items-end gap-2" data-role="user">
      {group.messages.map((message) => {
        return (
          <div
            key={message.messageIndex}
            className="zero-chat-bubble-user max-w-[85%] whitespace-pre-wrap rounded-xl px-4 py-3 text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere]"
          >
            {message.content}
          </div>
        );
      })}
    </div>
  );
}

function SharedAssistantGroup({
  group,
}: {
  readonly group: SharedMessageGroup;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-3 text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere]"
      data-role="assistant"
    >
      {group.messages.map((message) => {
        return message.tree === undefined ? null : (
          <MarkdownEventBody
            key={message.messageIndex}
            tree={message.tree}
            mediaPreview
          />
        );
      })}
    </div>
  );
}

function SharedThreadNotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16 text-center">
      <div>
        <p className="text-sm font-semibold text-primary">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">
          {t(($) => {
            return $.sharedThread.notFoundTitle;
          })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.sharedThread.notFoundDescription;
          })}
        </p>
      </div>
    </div>
  );
}

export function SharedThreadPage({
  sharedThread,
}: {
  readonly sharedThread: SharedDisplayThread | null;
}) {
  const { t } = useTranslation();
  const groups = sharedThread ? groupSharedMessages(sharedThread.messages) : [];
  return (
    <main
      className="flex h-full flex-col overflow-y-auto bg-background text-foreground"
      data-testid="shared-thread-scroll"
    >
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[948px] items-center justify-between px-4 sm:px-6">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#ed4e01] text-white">
              <MessageCircle size={17} />
            </span>
            {t(($) => {
              return $.sharedThread.brand;
            })}
          </a>
          <a
            href="/"
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            {t(($) => {
              return $.sharedThread.tryOkou;
            })}
          </a>
        </div>
      </header>

      {sharedThread ? (
        <section className="mx-auto w-full max-w-[948px] px-4 py-8 sm:px-6 sm:py-10">
          <h1 className="mb-8 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {sharedThread.title}
          </h1>
          <div className="mx-auto flex w-full max-w-[900px] flex-col gap-6">
            {groups.map((group) => {
              return group.role === "user" ? (
                <SharedUserGroup key={group.key} group={group} />
              ) : (
                <SharedAssistantGroup key={group.key} group={group} />
              );
            })}
          </div>
        </section>
      ) : (
        <SharedThreadNotFound />
      )}
    </main>
  );
}
