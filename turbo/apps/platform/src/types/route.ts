export type RoutePath =
  | "/"
  | "/logs"
  | "/logs/:id"
  | "/settings"
  | "/settings/slack"
  | "/agents"
  | "/environment-variables-setup"
  | `/projects/${string}`;
