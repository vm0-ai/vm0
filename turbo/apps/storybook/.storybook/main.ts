import type { StorybookConfig } from "@storybook/react-vite";
import { dirname, resolve } from "path";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-themes",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  docs: {
    autodocs: "tag",
  },
  viteFinal: async (config) => {
    const rootDir = resolve(dirname(import.meta.url.replace("file://", "")), "..");
    return {
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
          "@": resolve(rootDir, "../../packages/ui/src"),
        },
      },
    };
  },
};

export default config;
