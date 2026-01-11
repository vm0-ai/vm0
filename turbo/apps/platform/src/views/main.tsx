import type { Store } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { StrictMode, useEffect, useState } from "react";
import { IntlProvider } from "react-intl";
import { ErrorBoundary } from "./error-boundary.tsx";
import { Router } from "./router.tsx";
import "./css/index.css";
import { detectLocale, loadMessages, DEFAULT_LOCALE } from "../lib/locale.ts";
import type { Locale } from "../lib/locale.ts";

function I18nWrapper({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function initializeI18n() {
      try {
        // Wait for Clerk to load (if available globally)
        const clerk = (window as any).Clerk;
        if (clerk) {
          await clerk.load();
        }

        // Detect locale
        const detectedLocale = await detectLocale(clerk?.user);

        // Load messages
        const loadedMessages = await loadMessages(detectedLocale);

        setLocale(detectedLocale);
        setMessages(loadedMessages);
      } catch (error) {
        console.error("Failed to initialize i18n:", error);
        // Fallback to default
        const defaultMessages = await loadMessages(DEFAULT_LOCALE);
        setMessages(defaultMessages);
      } finally {
        setIsLoading(false);
      }
    }

    initializeI18n();
  }, []);

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      {children}
    </IntlProvider>
  );
}

export const setupRouter = (
  store: Store,
  render: (children: React.ReactNode) => void,
) => {
  render(
    <StrictMode>
      <StoreProvider value={store}>
        <I18nWrapper>
          <ErrorBoundary>
            <Router />
          </ErrorBoundary>
        </I18nWrapper>
      </StoreProvider>
    </StrictMode>,
  );
};
