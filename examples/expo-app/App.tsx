import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { exitPreview, handlePreviewUrl } from "flare-ota/expo";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

// Edit this line, then `npx flare-ota publish`: the app shows the new text after two launches.
const RELEASE_NOTE = "Hello from the embedded bundle";

export default function App() {
  const url = Linking.useURL();
  const [status, setStatus] = useState("");

  // Scanning a preview QR code opens flareotaexample://flare-ota/preview?token=…
  useEffect(() => {
    handlePreviewUrl(url).catch((error: Error) => setStatus(error.message));
  }, [url]);

  async function checkNow() {
    try {
      setStatus("Checking…");
      const result = await Updates.fetchUpdateAsync();
      if (result.isNew) await Updates.reloadAsync();
      else setStatus("Already up to date.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.note}>{RELEASE_NOTE}</Text>
      <Text style={styles.meta}>
        {Updates.isEmbeddedLaunch ? "Running the embedded bundle" : `Update ${Updates.updateId}`}
        {"\n"}channel {Updates.channel ?? "?"} · runtime {Updates.runtimeVersion?.slice(0, 12) ?? "?"}
      </Text>
      <Pressable style={styles.button} onPress={checkNow}>
        <Text style={styles.buttonText}>Check for update now</Text>
      </Pressable>
      <Pressable style={styles.button} onPress={() => exitPreview().catch((e: Error) => setStatus(e.message))}>
        <Text style={styles.buttonText}>Exit preview</Text>
      </Pressable>
      {status ? <Text style={styles.meta}>{status}</Text> : null}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  note: { fontSize: 24, fontWeight: "600", textAlign: "center" },
  meta: { fontSize: 13, color: "#666", textAlign: "center" },
  button: { backgroundColor: "#ea580c", paddingHorizontal: 18, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: "white", fontWeight: "600" },
});
