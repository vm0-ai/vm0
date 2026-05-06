import { useGet, useSet } from "ccstate-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import {
  codexPasteDialogState$,
  setCodexPasteDialogState$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { submitCodexAuthJson$ } from "../../../../signals/external/org-model-providers.ts";
import { ApiError } from "../../../../lib/accept.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

/**
 * Paste-based connection dialog for the codex-oauth-token provider.
 *
 * Replaces the broken cross-origin `window.location.assign` redirect that
 * shipped in #11909 (the platform SPA on app.vm0.ai resolved the relative
 * /api/zero/chatgpt/oauth/connect path against itself instead of www.vm0.ai).
 * Same component handles first-time connect and re-paste recovery from a
 * stale session — only the title differs by mode.
 *
 * Submit POSTs `{ type: 'codex-oauth-token', authMethod: 'auth_json',
 * secrets: { CODEX_AUTH_JSON: <raw> } }` to /api/zero/model-providers; the
 * server-side parser lands in #11978. Typed error codes
 * (`auth_json_shape_invalid`, `free_plan_rejected`) surface inline rather
 * than via toast — the user is staring at the textarea, an inline message
 * keeps the cause-and-effect close.
 */
export function CodexAuthPasteDialog() {
  const dialog = useGet(codexPasteDialogState$);
  const setDialog = useSet(setCodexPasteDialogState$);
  const submit = useSet(submitCodexAuthJson$);
  const pageSignal = useGet(pageSignal$);

  const [paste, setPaste] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<ApiError | null>(null);

  function resetTransientState(): void {
    setPaste("");
    setServerError(null);
    setSubmitting(false);
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) {
      resetTransientState();
    }
    setDialog({ ...dialog, open: nextOpen });
  }

  const trimmed = paste.trim();
  const localParseError = computeLocalParseError(trimmed);
  const canSubmit = trimmed !== "" && localParseError === null && !submitting;

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    setServerError(null);
    try {
      await submit(trimmed, pageSignal);
      resetTransientState();
      setDialog({ ...dialog, open: false });
    } catch (error) {
      if (error instanceof ApiError) {
        setServerError(error);
      } else {
        throw error;
      }
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    dialog.mode === "reconnect" ? "Re-connect Codex" : "Connect Codex";
  const submitLabel = submitting
    ? "Connecting…"
    : dialog.mode === "reconnect"
      ? "Reconnect"
      : "Connect";

  return (
    <Dialog open={dialog.open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Paste the contents of <code>~/.codex/auth.json</code> from the
            machine where you ran <code>codex login</code>.
          </DialogDescription>
        </DialogHeader>

        <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
          <li>
            On your local machine, run <code>codex login</code>
          </li>
          <li>
            After successful login, run <code>cat ~/.codex/auth.json</code>
          </li>
          <li>Paste the entire JSON output below</li>
        </ol>

        <textarea
          value={paste}
          onChange={(e) => {
            setPaste(e.target.value);
            if (serverError) {
              setServerError(null);
            }
          }}
          placeholder='{"OPENAI_API_KEY": "...", "tokens": {...}, ...}'
          rows={8}
          spellCheck={false}
          aria-label="codex auth.json content"
          data-testid="codex-paste-textarea"
          className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-xs font-mono whitespace-pre text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[10rem]"
        />

        {localParseError && (
          <p className="text-xs text-muted-foreground">{localParseError}</p>
        )}
        {serverError && (
          <p className="text-xs text-destructive" role="alert">
            {getErrorCopy(serverError)}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              handleOpenChange(false);
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              detach(handleSubmit(), Reason.DomCallback);
            }}
            disabled={!canSubmit}
            data-testid="codex-paste-submit"
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function computeLocalParseError(trimmed: string): string | null {
  if (trimmed === "") {
    return null;
  }
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    return "Looks like the paste isn't valid JSON yet.";
  }
}

function getErrorCopy(error: ApiError): string {
  if (error.code === "auth_json_shape_invalid") {
    return "auth.json format unrecognized — your codex CLI may need updating. Re-run `codex login` and try again.";
  }
  if (error.code === "free_plan_rejected") {
    return "Free ChatGPT plans cannot use Codex via vm0. Upgrade to Plus or Pro and re-run `codex login`.";
  }
  return error.message;
}
