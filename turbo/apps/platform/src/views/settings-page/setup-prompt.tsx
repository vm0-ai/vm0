import { useGet, useSet } from "ccstate-react";
import { detach, Reason } from "../../signals/utils";
import { copyStatus$, copyToClipboard$ } from "../../signals/onboarding";

export function ClaudeCodeSetupPrompt() {
  const copyStatus = useGet(copyStatus$);
  const copyToClipboard = useSet(copyToClipboard$);

  return (
    <p className="text-xs text-muted-foreground">
      You can find it by enter{" "}
      <code
        className="cursor-pointer rounded bg-muted px-1 py-0.5 font-mono hover:bg-muted/80 active:bg-muted/60"
        onClick={() => {
          detach(copyToClipboard("claude setup-token"), Reason.DomCallback);
        }}
        title="Click to copy"
      >
        {copyStatus === "copied" ? "copied!" : "claude setup-token"}
      </code>{" "}
      in your terminal
    </p>
  );
}
