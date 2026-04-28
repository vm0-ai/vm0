import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconBluetooth,
  IconCheck,
  IconLoader2,
  IconPlugConnected,
  IconRefresh,
  IconWifi,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
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

function LoadingIcon({ visible }: { readonly visible: boolean }) {
  if (!visible) {
    return null;
  }
  return <IconLoader2 size={16} className="animate-spin" />;
}

function loadableErrorMessage(loadable: {
  readonly state: string;
  readonly error?: unknown;
}): string | null {
  if (loadable.state !== "hasError") {
    return null;
  }
  return loadable.error instanceof Error
    ? loadable.error.message
    : "bb0 setup failed.";
}

function StepError({ message }: { readonly message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {message}
    </div>
  );
}

function StepCard({
  number,
  icon,
  title,
  description,
  children,
}: {
  readonly number: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="zero-card overflow-hidden">
      <div className="flex items-start gap-4 border-b border-border bg-muted/30 px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
          {number}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {icon}
            {title}
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

function UnsupportedBrowser({ reason }: { readonly reason: string | null }) {
  return (
    <main className="flex min-h-0 flex-1 overflow-auto px-4 py-10 sm:px-6">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
        <div className="rounded-[2rem] border border-border bg-[linear-gradient(135deg,hsl(var(--card)),hsl(var(--muted)))] p-8 shadow-sm">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background">
            <IconBluetooth size={24} stroke={1.6} />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">
            bb0 setup needs Web Bluetooth
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Open this page in a Chromium-based browser over HTTPS or localhost.
            The page is blocked before provisioning because bb0 setup depends on{" "}
            <code>navigator.bluetooth</code>.
          </p>
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {reason ?? "Web Bluetooth is not available in this browser."}
          </div>
        </div>
      </div>
    </main>
  );
}

function Bb0Hero() {
  const state = useGet(bb0ProvisioningState$);
  const connected = state.connectionStatus === "connected";

  return (
    <header className="px-4 pb-5 pt-8 sm:px-6">
      <div className="mx-auto max-w-[760px]">
        <div className="overflow-hidden rounded-[2rem] border border-border bg-card shadow-sm">
          <div className="relative px-6 py-7 sm:px-8">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(20,184,166,0.18),transparent_28%),radial-gradient(circle_at_80%_0%,rgba(251,191,36,0.16),transparent_24%)]" />
            <div className="relative">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground">
                <IconPlugConnected size={14} />
                {connected ? "bb0 connected" : "bb0 setup"}
              </div>
              <h1 className="mt-5 text-3xl font-semibold tracking-tight text-foreground">
                Set up bb0
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                Connect over Bluetooth, send Wi-Fi, then enter the device code
                shown on bb0. After that, bb0 finishes setup by polling the API
                over Wi-Fi.
              </p>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

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
    <StepCard
      number="1"
      icon={<IconBluetooth size={18} stroke={1.6} />}
      title="Connect bb0"
      description="Put bb0 into setup mode, then choose the nearby Zero-Buddy device."
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm leading-6 text-muted-foreground">
          Browser filter:{" "}
          <code className="text-xs text-foreground">Zero-Buddy-*</code>
          <br />
          Service UUID:{" "}
          <code className="break-all text-xs text-foreground">
            {BB0_PROVISIONING_SERVICE_UUID}
          </code>
        </div>
        {connected ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Connected to {info.name ?? "bb0"}.
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={connecting || connected}
            onClick={() => {
              detach(
                connect({ acceptAllDevices: false }, pageSignal),
                Reason.DomCallback,
                "connectBb0Device",
              );
            }}
          >
            <LoadingIcon visible={connecting} />
            {connected ? "Connected" : "Connect bb0"}
          </Button>
          {connected ? (
            <Button
              variant="outline"
              disabled={connecting}
              onClick={() => {
                disconnect();
              }}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      <StepError message={error} />
    </StepCard>
  );
}

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
    <StepCard
      number="2"
      icon={<IconWifi size={18} stroke={1.6} />}
      title="Send Wi-Fi"
      description="Write Wi-Fi credentials over BLE. bb0 closes Bluetooth after receiving them."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm font-medium">
          Wi-Fi SSID
          <Input
            value={ssid}
            disabled={!connected || sendingWifi || state.wifiSent}
            placeholder="Zero-Lab"
            onChange={(event) => {
              setSsid(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-2 text-sm font-medium">
          Wi-Fi password
          <Input
            type="password"
            value={password}
            disabled={!connected || sendingWifi || state.wifiSent}
            placeholder="Leave empty for open network"
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={!canSendWifi || sendingWifi || state.wifiSent}
          onClick={() => {
            detach(
              sendWifi(pageSignal),
              Reason.DomCallback,
              "sendBb0WifiCredentials",
            );
          }}
        >
          <LoadingIcon visible={sendingWifi} />
          {state.wifiSent ? "Wi-Fi sent" : "Send Wi-Fi"}
        </Button>
        <Button
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
          <LoadingIcon visible={refreshing} />
          <IconRefresh size={16} />
          Refresh BLE status
        </Button>
      </div>
      {state.wifiSent ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Wi-Fi password sent. Check the bb0 screen; the device will connect to
          Wi-Fi and display a code.
        </p>
      ) : null}
      <StepError message={error} />
    </StepCard>
  );
}

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
    <StepCard
      number="3"
      icon={<IconCheck size={18} stroke={1.6} />}
      title="Enter device code"
      description="Read the code from bb0's screen and confirm it here."
    >
      <label className="flex flex-col gap-2 text-sm font-medium">
        Device code
        <Input
          value={deviceCode}
          disabled={!state.wifiSent || confirming || confirmed}
          placeholder="ABCD-2345"
          inputMode="text"
          autoCapitalize="characters"
          onChange={(event) => {
            setDeviceCode(event.target.value);
          }}
        />
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={!canConfirm || confirming}
          onClick={() => {
            detach(
              confirmCode(pageSignal),
              Reason.DomCallback,
              "confirmBb0DeviceCode",
            );
          }}
        >
          <LoadingIcon visible={confirming} />
          {confirmed ? "Code confirmed" : "Confirm code"}
        </Button>
      </div>
      {confirmed ? (
        <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Code confirmed. bb0 will receive its token and thread ID through its
          own Wi-Fi polling flow.
        </p>
      ) : (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          This page does not send a PAT to the device. It only approves the
          visible code for your current account.
        </p>
      )}
      <StepError message={error} />
    </StepCard>
  );
}

function ResetHelp() {
  const resetPage = useSet(resetBb0Onboarding$);

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-900">
      <div className="font-semibold">If anything goes wrong, reset bb0.</div>
      <p className="mt-2">
        Hold <code>BtnA</code>, press <code>BtnB</code> once, then release{" "}
        <code>BtnA</code>. After bb0 returns to setup mode, reset this page and
        start from step 1.
      </p>
      <Button
        className="mt-4"
        variant="outline"
        onClick={() => {
          resetPage();
        }}
      >
        <IconRefresh size={16} />
        Reset page state
      </Button>
    </section>
  );
}

export function Bb0DevicePage() {
  const support = useGet(bb0BrowserSupport$);

  if (!support.supported) {
    return <UnsupportedBrowser reason={support.reason} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <Bb0Hero />
      <main className="px-4 pb-14 sm:px-6">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5">
          <BleConnectStep />
          <WifiStep />
          <DeviceCodeStep />
          <ResetHelp />
        </div>
      </main>
    </div>
  );
}
