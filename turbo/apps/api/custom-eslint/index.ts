import { noLoggerInfo } from "./rules/no-logger-info.ts";

export const apiLintPlugin = {
  meta: {
    name: "api",
    version: "1.0.0",
  },
  rules: {
    "no-logger-info": noLoggerInfo,
  },
};
