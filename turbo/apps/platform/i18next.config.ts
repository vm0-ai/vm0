import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en-US", "pt-BR", "ja-JP", "ko-KR"],
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
    preservePatterns: [
      "onboarding.categories.*",
      "onboarding.make.options.*",
      "onboarding.templates.*.*",
      "onboarding.workflows.*",
    ],
    primaryLanguage: "en-US",
    useTranslationNames: ["useTranslation"],
  },
});
