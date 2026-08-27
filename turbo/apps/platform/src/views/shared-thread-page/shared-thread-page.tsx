import type {
  SharedMessage,
  SharedThreadResponse,
} from "@okouai/api-contracts/contracts/shared-threads";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import { Button, Card, CardContent, cn } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { Root } from "hast";
import { Copy, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  appUrlForPublicBrand,
  publicBrandPresentation,
} from "@okouai/core/public-brand";

import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import { MarkdownEventBody } from "../components/markdown.tsx";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import {
  ChatAssistantMessageBody,
  ChatUserMessageBubble,
  CHAT_THREAD_ASSISTANT_AVATAR_FRAME_CLASS,
  CHAT_THREAD_ASSISTANT_AVATAR_IMAGE_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS,
  CHAT_THREAD_CONTENT_MAIN_CLASS,
  CHAT_THREAD_MESSAGE_LIST_CLASS,
  CHAT_THREAD_MESSAGE_STACK_PULL_CLASS,
  CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS,
  CHAT_THREAD_USER_MESSAGE_ROW_CLASS,
} from "../okou-page/chat-message-surface.tsx";
import { AvatarFromUrl } from "../okou-page/sidebar-shared.tsx";

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

function SharedAssistantAvatar({
  assistantName,
}: {
  readonly assistantName: string;
}) {
  return (
    <div
      data-shared-assistant-avatar=""
      className={CHAT_THREAD_ASSISTANT_AVATAR_FRAME_CLASS}
    >
      <AvatarFromUrl
        avatarUrl={DEFAULT_AGENT_AVATAR_URL}
        alt={assistantName}
        className={CHAT_THREAD_ASSISTANT_AVATAR_IMAGE_CLASS}
      />
    </div>
  );
}

function SharedMessageCopyButton({ content }: { readonly content: string }) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.chat.actions.copyMessage;
  });

  return (
    <IconTooltipButton
      type="button"
      data-shared-message-copy=""
      className="rounded-md p-1 text-muted-foreground/60 transition-colors duration-150 hover:bg-state-hover hover:text-foreground"
      aria-label={label}
      onClick={() => {
        detach(
          (async () => {
            const didCopy = await writeToClipboard(content);
            if (didCopy) {
              toast.success(
                t(($) => {
                  return $.chat.actions.copied;
                }),
              );
              return;
            }
            toast.error(
              t(($) => {
                return $.chat.sharing.copyFailed;
              }),
            );
          })(),
          Reason.DomCallback,
          "copy shared message",
        );
      }}
    >
      <Copy size={18} />
    </IconTooltipButton>
  );
}

function SharedUserGroup({ group }: { readonly group: SharedMessageGroup }) {
  return (
    <>
      {group.messages.map((message, index) => {
        return (
          <div
            key={message.messageIndex}
            data-role="user"
            className={cn(
              "group",
              index > 0 && CHAT_THREAD_MESSAGE_STACK_PULL_CLASS,
            )}
          >
            <div className={CHAT_THREAD_USER_MESSAGE_ROW_CLASS}>
              <div className="hidden @[900px]:block @[900px]:h-9 @[900px]:w-9 @[900px]:shrink-0" />
              <div className="flex w-full flex-col items-end">
                <ChatUserMessageBubble>
                  <div className="whitespace-pre-wrap px-4 py-3">
                    {message.content}
                  </div>
                </ChatUserMessageBubble>
                <div
                  data-shared-message-actions="user"
                  className={CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS}
                >
                  <SharedMessageCopyButton content={message.content} />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function SharedAssistantGroup({
  assistantName,
  group,
}: {
  readonly assistantName: string;
  readonly group: SharedMessageGroup;
}) {
  const content = group.messages
    .map((message) => {
      return message.content;
    })
    .join("\n\n");
  return (
    <div
      data-role="assistant"
      className={CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS}
    >
      <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS}>
        <SharedAssistantAvatar assistantName={assistantName} />
        <div className="relative flex min-w-0 flex-col gap-2">
          {group.messages.map((message, index) => {
            return message.tree === undefined ? null : (
              <ChatAssistantMessageBody
                key={message.messageIndex}
                compactTop={index > 0}
              >
                <MarkdownEventBody tree={message.tree} mediaPreview />
              </ChatAssistantMessageBody>
            );
          })}
        </div>
      </div>
      <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS}>
        <div className="hidden @[900px]:block" />
        <div
          data-shared-message-actions="assistant"
          className={CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS}
        >
          <div className="flex items-center gap-1">
            <SharedMessageCopyButton content={content} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SharedThreadHandoff({
  assistantName,
  handoffUrl,
  signInUrl,
}: {
  readonly assistantName: string;
  readonly handoffUrl: string;
  readonly signInUrl: string;
}) {
  const { t } = useTranslation();
  return (
    <footer
      data-shared-thread-handoff=""
      className="relative shrink-0 bg-[hsl(var(--background))]"
      style={{
        paddingBottom: "max(0.5rem - var(--sab), 0px)",
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-[21px] bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div className="pb-2 pl-4 pr-4 pt-3 sm:pl-6 sm:pr-6">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-composer relative z-10 overflow-visible">
            <CardContent className="p-0">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {t(($) => {
                      return $.sharedThread.makeConversationYours;
                    })}
                  </p>
                  <p className="hidden truncate text-xs text-muted-foreground sm:block">
                    {t(
                      ($) => {
                        return $.sharedThread.handoffDescription;
                      },
                      { assistantName },
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                  <Button variant="quiet" size="sm" asChild>
                    <a href={signInUrl}>
                      {t(($) => {
                        return $.sharedThread.signIn;
                      })}
                    </a>
                  </Button>
                  <Button size="sm" asChild>
                    <a href={handoffUrl}>
                      {t(($) => {
                        return $.sharedThread.tryItYourself;
                      })}
                    </a>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </footer>
  );
}

function SharedThreadHeader({
  brandName,
  homeUrl,
  shareUrl,
  signInUrl,
  signUpUrl,
  title,
}: {
  readonly brandName: string;
  readonly homeUrl: string;
  readonly shareUrl: string | null;
  readonly signInUrl: string;
  readonly signUpUrl: string;
  readonly title: string | null;
}) {
  const { t } = useTranslation();
  return (
    <header className="relative z-10 flex min-h-12 shrink-0 items-center gap-3 border-b border-border/50 bg-background px-3 sm:h-14 sm:border-b-0 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <a
          href={homeUrl}
          aria-label={brandName}
          className="shrink-0 text-foreground transition-opacity hover:opacity-70"
        >
          <ProductBrandMark size="small" />
        </a>
        {title !== null ? (
          <h1 className="min-w-0 truncate text-sm font-medium text-foreground">
            {title}
          </h1>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {shareUrl !== null ? (
          <Button
            showTooltip
            type="button"
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className="shrink-0 duration-150"
            aria-label={t(($) => {
              return $.sharedThread.share;
            })}
            onClick={() => {
              detach(
                (async () => {
                  const copied = await writeToClipboard(shareUrl);
                  if (copied) {
                    toast.success(
                      t(($) => {
                        return $.chat.sharing.linkCopied;
                      }),
                    );
                    return;
                  }
                  toast.error(
                    t(($) => {
                      return $.chat.sharing.copyFailed;
                    }),
                  );
                })(),
                Reason.DomCallback,
                "copy shared thread link",
              );
            }}
          >
            <Share2 size={18} />
          </Button>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          className="hidden sm:inline-flex"
          asChild
        >
          <a href={signInUrl}>
            {t(($) => {
              return $.sharedThread.signIn;
            })}
          </a>
        </Button>
        <Button size="sm" asChild>
          <a href={signUpUrl}>
            {t(($) => {
              return $.sharedThread.signUp;
            })}
          </a>
        </Button>
      </div>
    </header>
  );
}

function SharedThreadTranscript({
  assistantName,
  groups,
}: {
  readonly assistantName: string;
  readonly groups: readonly SharedMessageGroup[];
}) {
  return (
    <div className="relative min-h-0 flex-1 isolate">
      <div
        data-testid="shared-thread-scroll"
        tabIndex={-1}
        className="absolute inset-0 overflow-y-auto focus:outline-none [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
          <div
            data-message-container=""
            className={CHAT_THREAD_MESSAGE_LIST_CLASS}
          >
            {groups.map((group) => {
              return group.role === "user" ? (
                <SharedUserGroup key={group.key} group={group} />
              ) : (
                <SharedAssistantGroup
                  key={group.key}
                  assistantName={assistantName}
                  group={group}
                />
              );
            })}
          </div>
        </main>
      </div>
    </div>
  );
}

function SharedThreadNotFound() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-16 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        {t(($) => {
          return $.sharedThread.notFoundTitle;
        })}
      </h1>
    </main>
  );
}

export function SharedThreadPage({
  sharedThread,
}: {
  readonly sharedThread: SharedDisplayThread | null;
}) {
  const { t } = useTranslation();
  const groups = sharedThread ? groupSharedMessages(sharedThread.messages) : [];
  const publicBrand = sharedThread?.publicBrand ?? "vm0";
  const presentation = publicBrandPresentation(publicBrand);
  const homeUrl = appUrlForPublicBrand(window.location.origin, publicBrand);
  const shareUrl = sharedThread
    ? `${window.location.origin}/share/threads/${encodeURIComponent(sharedThread.id)}`
    : null;
  const handoffUrl = new URL(homeUrl);
  if (shareUrl) {
    handoffUrl.searchParams.set(
      "prompt",
      t(
        ($) => {
          return $.sharedThread.handoffPrompt;
        },
        { url: shareUrl },
      ),
    );
  }
  const signInUrl = new URL("/sign-in", `${homeUrl}/`);
  signInUrl.searchParams.set("redirect_url", handoffUrl.toString());
  const signUpUrl = new URL("/sign-up", `${homeUrl}/`);
  signUpUrl.searchParams.set("redirect_url", handoffUrl.toString());

  return (
    <div className="zero-app zero-workspace-bg flex h-full min-h-0 flex-col text-foreground">
      <SharedThreadHeader
        brandName={presentation.brandName}
        homeUrl={homeUrl}
        shareUrl={shareUrl}
        signInUrl={signInUrl.toString()}
        signUpUrl={signUpUrl.toString()}
        title={sharedThread?.title ?? null}
      />
      {sharedThread ? (
        <>
          <SharedThreadTranscript
            assistantName={presentation.assistantName}
            groups={groups}
          />
          <SharedThreadHandoff
            assistantName={presentation.assistantName}
            handoffUrl={handoffUrl.toString()}
            signInUrl={signInUrl.toString()}
          />
        </>
      ) : (
        <SharedThreadNotFound />
      )}
    </div>
  );
}
