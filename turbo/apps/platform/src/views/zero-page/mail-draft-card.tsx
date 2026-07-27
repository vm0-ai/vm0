import {
  IconChevronRight,
  IconCircleCheck,
  IconLoader2,
  IconRoute,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type {
  ZeroMailDraft,
  ZeroMailDraftStatus,
} from "@vm0/api-contracts/contracts/zero-mail";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { Button, cn } from "@vm0/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";

import {
  featureSwitch$,
  newChatThreadSidebarEnabled$,
} from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type {
  MailDraftFollowUpState,
  MailDraftSignals,
} from "../../signals/chat-page/mail-draft.ts";
import { currentMailDraftId$ } from "../../signals/zero-page/mail-draft-sidebar.ts";
import {
  activeSidebarMailDraftId$,
  openThreadMailDraft$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { useGmailReconnect } from "./use-gmail-reconnect.ts";

interface MailDraftCardProps {
  readonly signals: MailDraftSignals;
}

interface EnabledMailDraftCardProps extends MailDraftCardProps {
  readonly followUpEnabled: boolean;
}

function statusLabel(status: ZeroMailDraftStatus): string {
  switch (status) {
    case "draft": {
      return "Draft";
    }
    case "sent": {
      return "Sent";
    }
    case "deleted": {
      return "Deleted";
    }
  }
}

function MailDraftCardSkeleton() {
  return (
    <div className="flex min-h-[76px] w-full max-w-xl items-center gap-3 rounded-[var(--zero-card-radius)] border border-border/70 bg-card px-4 py-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <IconLoader2 className="animate-spin text-muted-foreground" size={16} />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-2/3 rounded bg-muted/70" />
        <div className="h-3 w-1/3 rounded bg-muted/60" />
      </div>
    </div>
  );
}

function mailDraftRecipients(draft: ZeroMailDraft): string {
  const firstRecipient = draft.to[0];
  if (!firstRecipient) {
    return "(No recipient)";
  }
  return draft.to.length === 1
    ? firstRecipient
    : `${firstRecipient} +${draft.to.length - 1}`;
}

function MailDraftCardContent({
  draft,
  gmailIcon,
  reconnecting,
}: {
  readonly draft: ZeroMailDraft;
  readonly gmailIcon: PublicConnectorCatalogIcon | undefined;
  readonly reconnecting: boolean;
}) {
  const deleted = draft.status === "deleted";
  const reconnect = draft.accessStatus === "reconnect";
  return (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
        <ConnectorIcon icon={gmailIcon} size={23} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5 text-foreground">
          {draft.subject || "(No subject)"}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          To: {mailDraftRecipients(draft)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 self-center">
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[11px] font-medium",
            draft.status === "sent" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            draft.status === "draft" &&
              !reconnect &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-300",
            reconnect && "bg-destructive/10 text-destructive dark:text-red-300",
            deleted && "bg-muted text-muted-foreground",
          )}
        >
          {reconnecting
            ? "Reconnecting…"
            : reconnect
              ? "Need reconnect"
              : statusLabel(draft.status)}
        </span>
        {!deleted ? (
          <IconChevronRight size={16} className="text-muted-foreground" />
        ) : null}
      </span>
    </>
  );
}

function followUpDescription(state: MailDraftFollowUpState): string {
  switch (state) {
    case "active": {
      return "Replies are tracked and will be reported in this chat.";
    }
    case "paused": {
      return "Reply tracking is currently paused.";
    }
    case "submitting": {
      return "Setting up reply tracking…";
    }
    case "idle": {
      return "Track replies and get notified in this chat.";
    }
  }
}

function followUpButtonLabel(state: MailDraftFollowUpState): string {
  switch (state) {
    case "active": {
      return "Tracking replies";
    }
    case "paused": {
      return "Tracking paused";
    }
    case "submitting": {
      return "Setting up…";
    }
    case "idle": {
      return "Follow up";
    }
  }
}

function FollowUpIcon({ state }: { readonly state: MailDraftFollowUpState }) {
  if (state === "submitting") {
    return <IconLoader2 size={15} className="animate-spin" />;
  }
  return state === "active" ? (
    <IconCircleCheck size={15} />
  ) : (
    <IconRoute size={15} />
  );
}

function SentMailDraftCard({
  draft,
  gmailIcon,
  selected,
  followUpState,
  onOpen,
  onFollowUp,
}: {
  readonly draft: ZeroMailDraft;
  readonly gmailIcon: PublicConnectorCatalogIcon | undefined;
  readonly selected: boolean;
  readonly followUpState: MailDraftFollowUpState;
  readonly onOpen: () => void;
  readonly onFollowUp: () => void;
}) {
  return (
    <div
      data-mail-draft-card
      data-mail-draft-status={draft.status}
      className={cn(
        "w-full max-w-xl overflow-hidden rounded-[var(--zero-card-radius)] border bg-card",
        selected ? "border-ring/60 bg-muted/20" : "border-border/70",
      )}
    >
      <button
        type="button"
        aria-label={`Open sent email: ${draft.subject || "No subject"}`}
        onClick={onOpen}
        className="flex min-h-[76px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <MailDraftCardContent
          draft={draft}
          gmailIcon={gmailIcon}
          reconnecting={false}
        />
      </button>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {followUpDescription(followUpState)}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={followUpState !== "idle"}
          onClick={onFollowUp}
        >
          <FollowUpIcon state={followUpState} />
          {followUpButtonLabel(followUpState)}
        </Button>
      </div>
    </div>
  );
}

function EnabledMailDraftCard({
  signals,
  followUpEnabled,
}: EnabledMailDraftCardProps) {
  const draftLoadable = useLastLoadable(signals.draft$);
  const newSidebarEnabled = useGet(newChatThreadSidebarEnabled$);
  const legacySelectedMailDraftId = useGet(currentMailDraftId$);
  const activeSidebarMailDraftId = useGet(activeSidebarMailDraftId$);
  const selectedMailDraftId = newSidebarEnabled
    ? activeSidebarMailDraftId
    : legacySelectedMailDraftId;
  const openSidebar = useSet(openThreadMailDraft$);
  const reloadDraft = useSet(signals.reloadDraft$);
  const pageSignal = useGet(pageSignal$);
  const localFollowUpState = useGet(signals.followUpState$);
  const followUp = useSet(signals.followUp$);
  const { connectorIcon, reconnect, reconnectDisabled, reconnecting } =
    useGmailReconnect(reloadDraft);

  if (draftLoadable.state === "loading") {
    return <MailDraftCardSkeleton />;
  }
  if (draftLoadable.state === "hasError" || draftLoadable.data === null) {
    return null;
  }

  const draft = draftLoadable.data;
  const followUpState =
    localFollowUpState === "submitting"
      ? localFollowUpState
      : (draft.followUp?.status ?? localFollowUpState);
  const deleted = draft.status === "deleted";
  const needsReconnect = draft.accessStatus === "reconnect";
  const selected = selectedMailDraftId === signals.mailDraftId;
  const openDraft = () => {
    reloadDraft();
    openSidebar(signals.mailDraftId);
  };
  const content = (
    <MailDraftCardContent
      draft={draft}
      gmailIcon={connectorIcon}
      reconnecting={needsReconnect && reconnecting}
    />
  );

  if (deleted) {
    return (
      <div
        aria-disabled="true"
        aria-label={`Deleted email: ${draft.subject || "No subject"}`}
        data-mail-draft-card
        data-mail-draft-status="deleted"
        className="flex min-h-[76px] w-full max-w-xl cursor-default items-center gap-3 rounded-[var(--zero-card-radius)] border border-border/60 bg-card px-4 py-3 opacity-70"
      >
        {content}
      </div>
    );
  }

  if (needsReconnect) {
    return (
      <button
        type="button"
        disabled={reconnectDisabled}
        onClick={reconnect}
        aria-label={`Reconnect Gmail to access email: ${draft.subject || "No subject"}`}
        data-mail-draft-card
        data-mail-draft-status={draft.status}
        className="flex min-h-[76px] w-full max-w-xl items-center gap-3 rounded-[var(--zero-card-radius)] border border-border/70 bg-card px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70"
      >
        {content}
      </button>
    );
  }

  if (draft.status === "sent" && followUpEnabled) {
    return (
      <SentMailDraftCard
        draft={draft}
        gmailIcon={connectorIcon}
        selected={selected}
        followUpState={followUpState}
        onOpen={openDraft}
        onFollowUp={() => {
          detach(followUp(pageSignal), Reason.DomCallback);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={`Open ${draft.status} email: ${draft.subject || "No subject"}`}
      data-mail-draft-card
      data-mail-draft-status={draft.status}
      onClick={openDraft}
      className={cn(
        "flex min-h-[76px] w-full max-w-xl items-center gap-3 rounded-[var(--zero-card-radius)] border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selected ? "border-ring/60 bg-muted/20" : "border-border/70",
      )}
    >
      {content}
    </button>
  );
}

export function MailDraftCard(props: MailDraftCardProps) {
  const featureSwitches = useGet(featureSwitch$);
  return (
    <EnabledMailDraftCard
      {...props}
      followUpEnabled={
        featureSwitches[FeatureSwitchKey.ZeroMailReplyFollowUp] ?? false
      }
    />
  );
}
