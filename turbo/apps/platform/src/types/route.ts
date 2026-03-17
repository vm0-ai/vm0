export type RoutePath =
  | "/"
  | "/select-org"
  | "/:tab"
  | "/chat/:sessionId"
  | "/team/:name"
  | "/talk/:name"
  | "/slack/connect"
  | `/projects/${string}`;
