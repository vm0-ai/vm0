// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, Input } from "@vm0/ui";
import { IconPhone, IconCheck, IconTrash } from "@tabler/icons-react";
import { defaultAgentName$ } from "../../signals/agent.ts";
import {
  phoneStatus$,
  phoneError$,
  phoneInput$,
  setPhoneInput$,
  savePhoneLink$,
  removePhoneLink$,
  requestOrgPhoneSetup$,
} from "../../signals/phone-page/phone-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

export function PhonePage() {
  const status = useGet(phoneStatus$);
  const error = useGet(phoneError$);
  const phoneInput = useGet(phoneInput$);
  const pageSignal = useGet(pageSignal$);
  const agentName = useLastResolved(defaultAgentName$) ?? "Zero";

  const setPhoneInput = useSet(setPhoneInput$);
  const [saveLinkLoadable, saveLink] = useLoadableSet(savePhoneLink$);
  const [removeLinkLoadable, removeLink] = useLoadableSet(removePhoneLink$);
  const [setupLoadable, requestSetup] = useLoadableSet(requestOrgPhoneSetup$);

  const saving =
    saveLinkLoadable.state === "loading" ||
    removeLinkLoadable.state === "loading";
  const setupLoading = setupLoadable.state === "loading";

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Phone</h1>
        <p className="text-muted-foreground mt-1">
          Call {agentName} via phone. Link your number to get started.
        </p>
      </div>

      {/* Zero's Phone Number */}
      <section className="space-y-2">
        <h2 className="text-lg font-medium">{agentName}&apos;s Phone Number</h2>
        {status.orgPhone ? (
          <div className="flex items-center gap-2">
            <IconPhone size={18} />
            <span className="font-mono text-lg">{status.orgPhone}</span>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              Phone is not configured for this organization.
            </p>
            <Button
              onClick={() => {
                detach(
                  requestSetup(pageSignal),
                  Reason.DomCallback,
                  "requestOrgPhoneSetup",
                );
              }}
              disabled={setupLoading}
            >
              {setupLoading ? "Setting up..." : "Request Org Phone Number"}
            </Button>
          </div>
        )}
      </section>

      {/* Your Phone Number */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your Phone Number</h2>
        {status.userPhone ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <IconCheck size={18} className="text-green-500" />
              <span className="font-mono">{status.userPhone}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  detach(
                    removeLink(pageSignal),
                    Reason.DomCallback,
                    "removePhoneLink",
                  );
                }}
                disabled={saving}
              >
                <IconTrash size={16} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                placeholder="+14155551234"
                value={phoneInput}
                onChange={(e) => {
                  setPhoneInput(e.target.value);
                }}
                className="max-w-xs font-mono"
              />
              <Button
                onClick={() => {
                  detach(
                    saveLink(phoneInput, pageSignal),
                    Reason.DomCallback,
                    "savePhoneLink",
                  );
                }}
                disabled={!phoneInput || saving}
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              Enter your phone number in E.164 format
            </p>
          </div>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
        <p className="text-muted-foreground mt-2 text-xs">
          By providing your phone number, you authorize VM0 to send text
          messages including verification codes and notifications to the number
          provided. Message and data rates may apply. Message frequency varies.
          Reply HELP for help or STOP to opt out. See{" "}
          <a
            href="https://www.vm0.ai/terms-of-use"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Terms of Use
          </a>{" "}
          and{" "}
          <a
            href="https://www.vm0.ai/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Privacy Policy
          </a>
          .
        </p>
      </section>
    </div>
  );
}
