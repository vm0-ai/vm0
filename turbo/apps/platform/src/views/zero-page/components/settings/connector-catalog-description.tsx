import { AnimatedNumber } from "@vm0/ui";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";

const WARMUP_MIN = 300;
const WARMUP_MAX = 400;
const CONNECTOR_COUNT_MARKER = "\uFFFC";

interface ConnectorCatalogDescriptionProps {
  connectorCount: number | null;
}

function ConnectorCatalogDescription({
  connectorCount,
}: ConnectorCatalogDescriptionProps) {
  const { t } = useTranslation();
  const countDescription = t(
    ($) => {
      return $.connectors.catalog.descriptionWithCount;
    },
    { value: CONNECTOR_COUNT_MARKER },
  );
  const [beforeCount, afterCount] = countDescription.split(
    CONNECTOR_COUNT_MARKER,
  );
  const accessibleDescription =
    connectorCount === null
      ? t(($) => {
          return $.connectors.catalog.description;
        })
      : t(
          ($) => {
            return $.connectors.catalog.descriptionWithCount;
          },
          { value: formatLocalizedNumber(connectorCount) },
        );

  return (
    <p
      className="mt-0.5 text-sm text-muted-foreground"
      aria-label={accessibleDescription}
      aria-live="polite"
    >
      <span aria-hidden="true">
        {beforeCount}
        <AnimatedNumber
          value={connectorCount}
          formatValue={formatLocalizedNumber}
          pendingTargetRange={[WARMUP_MIN, WARMUP_MAX]}
          className="font-semibold text-foreground"
        />
        {afterCount}
      </span>
    </p>
  );
}

export { ConnectorCatalogDescription };
