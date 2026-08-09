import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import {
  EndpointAddr,
  EndpointBuilder,
  EndpointId,
  type EndpointLike,
} from "react-native-iroh-ffi";

/**
 * Dev probe — phase 1 of the iroh integration plan. Proves the published
 * react-native-iroh-ffi alpha coexists with the app's native tree
 * (react-native-webrtc, Pierre, nitro, expo-dom …) and that bind /
 * dial-by-EndpointId / echo work from inside Thinkite. No product code
 * touches this; the desktop peer is `desktop-peer/echo-peer.mjs` in the
 * yyq1025/react-native-iroh-ffi repo.
 */

const ALPN = "iroh-ffi/echo/0";
const toBuf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0)).buffer;
const fromBuf = (b: ArrayBuffer) =>
  String.fromCharCode(...Array.from(new Uint8Array(b)));

export default function IrohProbe() {
  const [status, setStatus] = useState("binding endpoint…");
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState(
    "13cbe359542f23128919c869218bf4479204fd408b97f5383cb9bac5eee15b27",
  );
  const [log, setLog] = useState<string[]>([]);
  const epRef = useRef<EndpointLike | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const builder = new EndpointBuilder();
        builder.applyN0();
        const endpoint = await builder.bind();
        epRef.current = endpoint;
        if (!cancelled) {
          setEndpointId(endpoint.id().toString());
          setStatus("iroh endpoint bound ✅");
        }
      } catch (e) {
        if (!cancelled) setStatus(`bind FAILED: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      epRef.current?.close().catch(() => {});
      epRef.current = null;
    };
  }, []);

  const runEcho = async () => {
    const ep = epRef.current;
    if (!ep) return;
    const push = (line: string) => setLog((prev) => [...prev, line]);
    setLog([]);
    try {
      const remote = EndpointId.fromString(peerId.trim());
      const addr = new EndpointAddr(remote, undefined, []);
      push("connecting…");
      const t0 = Date.now();
      const conn = await ep.connect(addr, toBuf(ALPN));
      push(`connected in ${Date.now() - t0}ms`);
      const bi = await conn.openBi();
      const msg = `ping from Thinkite @${new Date().toISOString()}`;
      const send = bi.send();
      await send.writeAll(toBuf(msg));
      await send.finish();
      push(`sent: ${msg}`);
      const reply = await bi.recv().readToEnd(65536);
      push(`recv: ${fromBuf(reply)}`);
      push("echo roundtrip ✅");
    } catch (e) {
      push(`FAILED: ${String(e)}`);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "iroh probe" }} />
      <Text style={styles.status}>{status}</Text>
      {endpointId && <Text style={styles.mono}>this device: {endpointId}</Text>}
      <TextInput
        style={styles.input}
        value={peerId}
        onChangeText={setPeerId}
        placeholder="desktop peer EndpointId"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        style={[styles.button, !endpointId && styles.buttonDisabled]}
        onPress={runEcho}
        disabled={!endpointId}
      >
        <Text style={styles.buttonText}>Connect & Echo</Text>
      </Pressable>
      {log.map((line, i) => (
        <Text key={i} style={styles.mono}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 10 },
  status: { fontSize: 16, fontWeight: "600" },
  mono: { fontSize: 12, fontFamily: "Menlo" },
  input: {
    borderWidth: 1,
    borderColor: "#8884",
    borderRadius: 8,
    padding: 10,
    fontSize: 11,
    fontFamily: "Menlo",
  },
  button: {
    backgroundColor: "#007AFF",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
