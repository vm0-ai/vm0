"use client";

import { ReactNode } from "react";
import { IntlProvider } from "react-intl";

// Type workaround for React 19 compatibility with react-intl
// react-intl has React 18 types but works fine with React 19 runtime
const IntlProviderCompat = IntlProvider as unknown as React.ComponentType<{
  locale: string;
  messages: Record<string, string>;
  defaultLocale?: string;
  children: ReactNode;
}>;

type Props = {
  locale: string;
  messages: Record<string, string>;
  children: ReactNode;
};

export function IntlProviderWrapper({ locale, messages, children }: Props) {
  return (
    <IntlProviderCompat locale={locale} messages={messages} defaultLocale="en">
      {children}
    </IntlProviderCompat>
  );
}
