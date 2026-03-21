export type RoutePath =
  | "/"
  | "/select-org"
  | "/:tab"
  | "/activity"
  | "/activity/:logId"
  | "/chat/:sessionId"
  | "/team"
  | "/team/:name"
  | "/talk/:name"
  | "/slack/connect"
  | "/queue"
  | "/__internal-connector-logos"
  | `/projects/${string}`;
