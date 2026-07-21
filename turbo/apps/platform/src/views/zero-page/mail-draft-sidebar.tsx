import {
  IconExternalLink,
  IconLoader2,
  IconPaperclip,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import type { ZeroMailDraft } from "@vm0/api-contracts/contracts/zero-mail";
import { Button } from "@vm0/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";

import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { closeMailDraftSidebar$ } from "../../signals/zero-page/mail-draft-sidebar.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface MailDraftSidebarProps {
  readonly signals: MailDraftSignals;
}

function SidebarCloseButton({ close }: { readonly close: () => void }) {
  return (
    <button
      type="button"
      onClick={close}
      aria-label="Close email details"
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      <IconX size={16} />
    </button>
  );
}

function UnavailableMailDraftSidebar({
  close,
  message,
}: {
  readonly close: () => void;
  readonly message: string;
}) {
  return (
    <aside
      aria-label="Email details"
      className="flex h-full w-full flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <div className="flex min-h-14 items-center border-b border-border/60 px-4">
        <span className="min-w-0 flex-1 text-sm font-medium">Email</span>
        <SidebarCloseButton close={close} />
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {message}
      </div>
    </aside>
  );
}

function DetailField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="break-words text-sm text-foreground">{value}</div>
    </div>
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (value < 1024 || i === units.length - 1) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value = value / 1024;
  }
  return `${bytes} B`;
}

function MailDraftDetails({ draft }: { readonly draft: ZeroMailDraft }) {
  const attachments = draft.version === 3 ? draft.attachments : [];
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
      <DetailField
        label="From"
        value={
          draft.fromName ? `${draft.fromName} <${draft.from}>` : draft.from
        }
      />
      <DetailField label="To" value={draft.to.join(", ") || "—"} />
      {draft.cc.length > 0 ? (
        <DetailField label="Cc" value={draft.cc.join(", ")} />
      ) : null}
      {draft.bcc.length > 0 ? (
        <DetailField label="Bcc" value={draft.bcc.join(", ")} />
      ) : null}
      <DetailField label="Subject" value={draft.subject || "(No subject)"} />
      <div className="grid gap-1.5">
        <div className="text-xs font-medium text-muted-foreground">Message</div>
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
          {draft.body || "(No message)"}
        </div>
      </div>
      {attachments.length > 0 ? (
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">
            Attachments
          </div>
          <div className="grid gap-2">
            {attachments.map((attachment) => {
              return (
                <div
                  key={`${attachment.filename}-${attachment.contentType}-${attachment.size}`}
                  className="flex items-center gap-3 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-gray-50 px-3 py-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                    <IconPaperclip size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {attachment.filename}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {formatAttachmentSize(attachment.size)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MailDraftDetail({
  draft,
  signals,
  close,
}: {
  readonly draft: ZeroMailDraft;
  readonly signals: MailDraftSignals;
  readonly close: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [deleteLoadable, deleteDraft] = useLoadableSet(signals.delete$);
  const [sendLoadable, send] = useLoadableSet(signals.send$);
  const active = draft.status === "draft";
  const pending =
    deleteLoadable.state === "loading" || sendLoadable.state === "loading";
  const openInGmail = draft.gmailThreadId
    ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(draft.gmailThreadId)}`
    : null;

  const onDelete = () => {
    const deleteAndClose = async () => {
      await deleteDraft(pageSignal);
      close();
    };
    detach(deleteAndClose(), Reason.DomCallback);
  };

  return (
    <aside
      aria-label="Email details"
      data-testid="mail-draft-sidebar"
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0 animate-in fade-in slide-in-from-right-2 duration-[180ms] ease"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {draft.subject || "(No subject)"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {active ? "Gmail draft" : "Sent email"}
          </div>
        </div>
        <SidebarCloseButton close={close} />
      </div>
      <MailDraftDetails draft={draft} />
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            {deleteLoadable.state === "loading" ? (
              <IconLoader2 size={15} className="animate-spin" />
            ) : (
              <IconTrash size={15} />
            )}
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {openInGmail ? (
            <Button asChild variant="outline" size="sm">
              <a href={openInGmail} target="_blank" rel="noreferrer">
                <IconExternalLink size={15} />
                Open in Gmail
              </a>
            </Button>
          ) : null}
          {active ? (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => {
                detach(send(pageSignal), Reason.DomCallback);
              }}
            >
              {sendLoadable.state === "loading" ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : (
                <IconSend size={15} />
              )}
              Send
            </Button>
          ) : null}
        </div>
      </footer>
    </aside>
  );
}

export function MailDraftSidebar({ signals }: MailDraftSidebarProps) {
  const draftLoadable = useLoadable(signals.draft$);
  const close = useSet(closeMailDraftSidebar$);
  if (draftLoadable.state === "loading") {
    return (
      <aside
        aria-label="Email details"
        className="flex h-full w-full items-center justify-center border-l border-border/60 bg-background xl:border-l-0"
      >
        <IconLoader2 className="animate-spin text-muted-foreground" size={18} />
      </aside>
    );
  }
  if (draftLoadable.state === "hasError" || draftLoadable.data === null) {
    return (
      <UnavailableMailDraftSidebar
        close={close}
        message="This email is no longer available."
      />
    );
  }
  if (draftLoadable.data.status === "deleted") {
    return (
      <UnavailableMailDraftSidebar
        close={close}
        message="This draft was deleted."
      />
    );
  }
  return (
    <MailDraftDetail
      draft={draftLoadable.data}
      signals={signals}
      close={close}
    />
  );
}
