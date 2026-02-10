export type RoutePath =
  | "/"
  | "/logs"
  | "/logs/:id"
  | "/settings"
  | "/agents"
  | "/environment-variables-setup"
  | `/projects/${string}`;
