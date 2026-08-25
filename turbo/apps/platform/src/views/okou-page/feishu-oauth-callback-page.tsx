import { useLastLoadable } from "ccstate-react";

import { connectorCatalogStatusBySlug$ } from "../../signals/external/connectors.ts";
import { ConnectorCallbackPage } from "./connector-callback-page.tsx";

export function FeishuOAuthCallbackPage(): React.JSX.Element {
  const catalogLoadable = useLastLoadable(connectorCatalogStatusBySlug$);
  const connectorIcon =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.get("lark")?.icon
      : undefined;

  return (
    <ConnectorCallbackPage
      connectorIcon={connectorIcon}
      connectorLabel="Feishu"
      status="loading"
      username={null}
      errorMessage={null}
    />
  );
}
