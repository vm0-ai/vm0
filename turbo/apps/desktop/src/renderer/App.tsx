import { useEffect } from "react";
import { IconAlertCircle } from "@tabler/icons-react";
import { useLastLoadable, useSet } from "ccstate-react";
import type { DesktopAuthState } from "../desktop-bridge";
import { hasReadyDesktopAuth } from "../computer-use-startup-gate";
import {
  hasRequiredComputerUsePermissions,
  type DesktopComputerUseState,
} from "../computer-use-types";
import {
  computerUseData$,
  developerToolsData$,
  desktopAuthData$,
  hasDesktopComputerUseBridge,
  hasDesktopDeveloperToolsBridge,
  setupComputerUseBridge$,
} from "./computer-use-state";
import { Panel, ZeroFace } from "./components";
import { ReadyExperience } from "./hero";
import {
  AuthStepCard,
  PermissionAutoRefresh,
  PermissionsStepCard,
} from "./setup-wizard";

function BridgeSubscription() {
  const setupBridge = useSet(setupComputerUseBridge$);
  useEffect(() => {
    if (!hasDesktopComputerUseBridge()) {
      return undefined;
    }
    const controller = new AbortController();
    setupBridge(controller.signal);
    return () => {
      controller.abort();
    };
  }, [setupBridge]);
  return null;
}

function UnsupportedPanel({ platform }: { readonly platform: string }) {
  return (
    <Panel title="Unsupported Platform" icon={<IconAlertCircle size={18} />}>
      <div className="empty-state">
        Computer Use is available on macOS. Current platform: {platform}.
      </div>
    </Panel>
  );
}

function StartupLoadingScreen() {
  return (
    <section className="startup-loading" aria-live="polite">
      <ZeroFace className="zero-face-init" size={92} />
      <div className="loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2 className="startup-loading-title">Preparing</h2>
    </section>
  );
}

function ComputerUseContent({
  authLoading,
  authState,
  developerToolsEnabled,
  state,
}: {
  readonly authLoading: boolean;
  readonly authState: DesktopAuthState | null;
  readonly developerToolsEnabled: boolean;
  readonly state: DesktopComputerUseState;
}) {
  const authReady = hasReadyDesktopAuth(authState);
  const permissionsReady = hasRequiredComputerUsePermissions(state.permissions);

  if (!state.supported) {
    return <UnsupportedPanel platform={state.platform} />;
  }

  if (authReady && permissionsReady) {
    return (
      <ReadyExperience
        authState={authState}
        developerToolsEnabled={developerToolsEnabled}
        state={state}
      />
    );
  }

  return (
    <>
      <AuthStepCard authLoading={authLoading} authState={authState} />
      <PermissionsStepCard authReady={authReady} state={state} />
      <PermissionAutoRefresh />
    </>
  );
}

function ComputerUsePage() {
  const loadable = useLastLoadable(computerUseData$);
  const authLoadable = useLastLoadable(desktopAuthData$);
  const developerToolsLoadable = useLastLoadable(developerToolsData$);
  const authState = authLoadable.state === "hasData" ? authLoadable.data : null;
  const authLoading = authLoadable.state === "loading";
  const authInitialLoading = authLoading && authState === null;
  const developerToolsEnabled =
    hasDesktopDeveloperToolsBridge() &&
    developerToolsLoadable.state === "hasData" &&
    developerToolsLoadable.data.available &&
    developerToolsLoadable.data.enabled;

  if (!hasDesktopComputerUseBridge()) {
    return (
      <Panel title="Desktop Bridge" icon={<IconAlertCircle size={18} />}>
        <div className="empty-state">Desktop bridge unavailable.</div>
      </Panel>
    );
  }

  if (loadable.state === "hasData") {
    if (authInitialLoading) {
      return <StartupLoadingScreen />;
    }

    return (
      <ComputerUseContent
        authLoading={authLoading}
        authState={authState}
        developerToolsEnabled={developerToolsEnabled}
        state={loadable.data}
      />
    );
  }

  if (loadable.state === "hasError") {
    return (
      <Panel title="Computer Use" icon={<IconAlertCircle size={18} />}>
        <div className="inline-alert">
          <IconAlertCircle size={16} />
          <span>
            {loadable.error instanceof Error
              ? loadable.error.message
              : String(loadable.error)}
          </span>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Computer Use">
      <div className="empty-state">Loading...</div>
    </Panel>
  );
}

function Header() {
  return (
    <header className="app-header">
      <div className="titlebar-title">
        <h1>Zero Computer Use</h1>
      </div>
    </header>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <BridgeSubscription />
      <Header />
      <main className="content">
        <ComputerUsePage />
      </main>
    </div>
  );
}
