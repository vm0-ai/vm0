import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconCheck,
  IconChevronDown,
  IconLoader,
  IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { cn } from "@vm0/ui";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  BB0_PROVISIONING_SERVICE_UUID,
  bb0BrowserSupport$,
  bb0CanConfirmCode$,
  bb0CanSendWifi$,
  bb0DeviceCodeInput$,
  bb0DeviceInfo$,
  bb0ProvisioningState$,
  bb0WifiPassword$,
  bb0WifiSsid$,
  confirmBb0DeviceCode$,
  connectBb0Device$,
  disconnectBb0Device$,
  refreshBb0DeviceStatus$,
  resetBb0Onboarding$,
  sendBb0WifiCredentials$,
  setBb0DeviceCodeInput$,
  setBb0WifiPassword$,
  setBb0WifiSsid$,
} from "../../signals/device-bb0-page/bb0-device-onboarding.ts";

const zeroSrc = "/zero.png";

function loadableErrorMessage(loadable: {
  readonly state: string;
  readonly error?: unknown;
}): string | null {
  if (loadable.state !== "hasError") {
    return null;
  }
  return loadable.error instanceof Error
    ? loadable.error.message
    : "BB0 setup failed.";
}

// ---------------------------------------------------------------------------
// Hero section (top banner, like Slack Huddles)
// ---------------------------------------------------------------------------

function HeroIllustration() {
  return (
    <img
      src={zeroSrc}
      alt=""
      role="presentation"
      className="hidden sm:block h-28 w-28 shrink-0 object-contain mix-blend-multiply dark:mix-blend-screen mr-10"
    />
  );
}

function HeroSection() {
  return (
    <div className="zero-card overflow-hidden">
      <div className="flex items-center gap-6 px-8 py-10 bg-gradient-to-br from-muted/60 via-muted/20 to-background">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Set up BB0
          </h1>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Three quick steps to get BB0 online. Pair over Bluetooth, share your
            Wi-Fi, and confirm the code on screen.
          </p>
        </div>
        <HeroIllustration />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step rows (like Slack "Recent huddles" rows + Zero onboarding cards)
// ---------------------------------------------------------------------------

function StepIcon({ src }: { readonly src: string }) {
  return (
    <img
      src={src}
      alt=""
      role="presentation"
      className="h-12 w-12 shrink-0 rounded-xl object-cover"
    />
  );
}

function CompleteBadge({ label }: { readonly label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-600">
      <IconCheck size={13} stroke={2.5} />
      {label}
    </span>
  );
}

function StepError({ message }: { readonly message: string | null }) {
  if (!message) {
    return null;
  }
  return <p className="mt-2 text-xs text-destructive">{message}</p>;
}

function MorandiButton({
  children,
  onClick,
  disabled,
  className,
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn("zero-btn-morandi", className)}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Connect via BLE
// ---------------------------------------------------------------------------

function BleConnectStep() {
  const info = useGet(bb0DeviceInfo$);
  const state = useGet(bb0ProvisioningState$);
  const pageSignal = useGet(pageSignal$);
  const [connectLoadable, connect] = useLoadableSet(connectBb0Device$);
  const disconnect = useSet(disconnectBb0Device$);
  const connecting = connectLoadable.state === "loading";
  const connected = state.connectionStatus === "connected";
  const error = loadableErrorMessage(connectLoadable);

  return (
    <div className="px-6 py-5">
      <div className="flex items-center gap-4">
        <StepIcon src="/onboarding-step1-connect-v3.png" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Connect BB0</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Hold the button on BB0 to enter setup mode, then select it from the
            device list.
          </p>
        </div>
        {connected && (
          <CompleteBadge label={`Connected · ${info.name ?? "BB0"}`} />
        )}
      </div>

      <div className="mt-3 pl-16 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <MorandiButton
            disabled={connecting || connected}
            onClick={() => {
              detach(
                connect({ acceptAllDevices: false }, pageSignal),
                Reason.DomCallback,
                "connectBb0Device",
              );
            }}
          >
            {connecting && <IconLoader size={14} className="animate-spin" />}
            {connected ? "Connected" : "Connect BB0"}
          </MorandiButton>
          {connected && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                disconnect();
              }}
            >
              Disconnect
            </Button>
          )}
        </div>

        <details className="group">
          <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            Technical details
            <IconChevronDown
              size={11}
              stroke={1.8}
              className="transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="zero-border mt-2 rounded-lg bg-muted/30 px-3 py-2 text-xs leading-6 text-muted-foreground">
            Filter: <code className="text-foreground">Zero-Buddy-*</code>
            <br />
            Service UUID:{" "}
            <code className="break-all text-foreground">
              {BB0_PROVISIONING_SERVICE_UUID}
            </code>
          </div>
        </details>

        <StepError message={error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Send Wi-Fi credentials
// ---------------------------------------------------------------------------

function WifiStep() {
  const state = useGet(bb0ProvisioningState$);
  const ssid = useGet(bb0WifiSsid$);
  const password = useGet(bb0WifiPassword$);
  const canSendWifi = useGet(bb0CanSendWifi$);
  const pageSignal = useGet(pageSignal$);
  const setSsid = useSet(setBb0WifiSsid$);
  const setPassword = useSet(setBb0WifiPassword$);
  const [refreshLoadable, refresh] = useLoadableSet(refreshBb0DeviceStatus$);
  const [wifiLoadable, sendWifi] = useLoadableSet(sendBb0WifiCredentials$);
  const connected = state.connectionStatus === "connected";
  const refreshing = refreshLoadable.state === "loading";
  const sendingWifi = wifiLoadable.state === "loading";
  const error =
    loadableErrorMessage(wifiLoadable) ?? loadableErrorMessage(refreshLoadable);

  return (
    <div className="px-6 py-5">
      <div className="flex items-center gap-4">
        <StepIcon src="/onboarding-step2-wifi-v2.png" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Share Wi-Fi</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Enter your network details and send them to BB0. It&apos;ll
            disconnect from Bluetooth once received.
          </p>
        </div>
        {state.wifiSent && <CompleteBadge label="Wi-Fi sent" />}
      </div>

      <div className="mt-3 pl-16 flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Wi-Fi SSID
            </span>
            <Input
              value={ssid}
              disabled={!connected || sendingWifi || state.wifiSent}
              placeholder="Zero-Lab"
              onChange={(e) => {
                setSsid(e.target.value);
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Password
            </span>
            <Input
              type="password"
              value={password}
              disabled={!connected || sendingWifi || state.wifiSent}
              placeholder="Leave empty for open network"
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <MorandiButton
            disabled={!canSendWifi || sendingWifi || state.wifiSent}
            onClick={() => {
              detach(
                sendWifi(pageSignal),
                Reason.DomCallback,
                "sendBb0WifiCredentials",
              );
            }}
          >
            {sendingWifi && <IconLoader size={14} className="animate-spin" />}
            {state.wifiSent ? "Wi-Fi sent" : "Send Wi-Fi"}
          </MorandiButton>
          <Button
            size="sm"
            variant="outline"
            disabled={!connected || refreshing || state.wifiSent}
            onClick={() => {
              detach(
                refresh(pageSignal),
                Reason.DomCallback,
                "refreshBb0DeviceStatus",
              );
            }}
          >
            {refreshing ? (
              <IconLoader size={14} className="animate-spin" />
            ) : (
              <IconRefresh size={14} />
            )}
            Refresh status
          </Button>
        </div>

        {state.wifiSent && (
          <p className="text-xs leading-5 text-muted-foreground">
            BB0 is connecting to Wi-Fi — a code will appear on its screen
            shortly.
          </p>
        )}
        <StepError message={error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Enter device code
// ---------------------------------------------------------------------------

function DeviceCodeStep() {
  const state = useGet(bb0ProvisioningState$);
  const deviceCode = useGet(bb0DeviceCodeInput$);
  const canConfirm = useGet(bb0CanConfirmCode$);
  const pageSignal = useGet(pageSignal$);
  const setDeviceCode = useSet(setBb0DeviceCodeInput$);
  const [confirmLoadable, confirmCode] = useLoadableSet(confirmBb0DeviceCode$);
  const confirming = confirmLoadable.state === "loading";
  const confirmed = state.operationStatus === "confirmed";
  const error = loadableErrorMessage(confirmLoadable);

  return (
    <div className="px-6 pt-5 pb-8">
      <div className="flex items-center gap-4">
        <StepIcon src="/onboarding-step3-code-v2.png" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            Confirm device code
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Enter the code shown on BB0&apos;s screen to complete setup. No
            credentials are sent to the device.
          </p>
        </div>
        {confirmed && <CompleteBadge label="Confirmed" />}
      </div>

      <div className="mt-3 pl-16 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Device code
          </span>
          <Input
            value={deviceCode}
            disabled={!state.wifiSent || confirming || confirmed}
            placeholder="ABCD2345"
            inputMode="text"
            autoCapitalize="characters"
            className="max-w-[14rem]"
            onChange={(e) => {
              setDeviceCode(e.target.value);
            }}
          />
        </label>
        <MorandiButton
          className="self-start"
          disabled={!canConfirm || confirming}
          onClick={() => {
            detach(
              confirmCode(pageSignal),
              Reason.DomCallback,
              "confirmBb0DeviceCode",
            );
          }}
        >
          {confirming && <IconLoader size={14} className="animate-spin" />}
          {confirmed ? "Code confirmed" : "Confirm code"}
        </MorandiButton>
        {confirmed && (
          <p className="text-xs leading-5 text-muted-foreground">
            All done! BB0 will check in over Wi-Fi and start working shortly.
          </p>
        )}
        <StepError message={error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unsupported browser fallback
// ---------------------------------------------------------------------------

function UnsupportedBrowser({ reason }: { readonly reason: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <div className="px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-[760px]">
          <div className="zero-card overflow-hidden">
            <div className="flex items-center gap-6 bg-muted/40 px-6 py-7">
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  BB0 setup needs Web Bluetooth
                </h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  Open this page in a Chromium-based browser over HTTPS or
                  localhost to use Web Bluetooth.
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  {reason ?? "Web Bluetooth is not available in this browser."}
                </p>
              </div>
              <img
                src={zeroSrc}
                alt=""
                role="presentation"
                className="hidden sm:block h-20 w-20 shrink-0 object-contain opacity-40"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Bb0DevicePage() {
  const support = useGet(bb0BrowserSupport$);
  const resetPage = useSet(resetBb0Onboarding$);

  if (!support.supported) {
    return <UnsupportedBrowser reason={support.reason} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <div className="px-4 pt-6 pb-14 sm:px-6">
        <div className="mx-auto max-w-[760px] flex flex-col gap-4">
          {/* Hero banner */}
          <HeroSection />

          {/* Step list */}
          <section className="zero-card overflow-hidden">
            <BleConnectStep />
            <hr className="mx-6 border-0 border-t border-border/50" />
            <WifiStep />
            <hr className="mx-6 border-0 border-t border-border/50" />
            <DeviceCodeStep />
          </section>

          {/* Troubleshoot footer */}
          <p className="px-1 text-xs text-muted-foreground">
            Having trouble? Hold <code className="text-foreground">BtnA</code>,
            press <code className="text-foreground">BtnB</code>, then release{" "}
            <code className="text-foreground">BtnA</code> to restart setup mode,
            and{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                resetPage();
              }}
            >
              reset this page
            </button>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
