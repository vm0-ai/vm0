export {};

declare global {
  interface Window {
    Clerk?: {
      loaded: boolean;
      readonly publishableKey: string;
      user?: { readonly id: string } | null;
      organization?: { readonly id: string } | null;
      setActive(options: { readonly organization: string }): Promise<void>;
      session?: {
        getToken(options?: {
          readonly skipCache?: boolean;
        }): Promise<string | null>;
      } | null;
    };
  }
}
