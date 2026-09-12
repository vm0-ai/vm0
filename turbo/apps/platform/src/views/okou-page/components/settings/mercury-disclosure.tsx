import { cn } from "@okouai/ui";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

export function MercuryDisclosure({
  className,
}: {
  readonly className?: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return $.connectors.callback.mercuryDisclosureLabel;
      })}
      className={cn(
        "space-y-1 text-xs leading-5 text-muted-foreground",
        className,
      )}
    >
      <a
        href="https://mercury.com"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-foreground underline decoration-border underline-offset-4 hover:text-brand-text"
      >
        {t(($) => {
          return $.connectors.callback.mercuryAttribution;
        })}
      </a>
      <p>
        {t(($) => {
          return $.connectors.callback.mercuryDisclosure;
        })}
      </p>
    </section>
  );
}
