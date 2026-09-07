import { useLoadableSet } from "ccstate-react/experimental";
import type { ComposerConnectorSignals } from "../../signals/okou-page/connectors.ts";
import {
  connectConnectorNoAuthAndSettle$,
  connectConnectorOAuthAuthCodeAndSettle$,
} from "../../signals/okou-page/settings/connectors.ts";

export function useComposerConnectorActions(signals: ComposerConnectorSignals) {
  const [authorization, setAuthorization] = useLoadableSet(
    signals.setConnectorAuthorization$,
  );
  const [account, selectAccount] = useLoadableSet(
    signals.accounts.selectAccount$,
  );
  const [defaultAccount, useDefaultAccount] = useLoadableSet(
    signals.accounts.useDefault$,
  );
  const [browserAuth, connectBrowserAuth] = useLoadableSet(
    connectConnectorOAuthAuthCodeAndSettle$,
  );
  const [noAuth, connectNoAuth] = useLoadableSet(
    connectConnectorNoAuthAndSettle$,
  );
  return {
    savingAuthorization: authorization.state === "loading",
    setAuthorization,
    savingAccount:
      account.state === "loading" || defaultAccount.state === "loading",
    selectAccount,
    useDefaultAccount,
    connecting: browserAuth.state === "loading" || noAuth.state === "loading",
    connectBrowserAuth,
    connectNoAuth,
  };
}

export type ComposerConnectorActions = ReturnType<
  typeof useComposerConnectorActions
>;
