export type DesktopAuthBridge = {
  readonly completeSignIn?: (params: {
    readonly token: string;
  }) => Promise<void>;
};

declare global {
  interface Window {
    readonly vm0DesktopAuth?: DesktopAuthBridge;
    // Plausible analytics queue, bootstrapped in app/layout.tsx.
    plausible?: (
      event: string,
      options?: { props?: Record<string, unknown> },
    ) => void;
  }
}
