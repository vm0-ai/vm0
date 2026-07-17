import type { ChangeEvent, FocusEvent, FormEvent, MouseEvent } from "react";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconMail,
  IconSend,
  IconX,
} from "@tabler/icons-react";
import type {
  ZeroMailDraft,
  ZeroMailDraftStatus,
} from "@vm0/api-contracts/contracts/zero-mail";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Button, Input, cn } from "@vm0/ui";

import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  newestMailDraft,
  type MailDraftFields,
  type MailDraftSignals,
} from "../../signals/chat-page/mail-draft.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface MailDraftCardProps {
  readonly signals: MailDraftSignals;
}

interface DraftStatusCopy {
  readonly label: string;
  readonly className: string;
}

function parseRecipients(value: string): string[] {
  return value
    .split(/[;,\n]/)
    .map((recipient) => {
      return recipient.trim();
    })
    .filter(Boolean);
}

function statusCopy(status: ZeroMailDraftStatus): DraftStatusCopy {
  switch (status) {
    case "draft": {
      return { label: "Draft", className: "bg-muted text-muted-foreground" };
    }
    case "sending": {
      return {
        label: "Sending",
        className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
      };
    }
    case "sent": {
      return {
        label: "Sent",
        className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    }
    case "cancelled": {
      return {
        label: "Cancelled",
        className: "bg-muted text-muted-foreground",
      };
    }
    case "failed": {
      return {
        label: "Failed",
        className: "bg-destructive/10 text-destructive",
      };
    }
    case "delivery_unknown": {
      return {
        label: "Delivery unknown",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    }
  }
}

function fieldsFromForm(form: HTMLFormElement): MailDraftFields {
  const data = new FormData(form);
  return {
    to: parseRecipients(String(data.get("to") ?? "")),
    subject: String(data.get("subject") ?? ""),
    body: String(data.get("body") ?? ""),
  };
}

function MailDraftStatus({ status }: { status: ZeroMailDraftStatus }) {
  const copy = statusCopy(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
        copy.className,
      )}
    >
      {status === "sending" ? (
        <IconLoader2 size={12} className="animate-spin" aria-hidden />
      ) : status === "sent" ? (
        <IconCheck size={12} aria-hidden />
      ) : null}
      {copy.label}
    </span>
  );
}

function MailDraftHeader({ mailDraft }: { mailDraft: ZeroMailDraft }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted">
          <IconMail size={17} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">Review email</h3>
          <p className="truncate text-xs text-muted-foreground">
            {mailDraft.provider === "gmail" ? "Gmail" : "Outlook"}
          </p>
        </div>
      </div>
      <MailDraftStatus status={mailDraft.status} />
    </header>
  );
}

function MailDraftFields({
  mailDraft,
  editable,
  actionPending,
  onBlur,
}: {
  readonly mailDraft: ZeroMailDraft;
  readonly editable: boolean;
  readonly actionPending: boolean;
  readonly onBlur: (
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
}) {
  const disabled = !editable || actionPending;
  return (
    <div className="space-y-3 px-4 py-4">
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        From
        <Input
          aria-label="From"
          value={mailDraft.from}
          readOnly
          className="bg-muted/40 text-foreground"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        To
        <Input
          aria-label="To"
          name="to"
          type="email"
          multiple
          required
          defaultValue={mailDraft.to.join(", ")}
          disabled={disabled}
          onBlur={onBlur}
          className="text-foreground"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Subject
        <Input
          aria-label="Subject"
          name="subject"
          required
          defaultValue={mailDraft.subject}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            event.currentTarget.value = event.currentTarget.value.replace(
              /[\r\n]/g,
              " ",
            );
          }}
          onBlur={onBlur}
          className="text-foreground"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Message
        <textarea
          aria-label="Message"
          name="body"
          required
          defaultValue={mailDraft.body}
          disabled={disabled}
          onBlur={onBlur}
          rows={8}
          className="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </label>
    </div>
  );
}

function MailDraftFeedback({
  mailDraft,
  actionFailed,
}: {
  readonly mailDraft: ZeroMailDraft;
  readonly actionFailed: boolean;
}) {
  if (
    mailDraft.status !== "delivery_unknown" &&
    !mailDraft.error &&
    !actionFailed
  ) {
    return null;
  }
  return (
    <div className="space-y-2 px-4 pb-4">
      {mailDraft.status === "delivery_unknown" ? (
        <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <IconAlertTriangle size={15} className="mt-0.5 shrink-0" />
          Delivery could not be confirmed. Check the Sent folder before trying
          another message.
        </div>
      ) : null}
      {mailDraft.error ? (
        <p className="text-xs text-destructive">{mailDraft.error}</p>
      ) : null}
      {actionFailed ? (
        <p className="text-xs text-destructive">
          The card could not be updated. Try again.
        </p>
      ) : null}
    </div>
  );
}

function MailDraftActions({
  busy,
  sending,
  onCancel,
}: {
  readonly busy: boolean;
  readonly sending: boolean;
  readonly onCancel: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <footer className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
      <Button
        data-mail-draft-action
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onCancel}
      >
        <IconX size={15} aria-hidden />
        Cancel
      </Button>
      <Button data-mail-draft-action type="submit" size="sm" disabled={busy}>
        {sending ? (
          <IconLoader2 size={15} className="animate-spin" aria-hidden />
        ) : (
          <IconSend size={15} aria-hidden />
        )}
        Send
      </Button>
    </footer>
  );
}

function ReadyMailDraftCard({
  signals,
  mailDraft,
}: {
  readonly signals: MailDraftSignals;
  readonly mailDraft: ZeroMailDraft;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateDraft] = useLoadableSet(signals.update$);
  const [cancelLoadable, cancelDraft] = useLoadableSet(signals.cancel$);
  const [sendLoadable, sendDraft] = useLoadableSet(signals.send$);
  const editable =
    mailDraft.status === "draft" || mailDraft.status === "failed";
  const updatePending = updateLoadable.state === "loading";
  const actionPending =
    cancelLoadable.state === "loading" || sendLoadable.state === "loading";
  const actionFailed =
    updateLoadable.state === "hasError" ||
    cancelLoadable.state === "hasError" ||
    sendLoadable.state === "hasError";

  const saveOnBlur = (
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const form = event.currentTarget.form;
    if (
      !form ||
      !editable ||
      updatePending ||
      actionPending ||
      !form.checkValidity() ||
      (event.relatedTarget instanceof Element &&
        event.relatedTarget.closest("[data-mail-draft-action]"))
    ) {
      return;
    }
    detach(updateDraft(fieldsFromForm(form), pageSignal), Reason.DomCallback);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    detach(
      sendDraft(fieldsFromForm(event.currentTarget), pageSignal),
      Reason.DomCallback,
    );
  };

  const onCancel = () => {
    detach(cancelDraft(pageSignal), Reason.DomCallback);
  };

  return (
    <form onSubmit={onSubmit}>
      <section
        aria-label="Review email"
        data-mail-draft-card
        data-mail-draft-status={mailDraft.status}
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
      >
        <MailDraftHeader mailDraft={mailDraft} />
        <MailDraftFields
          key={mailDraft.updatedAt}
          mailDraft={mailDraft}
          editable={editable}
          actionPending={actionPending}
          onBlur={saveOnBlur}
        />
        <MailDraftFeedback mailDraft={mailDraft} actionFailed={actionFailed} />
        {editable ? (
          <MailDraftActions
            busy={updatePending || actionPending}
            sending={sendLoadable.state === "loading"}
            onCancel={onCancel}
          />
        ) : null}
      </section>
    </form>
  );
}

function EnabledMailDraftCard({ signals }: MailDraftCardProps) {
  const mailDraftLoadable = useLoadable(signals.serverDraft$);
  const mutationDraft = useGet(signals.mutationDraft$);
  if (mailDraftLoadable.state === "loading") {
    return (
      <section
        aria-label="Review email"
        className="flex w-full max-w-2xl items-center gap-2 rounded-2xl border border-border/70 bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm"
      >
        <IconLoader2 size={16} className="animate-spin" aria-hidden />
        Loading email draft
      </section>
    );
  }
  if (mailDraftLoadable.state === "hasError") {
    return (
      <section
        aria-label="Review email"
        className="flex w-full max-w-2xl items-center gap-2 rounded-2xl border border-destructive/30 bg-card px-4 py-3 text-sm text-destructive shadow-sm"
      >
        <IconAlertTriangle size={16} aria-hidden />
        The email draft could not be loaded.
      </section>
    );
  }
  return (
    <ReadyMailDraftCard
      signals={signals}
      mailDraft={
        mutationDraft === undefined
          ? mailDraftLoadable.data
          : newestMailDraft(mailDraftLoadable.data, mutationDraft)
      }
    />
  );
}

export function MailDraftCard(props: MailDraftCardProps) {
  const featureSwitches = useGet(featureSwitch$);
  return featureSwitches[FeatureSwitchKey.ZeroMail] ? (
    <EnabledMailDraftCard {...props} />
  ) : null;
}
