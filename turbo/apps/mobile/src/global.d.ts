/// <reference types="react-native" />

type ImportMetaEnv = {
  readonly EXPO_PUBLIC_API_URL?: string;
  readonly EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
};

type ImportMeta = {
  readonly env: ImportMetaEnv;
};
