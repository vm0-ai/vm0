import { init as initElectronSentry, setTags } from "@sentry/electron/renderer";
import { init as initReactSentry } from "@sentry/react";

export function initRendererSentry(): void {
  initElectronSentry(
    {
      sendDefaultPii: false,
      tracesSampleRate: 0,
    },
    initReactSentry,
  );
  setTags({
    app: "desktop",
    component: "electron-renderer",
  });
}
