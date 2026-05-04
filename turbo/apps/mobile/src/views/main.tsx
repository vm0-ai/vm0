import { StrictMode } from "react";
import { StoreProvider } from "ccstate-react";
import { View, Text, StyleSheet } from "react-native";
import { store, bootstrap$, zeroClient$, accept } from "../signals/store.ts";

void bootstrap$;
void zeroClient$;
void accept;

export function App() {
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
});
