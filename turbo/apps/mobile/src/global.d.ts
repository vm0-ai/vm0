/// <reference types="react-native" />

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMetaEnv {
  readonly EXPO_PUBLIC_API_URL?: string;
  readonly EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
