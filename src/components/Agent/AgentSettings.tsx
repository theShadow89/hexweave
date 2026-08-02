"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./AgentSettings.module.css";
import { useAgentConfig, setConfig, clearConfig } from "@/lib/agent/configStore";
import { getKeyStore, subscribeKeyStore, type KeyStore, type KeyStoreKind } from "@/lib/agent/keystore";
import { defaultConfig, type AgentProvider } from "@/lib/agent/config";

/**
 * In-app agent configuration (BYOK), unified for web and desktop. Non-secret
 * fields persist via the config store; the API key persists via the keystore
 * (OS keychain on desktop, passphrase-encrypted on web).
 */
export function AgentSettings() {
  const config = useAgentConfig();
  const storeRef = useRef<KeyStore | null>(null);

  const [kind, setKind] = useState<KeyStoreKind | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  const [provider, setProvider] = useState<AgentProvider>(config?.provider ?? "anthropic");
  const [model, setModel] = useState(config?.model ?? defaultConfig("anthropic").model);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? defaultConfig("openai_compatible").baseUrl ?? "");

  const [apiKey, setApiKey] = useState("");
  const [pass, setPass] = useState("");
  const [passConfirm, setPassConfirm] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    setHasKey(await store.hasKey());
    setUnlocked(store.isUnlocked());
  }, []);

  // Resolve keystore once (getKeyStore auto-unlocks the OS backend on desktop).
  useEffect(() => {
    let alive = true;
    getKeyStore().then(async (store) => {
      if (!alive) return;
      storeRef.current = store;
      setKind(store.kind);
      await refresh();
    });
    const unsub = subscribeKeyStore(() => void refresh());
    return () => {
      alive = false;
      unsub();
    };
  }, [refresh]);

  const save = async () => {
    const store = storeRef.current;
    if (!store || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const trimmedModel = model.trim();
      if (!trimmedModel) throw new Error("Model id is required.");
      setConfig(
        provider === "anthropic"
          ? { provider, model: trimmedModel }
          : { provider, model: trimmedModel, baseUrl: baseUrl.trim() },
      );

      const newKey = apiKey.trim();
      if (newKey) {
        if (store.kind === "passphrase") {
          if (!pass) throw new Error("Set a passphrase to encrypt the key.");
          if (pass !== passConfirm) throw new Error("Passphrases do not match.");
        }
        await store.setKey(newKey, pass || undefined);
        setApiKey("");
        setPass("");
        setPassConfirm("");
      }
      await refresh();
      setStatus({ kind: "ok", text: "Settings saved." });
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    const store = storeRef.current;
    if (!store || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const ok = await store.unlock(pass || undefined);
      if (!ok) throw new Error("Wrong passphrase.");
      setPass("");
      setStatus({ kind: "ok", text: "Unlocked." });
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Unlock failed." });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    const store = storeRef.current;
    if (!store || busy) return;
    setBusy(true);
    try {
      await store.clear();
      await refresh();
      setStatus({ kind: "ok", text: "Key removed." });
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    await removeKey();
    clearConfig();
    setProvider("anthropic");
    setModel(defaultConfig("anthropic").model);
  };

  const isPassphrase = kind === "passphrase";
  const locked = hasKey && !unlocked;

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span className={styles.label}>Provider</span>
        <select
          className={styles.select}
          value={provider}
          onChange={(e) => setProvider(e.target.value as AgentProvider)}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai_compatible">OpenAI-compatible (Ollama, LM Studio, ...)</option>
        </select>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Model</span>
        <input
          className={styles.input}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={provider === "anthropic" ? "claude-sonnet-5" : "llama3.1:8b"}
          spellCheck={false}
        />
      </label>

      {provider === "openai_compatible" && (
        <label className={styles.field}>
          <span className={styles.label}>Base URL</span>
          <input
            className={styles.input}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            spellCheck={false}
          />
        </label>
      )}

      {locked ? (
        <>
          <p className={styles.note}>API key stored (locked). Enter your passphrase to use the agent.</p>
          <label className={styles.field}>
            <span className={styles.label}>Passphrase</span>
            <input
              className={styles.input}
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && unlock()}
            />
          </label>
          <button type="button" className={styles.primary} onClick={unlock} disabled={busy || !pass}>
            Unlock
          </button>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.label}>API key {provider === "openai_compatible" && "(optional)"}</span>
            <input
              className={styles.input}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? "•••• stored — leave blank to keep" : "sk-ant-..."}
              spellCheck={false}
            />
          </label>

          {isPassphrase && apiKey.trim() !== "" && (
            <>
              <label className={styles.field}>
                <span className={styles.label}>Passphrase (encrypts the key)</span>
                <input
                  className={styles.input}
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Confirm passphrase</span>
                <input
                  className={styles.input}
                  type="password"
                  value={passConfirm}
                  onChange={(e) => setPassConfirm(e.target.value)}
                />
              </label>
            </>
          )}

          <button type="button" className={styles.primary} onClick={save} disabled={busy}>
            Save settings
          </button>
        </>
      )}

      <p className={styles.note}>
        {kind === "os"
          ? "Key stored in the OS keychain."
          : "Key encrypted with your passphrase and kept only on this device; re-enter each session."}{" "}
        BYOK: the key goes only to the provider, never to Intella.
      </p>

      {(hasKey || config) && (
        <div className={styles.dangerRow}>
          {hasKey && (
            <button type="button" className={styles.ghost} onClick={removeKey} disabled={busy}>
              Remove key
            </button>
          )}
          <button type="button" className={styles.ghost} onClick={removeAll} disabled={busy}>
            Reset agent
          </button>
        </div>
      )}

      {status && (
        <p className={status.kind === "ok" ? styles.ok : styles.err}>{status.text}</p>
      )}
    </div>
  );
}
