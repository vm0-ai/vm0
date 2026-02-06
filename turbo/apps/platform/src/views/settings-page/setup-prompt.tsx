import { useGet, useSet } from "ccstate-react";
import { detach, Reason } from "../../signals/utils";
import { copyStatus$, copyToClipboard$ } from "../../signals/onboarding";

export function ClaudeCodeSetupPrompt() {
  const copyStatus = useGet(copyStatus$);
  const copyToClipboard = useSet(copyToClipboard$);

  return (
    <p className="text-xs text-muted-foreground">
      You can find it by entering{" "}
      <code
        className="cursor-pointer rounded border border-border bg-gray-50 px-1 py-0.5 font-mono hover:bg-gray-100 active:bg-gray-200"
        onClick={() => {
          detach(copyToClipboard("claude setup-token"), Reason.DomCallback);
        }}
        title="Click to copy"
      >
        {copyStatus === "copied" ? "copied!" : "claude setup-token"}
      </code>{" "}
      in your terminal.
    </p>
  );
}
