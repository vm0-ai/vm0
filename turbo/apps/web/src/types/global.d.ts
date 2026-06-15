export type DesktopAuthBridge = {
  readonly completeSignIn?: (params: {
    readonly token: string;
  }) => Promise<void>;
};

declare global {
  interface Window {
    readonly vm0DesktopAuth?: DesktopAuthBridge;
  }
}
