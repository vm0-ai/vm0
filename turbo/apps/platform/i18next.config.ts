import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en-US", "zh-CN"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    ignore: [
      "src/**/__tests__/**",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
      "src/mocks/**",
      "src/test/**",
    ],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
    defaultNS: "common",
    functions: ["i18n.t"],
    primaryLanguage: "en-US",
    useTranslationNames: ["useTranslation"],
  },
});
