import { StrictMode, useEffect, useState } from "react";
import { createStore, type Store } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { View, Text, StyleSheet } from "react-native";
import { bootstrap$ } from "../signals/bootstrap.ts";
import { detach, Reason } from "../signals/utils.ts";

function LoadingFallback() {
  return (
    <View style={styles.centered}>
      <Text>Loading...</Text>
    </View>
  );
}

function AppShell() {
  const [store] = useState<Store>(() => {
    return createStore();
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const rootSignal = AbortSignal.any([]);
    const run = async () => {
      await store.set(bootstrap$, () => {
        setReady(true);
      }, rootSignal);
    };
    detach(run(), Reason.Entrance, "main");
    return () => {
      // rootSignal is permanent — no cleanup needed at app level
    };
  }, [store]);

  if (!ready) {
    return <LoadingFallback />;
  }

  return (
    <StrictMode>
      <StoreProvider value={store}>
        <View style={styles.container}>
          <Text>vm0 Mobile</Text>
        </View>
      </StoreProvider>
    </StrictMode>
  );
}

export function App() {
  return <AppShell />;
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
});
