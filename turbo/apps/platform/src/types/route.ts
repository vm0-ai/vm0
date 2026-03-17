export type RoutePath =
  | "/"
  | "/select-org"
  | "/zero"
  | "/zero/:tab"
  | "/zero/chat/:sessionId"
  | "/zero/team/:name"
  | `/projects/${string}`;
