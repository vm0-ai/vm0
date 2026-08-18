import { useGet, useSet, useLoadable, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { user$ } from "../../signals/auth.ts";
import { Pin, UserPlus } from "lucide-react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import {
  currentChatAgentId$,
  currentChatAgentDisplayName$,
} from "../../signals/agent-chat.ts";
import {
  setAgentPinned$,
  currentChatAgentPinned$,
} from "../../signals/zero-page/zero-pinned-agents.ts";

import { detach, Reason } from "../../signals/utils.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { openSettingsDialogAt$ } from "../../signals/zero-page/settings/settings-dialog.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { StartCards } from "./zero-start-cards.tsx";
import { AttachmentLightbox } from "./zero-attachment-chips.tsx";
import { chatPageTaglineIndex$ } from "../../signals/zero-page/zero-chat-page.ts";
import { agentChatComposerSignals$ } from "../../signals/zero-page/agent-composer-signals.ts";
import { subscribeComputerUseHostsChangedRef$ } from "../../signals/zero-page/computer-use-hosts.ts";
import { lightboxUrl$ as attachmentLightboxUrl$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { assistantName$ } from "../../signals/branding.ts";
import {
  typewriterDisplayed$,
  typewriterRef$,
} from "../../signals/view-component-state.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";

function localizedAnonymousTaglines(t: TFunction<"common">): string[] {
  return [
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.welcomeBack;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.whatsTheMove;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.goodToSeeYou;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.whatsOnYourMind;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.readyToRoll;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.buildSomething;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.whatAreWeWorkingOn;
    }),
  ];
}

function localizedUserTaglines(
  t: TFunction<"common">,
  agentName: string,
  userName: string,
): string[] {
  return [
    t(
      ($) => {
        return $.chat.agentPage.taglines.welcomeBack;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatsTheMove;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.goodToSeeYou;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatsOnYourMind;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.letsRoll;
      },
      {
        agentName,
        userName,
      },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.anotherWin;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.readyToBuild;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.enteredChat;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.goodToSeeYou;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.savedYourSeat;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.makeTodayCount;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.coffeeReady;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.knewYouWouldCome;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatsCooking;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.newIdeas;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.rightOnTime;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatAreWeWorkingOn;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.theUsual;
      },
      { userName },
    ),
  ];
}

function useTagline(
  agentName: string | null | undefined,
  userName: string | null,
  index: number,
): string {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  if (agentName === undefined) {
    return "";
  }
  const taglines = userName
    ? localizedUserTaglines(t, agentName ?? assistantName, userName)
    : localizedAnonymousTaglines(t);
  return taglines[index % taglines.length];
}

function TypewriterText({
  text,
  speed = 40,
}: {
  text: string;
  speed?: number;
}) {
  const displayed = useGet(typewriterDisplayed$);
  const typewriterRef = useSet(typewriterRef$);
  const typewriterKey = `${text}:${String(speed)}`;
  const displayedText = displayed[typewriterKey] ?? "";

  return (
    <>
      <span
        key={typewriterKey}
        ref={typewriterRef}
        className="contents"
        data-typewriter-speed={String(speed)}
        data-typewriter-key={typewriterKey}
        data-typewriter-text={text}
      >
        {displayedText}
      </span>
      {displayedText.length < text.length && (
        <span className="inline-block w-[2px] h-[1em] bg-foreground/60 ml-0.5 align-middle animate-pulse" />
      )}
    </>
  );
}

function InviteButton() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const openSettings = useSet(openSettingsDialogAt$);
  const handleInvite = () => {
    detach(openSettings("people", pageSignal), Reason.DomCallback);
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleInvite}
      className={`zero-btn-morandi gap-1.5${isAdmin ? "" : " invisible"}`}
      aria-hidden={isAdmin ? undefined : "true"}
      tabIndex={isAdmin ? undefined : -1}
      data-testid="invite-button"
    >
      <UserPlus size={14} />
      {t(($) => {
        return $.chat.agentPage.invitePeople;
      })}
    </Button>
  );
}

function PinPill() {
  const { t } = useTranslation("agents");
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const pinnedStatus = useLastResolved(currentChatAgentPinned$);
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setAgentPinned$);
  const pinSaving = pinLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  if (pinnedStatus !== false || !currentChatAgentId) {
    return null;
  }
  const handlePin = () => {
    detach(
      saveAgentPinned(
        { agentId: currentChatAgentId, pinned: true },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={handlePin}
            disabled={pinSaving}
            variant="quiet"
            size="icon-2xs"
            className="absolute -top-0.5 -right-0.5 rounded-full zero-border bg-background shadow-sm hover:shadow-md disabled:opacity-50"
            aria-label={t(($) => {
              return $.sidebar.pin;
            })}
          >
            <Pin size={12} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">
            {t(($) => {
              return $.sidebar.pin;
            })}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ChatAgentAvatar({ agentId }: { agentId: string | null | undefined }) {
  const { t } = useTranslation("agents");

  return (
    <div className="relative shrink-0">
      {agentId ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/agents/:agentId"
                options={{
                  pathParams: { agentId },
                }}
                aria-label={t(($) => {
                  return $.detail.viewProfile;
                })}
                className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-state-hover cursor-pointer"
              >
                <AgentAvatarImg
                  name={agentId}
                  alt=""
                  className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
                />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                {t(($) => {
                  return $.detail.viewProfile;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl">
          <AgentAvatarImg
            name=""
            alt=""
            className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
          />
        </div>
      )}
      <PinPill />
    </div>
  );
}

export function AgentChatPage() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const currentChatAgentDisplayName = useLastResolved(
    currentChatAgentDisplayName$,
  );

  const pageSignal = useGet(pageSignal$);
  const subscribeComputerUseHostsChangedRef = useSet(
    subscribeComputerUseHostsChangedRef$,
  );
  const userFirstName = useLastResolved(user$)?.firstName ?? null;

  const composerSignals = useGet(agentChatComposerSignals$);
  const setInput = useSet(composerSignals.draft.setDraftInput$);
  const saveDraft = useSet(composerSignals.draft.save$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline = useTagline(
    currentChatAgentDisplayName,
    userFirstName,
    taglineIndex,
  );

  const lightboxUrl = useGet(attachmentLightboxUrl$);

  const handleInputChange = (value: string) => {
    setInput(value);
    detach(saveDraft(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <span ref={subscribeComputerUseHostsChangedRef} hidden />
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-2">
        <div className="flex justify-end items-center gap-2">
          <InviteButton />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-6 pt-8 pb-12 sm:pt-[20vh] sm:pb-[10vh]">
          <div className="flex items-center gap-4 w-full">
            <ChatAgentAvatar agentId={currentChatAgentId} />
            <div className="flex-1 min-w-0 flex items-center gap-3">
              <h2
                aria-label={tagline}
                data-testid="chat-tagline"
                className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground"
              >
                <TypewriterText text={tagline} />
              </h2>
            </div>
          </div>

          <ZeroChatComposer signals={composerSignals} />

          <StartCards onSelectPrompt={handleInputChange} />
        </div>
      </main>
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
      {lightboxUrl && <AttachmentLightbox />}
    </div>
  );
}
