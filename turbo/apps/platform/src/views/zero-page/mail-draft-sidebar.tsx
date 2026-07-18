import type { FocusEvent, FormEvent } from "react";
import {
  IconExternalLink,
  IconLoader2,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import type { ZeroMailDraft } from "@vm0/api-contracts/contracts/zero-mail";
import { Button, Input } from "@vm0/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";

import type {
  MailDraftFields,
  MailDraftSignals,
} from "../../signals/chat-page/mail-draft.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { closeMailDraftSidebar$ } from "../../signals/zero-page/mail-draft-sidebar.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface MailDraftSidebarProps {
  readonly signals: MailDraftSignals;
}

function parseRecipients(value: string): string[] {
  return value
    .split(/[;,\n]/u)
    .map((recipient) => {
      return recipient.trim();
    })
    .filter(Boolean);
}

function fieldsFromForm(form: HTMLFormElement): MailDraftFields {
  const data = new FormData(form);
  return {
    to: parseRecipients(String(data.get("to") ?? "")),
    cc: parseRecipients(String(data.get("cc") ?? "")),
    bcc: parseRecipients(String(data.get("bcc") ?? "")),
    subject: String(data.get("subject") ?? ""),
    body: String(data.get("body") ?? ""),
  };
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
    <div className="grid gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="break-words text-sm text-foreground">{value}</div>
    </div>
  );
}

interface MailDraftFormFieldsProps {
  readonly draft: ZeroMailDraft;
  readonly editable: boolean;
  readonly pending: boolean;
  readonly saveOnBlur: (
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
}

function MailDraftFormFields({
  draft,
  editable,
  pending,
  saveOnBlur,
}: MailDraftFormFieldsProps) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        From
        <Input
          aria-label="From"
          value={
            draft.fromName ? `${draft.fromName} <${draft.from}>` : draft.from
          }
          readOnly
          className="bg-muted/40 text-foreground"
        />
      </label>
      {(["to", "cc", "bcc"] as const).map((field) => {
        const label = field.toUpperCase();
        return (
          <label
            key={field}
            className="grid gap-1.5 text-xs font-medium text-muted-foreground"
          >
            {label}
            <Input
              aria-label={label}
              name={field}
              type="email"
              multiple
              required={field === "to"}
              defaultValue={draft[field].join(", ")}
              readOnly={!editable}
              disabled={pending}
              onBlur={saveOnBlur}
              className="text-foreground read-only:bg-muted/30"
            />
          </label>
        );
      })}
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Subject
        <Input
          aria-label="Subject"
          name="subject"
          required
          defaultValue={draft.subject}
          readOnly={!editable}
          disabled={pending}
          onBlur={saveOnBlur}
          className="text-foreground read-only:bg-muted/30"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Message
        <textarea
          aria-label="Message"
          name="body"
          required
          defaultValue={draft.body}
          readOnly={!editable}
          disabled={pending}
          onBlur={saveOnBlur}
          className="min-h-64 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 read-only:bg-muted/30 disabled:opacity-50"
        />
      </label>
      {draft.replyTo ? (
        <DetailField label="Reply-To" value={draft.replyTo} />
      ) : null}
      {draft.inReplyTo ? (
        <DetailField label="In-Reply-To" value={draft.inReplyTo} />
      ) : null}
      {draft.references.length > 0 ? (
        <DetailField label="References" value={draft.references.join(" ")} />
      ) : null}
    </div>
  );
}

interface MailDraftFooterProps {
  readonly editable: boolean;
  readonly pending: boolean;
  readonly deleting: boolean;
  readonly sending: boolean;
  readonly openInGmail: string | null;
  readonly onDelete: () => void;
}

function MailDraftFooter({
  editable,
  pending,
  deleting,
  sending,
  openInGmail,
  onDelete,
}: MailDraftFooterProps) {
  return (
    <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
      {editable ? (
        <Button
          data-mail-draft-action
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          {deleting ? (
            <IconLoader2 size={15} className="animate-spin" />
          ) : (
            <IconTrash size={15} />
          )}
          Delete
        </Button>
      ) : openInGmail ? (
        <Button asChild variant="outline" size="sm">
          <a href={openInGmail} target="_blank" rel="noreferrer">
            <IconExternalLink size={15} />
            Open in Gmail
          </a>
        </Button>
      ) : (
        <span />
      )}
      {editable ? (
        <Button
          data-mail-draft-action
          type="submit"
          size="sm"
          disabled={pending}
        >
          {sending ? (
            <IconLoader2 size={15} className="animate-spin" />
          ) : (
            <IconSend size={15} />
          )}
          Send
        </Button>
      ) : null}
    </footer>
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
  const [updateLoadable, update] = useLoadableSet(signals.update$);
  const [deleteLoadable, deleteDraft] = useLoadableSet(signals.delete$);
  const [sendLoadable, send] = useLoadableSet(signals.send$);
  const editable = draft.status === "draft";
  const pending = [updateLoadable, deleteLoadable, sendLoadable].some(
    (loadable) => {
      return loadable.state === "loading";
    },
  );

  const saveOnBlur = (
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const form = event.currentTarget.form;
    const movingToAction =
      event.relatedTarget instanceof Element &&
      event.relatedTarget.closest("[data-mail-draft-action]");
    if (
      !form ||
      !editable ||
      pending ||
      !form.checkValidity() ||
      movingToAction
    ) {
      return;
    }
    detach(update(fieldsFromForm(form), pageSignal), Reason.DomCallback);
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    detach(
      send(fieldsFromForm(event.currentTarget), pageSignal),
      Reason.DomCallback,
    );
  };
  const onDelete = () => {
    const deleteAndClose = async () => {
      await deleteDraft(pageSignal);
      close();
    };
    detach(deleteAndClose(), Reason.DomCallback);
  };
  const openInGmail = draft.gmailThreadId
    ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(draft.gmailThreadId)}`
    : null;

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
            {editable ? "Gmail draft" : "Sent email"}
          </div>
        </div>
        <SidebarCloseButton close={close} />
      </div>
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <MailDraftFormFields
          draft={draft}
          editable={editable}
          pending={pending}
          saveOnBlur={saveOnBlur}
        />
        <MailDraftFooter
          editable={editable}
          pending={pending}
          deleting={deleteLoadable.state === "loading"}
          sending={sendLoadable.state === "loading"}
          openInGmail={openInGmail}
          onDelete={onDelete}
        />
      </form>
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
