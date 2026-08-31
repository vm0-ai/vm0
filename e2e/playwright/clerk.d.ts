export {};

declare global {
  interface Window {
    Clerk?: {
      loaded: boolean;
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
