import { useLastLoadable } from "ccstate-react";

import { connectorCatalogStatusByRef$ } from "../../signals/external/connectors.ts";
import { ZeroConnectorCallbackPage } from "./zero-connector-callback-page.tsx";

export function FeishuOAuthCallbackPage(): React.JSX.Element {
  const catalogLoadable = useLastLoadable(connectorCatalogStatusByRef$);
  const connectorIcon =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.get("lark")?.icon
      : undefined;

  return (
    <ZeroConnectorCallbackPage
      connectorIcon={connectorIcon}
      connectorLabel="Feishu"
      status="loading"
      username={null}
      errorMessage={null}
    />
  );
}
