import type {
  SharedMessage,
  SharedThreadResponse,
} from "@okouai/api-contracts/contracts/shared-threads";
import { Button, Card } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { Root } from "hast";
import { ArrowRight, MessageCircle, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  appUrlForPublicBrand,
  publicBrandPresentation,
} from "@okouai/core/public-brand";

import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";
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
    <div data-role="user">
      <div className="flex min-w-0 flex-col items-end @[900px]:-ml-[46px] @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:items-start @[900px]:gap-2.5">
        <div className="hidden @[900px]:block @[900px]:h-9 @[900px]:w-9 @[900px]:shrink-0" />
        <div className="flex w-full flex-col items-end gap-2">
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
      </div>
    </div>
  );
}

function SharedBrandMark({
  size = "md",
}: {
  readonly size?: "sm" | "md" | "avatar";
}) {
  return (
    <span
      className={
        size === "sm"
          ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#ed4e01] text-white"
          : size === "avatar"
            ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[#ed4e01] text-white @[900px]:mt-0.5 @[900px]:h-9 @[900px]:w-9"
            : "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#ed4e01] text-white"
      }
      aria-hidden="true"
    >
      <MessageCircle size={size === "md" ? 19 : 17} />
    </span>
  );
}

function SharedAssistantGroup({
  group,
  assistantName,
}: {
  readonly group: SharedMessageGroup;
  readonly assistantName: string;
}) {
  return (
    <div data-role="assistant">
      <div className="flex min-w-0 flex-col gap-2 @[900px]:-ml-[46px] @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:items-start @[900px]:gap-2.5">
        <SharedBrandMark size="avatar" />
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="text-[#ed4e01]" aria-hidden="true">
              ✦
            </span>
            {assistantName}
          </div>
          <div className="zero-chat-bubble-assistant flex min-w-0 flex-col gap-3 text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere]">
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
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,var(--sab))] sm:px-6">
      <Card className="pointer-events-auto mx-auto w-full max-w-[1040px] overflow-visible rounded-[var(--zero-composer-radius)] border-border/80 bg-background/95 shadow-[var(--zero-card-shadow)] backdrop-blur">
        <div className="flex items-center gap-3 p-3 sm:gap-4 sm:px-4">
          <SharedBrandMark />
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

          <div className="hidden h-12 min-w-[230px] items-center justify-center gap-3 rounded-xl bg-muted/70 px-4 lg:flex">
            <span className="flex flex-col gap-1.5" aria-hidden="true">
              <span className="h-2.5 w-7 rounded-full bg-muted-foreground/15" />
              <span className="h-2.5 w-9 rounded-full border border-muted-foreground/20 bg-background" />
            </span>
            <ArrowRight
              className="text-[#ed4e01]"
              size={14}
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-muted-foreground">
              {t(($) => {
                return $.sharedThread.yourWorkspace;
              })}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <Button variant="quiet" size="sm" asChild>
              <a href={signInUrl}>
                {t(($) => {
                  return $.sharedThread.signIn;
                })}
              </a>
            </Button>
            <Button
              size="sm"
              className="bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80"
              asChild
            >
              <a href={handoffUrl}>
                {t(($) => {
                  return $.sharedThread.tryItYourself;
                })}
              </a>
            </Button>
          </div>
        </div>
      </Card>
    </div>
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
    <header className="sticky top-0 z-20 border-b border-border/70 bg-background/95 backdrop-blur">
      <div className="mx-auto grid h-14 w-full max-w-[1200px] grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <a
          href={homeUrl}
          aria-label={brandName}
          className="inline-flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <SharedBrandMark size="sm" />
          <span className="hidden sm:inline">{brandName}</span>
        </a>
        {title !== null ? (
          <h1 className="min-w-0 truncate text-center text-sm font-semibold text-foreground">
            {title}
          </h1>
        ) : (
          <div />
        )}
        <div className="flex items-center justify-end gap-1 sm:gap-2">
          {shareUrl !== null ? (
            <Button
              showTooltip
              type="button"
              variant="quiet"
              size="icon-sm"
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
              <Share2 size={16} />
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
          <Button
            size="sm"
            className="bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80"
            asChild
          >
            <a href={signUpUrl}>
              {t(($) => {
                return $.sharedThread.signUp;
              })}
            </a>
          </Button>
        </div>
      </div>
    </header>
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
    <main
      className="zero-app flex h-full flex-col overflow-y-auto bg-background text-foreground"
      data-testid="shared-thread-scroll"
    >
      <SharedThreadHeader
        brandName={presentation.brandName}
        homeUrl={homeUrl}
        shareUrl={shareUrl}
        signInUrl={signInUrl.toString()}
        signUpUrl={signUpUrl.toString()}
        title={sharedThread?.title ?? null}
      />

      {sharedThread ? (
        <section className="@container mx-auto w-full max-w-[948px] px-4 pb-40 pt-6 sm:px-6 sm:pb-36 sm:pt-8">
          <div className="mx-auto flex w-full max-w-[900px] flex-col gap-6">
            {groups.map((group) => {
              return group.role === "user" ? (
                <SharedUserGroup key={group.key} group={group} />
              ) : (
                <SharedAssistantGroup
                  key={group.key}
                  group={group}
                  assistantName={presentation.assistantName}
                />
              );
            })}
          </div>
        </section>
      ) : (
        <SharedThreadNotFound />
      )}
      {sharedThread ? (
        <SharedThreadHandoff
          assistantName={presentation.assistantName}
          handoffUrl={handoffUrl.toString()}
          signInUrl={signInUrl.toString()}
        />
      ) : null}
    </main>
  );
}
