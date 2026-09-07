import type { OAuthStrategy } from "@clerk/react/types";

export function AuthV2OAuthIcon({
  strategy,
}: {
  readonly strategy: Extract<OAuthStrategy, "oauth_apple" | "oauth_google">;
}) {
  if (strategy === "oauth_apple") {
    return (
      <svg
        aria-hidden="true"
        className="size-4 shrink-0 fill-current"
        viewBox="0 0 24 24"
      >
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.22.06 2.07.67 2.79.72 1.08-.22 2.11-.85 3.27-.77 1.39.11 2.44.66 3.13 1.65-2.87 1.72-2.19 5.5.44 6.56-.53 1.4-1.21 2.79-1.63 4.81ZM12.03 7.25C11.88 5.17 13.58 3.45 15.52 3.28c.27 2.4-2.18 4.2-3.49 3.97Z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="size-4 shrink-0" viewBox="0 0 24 24">
      <path
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.89h5.38a4.6 4.6 0 0 1-1.99 3.02v2.53h3.23c1.89-1.74 2.98-4.3 2.98-7.38Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.96-.89 6.62-2.39l-3.23-2.53c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.07v2.61A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.4 13.92A6 6 0 0 1 6.09 12c0-.67.11-1.32.31-1.92V7.47H3.07A10 10 0 0 0 2 12c0 1.63.39 3.17 1.07 4.53l3.33-2.61Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.96c1.47 0 2.79.51 3.83 1.5l2.87-2.88A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.93 5.47l3.33 2.61C7.19 7.72 9.4 5.96 12 5.96Z"
        fill="#EA4335"
      />
    </svg>
  );
}
