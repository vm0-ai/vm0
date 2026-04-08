import { useGet, useSet } from "ccstate-react";
import { Button, Input } from "@vm0/ui";
import { IconPhone, IconCheck, IconX } from "@tabler/icons-react";
import {
  phoneStatus$,
  phoneLoading$,
  phoneError$,
  phoneVerifyStep$,
  phoneSending$,
  phoneInput$,
  codeInput$,
  setPhoneInput$,
  setCodeInput$,
  setPhoneVerifyStep$,
  setPhoneError$,
  sendPhoneVerifyCode$,
  confirmPhoneVerifyCode$,
} from "../../signals/phone-page/phone-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

export function PhonePage() {
  const status = useGet(phoneStatus$);
  const loading = useGet(phoneLoading$);
  const error = useGet(phoneError$);
  const verifyStep = useGet(phoneVerifyStep$);
  const sending = useGet(phoneSending$);
  const phoneInput = useGet(phoneInput$);
  const codeInput = useGet(codeInput$);
  const pageSignal = useGet(pageSignal$);

  const setPhoneInput = useSet(setPhoneInput$);
  const setCodeInput = useSet(setCodeInput$);
  const setVerifyStep = useSet(setPhoneVerifyStep$);
  const setError = useSet(setPhoneError$);

  const sendCode = useSet(sendPhoneVerifyCode$);
  const confirmCode = useSet(confirmPhoneVerifyCode$);

  if (loading && !status) {
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
          Call Zero via phone. Verify your number to get started.
        </p>
      </div>

      {/* Zero's Phone Number */}
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Zero&apos;s Phone Number</h2>
        {status?.orgPhone ? (
          <div className="flex items-center gap-2">
            <IconPhone size={18} />
            <span className="font-mono text-lg">{status.orgPhone}</span>
          </div>
        ) : (
          <p className="text-muted-foreground">
            Phone is not configured for this organization. Contact your admin to
            set it up.
          </p>
        )}
      </section>

      {/* Your Phone Number */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your Phone Number</h2>
        {status?.userPhone ? (
          <div className="flex items-center gap-2">
            <IconCheck size={18} className="text-green-500" />
            <span className="font-mono">{status.userPhone}</span>
            <span className="text-muted-foreground text-sm">Verified</span>
          </div>
        ) : verifyStep === "phone" ? (
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
                    sendCode(phoneInput, pageSignal),
                    Reason.DomCallback,
                    "sendPhoneCode",
                  );
                }}
                disabled={!phoneInput || sending}
              >
                {sending ? "Sending..." : "Send Code"}
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              Enter your phone number in E.164 format
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              Code sent to <span className="font-mono">{phoneInput}</span>
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="123456"
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(e.target.value);
                }}
                className="max-w-[120px] font-mono"
                maxLength={6}
              />
              <Button
                onClick={() => {
                  detach(
                    confirmCode(
                      { phoneNumber: phoneInput, code: codeInput },
                      pageSignal,
                    ),
                    Reason.DomCallback,
                    "confirmPhoneCode",
                  );
                }}
                disabled={codeInput.length !== 6 || sending}
              >
                {sending ? "Verifying..." : "Verify"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setVerifyStep("phone");
                  setCodeInput("");
                  setError(null);
                }}
              >
                <IconX size={16} />
              </Button>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </section>
    </div>
  );
}
