export {};

declare global {
  interface Window {
    Clerk?: {
      loaded: boolean;
      organization?: { readonly id: string } | null;
      session?: {
        getToken(options?: {
          readonly skipCache?: boolean;
        }): Promise<string | null>;
      } | null;
    };
  }
}
