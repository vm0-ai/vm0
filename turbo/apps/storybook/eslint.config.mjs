import { config } from "@vm0/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config} */
export default [{ ignores: ["storybook-static/**"] }, ...config];
