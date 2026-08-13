"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AgentPanel.module.css";
import type { AgentMode } from "@/lib/agent/prompts";
import type { ContentBlock } from "@/lib/agent/types";
import { useAgentConfig } from "@/lib/agent/configStore";
import { getKeyStore, subscribeKeyStore, type KeyStore } from "@/lib/agent/keystore";
import { runAgent } from "@/lib/agent/runAgent";

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentTurn {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ToolCall[];
  error?: string;
}

export interface AgentPanelProps {
  /** Snapshot of current page state for the agent to read. */
  context: unknown;
  /** Called for every tool the agent emits; the page applies it. */
  onToolCall: (call: ToolCall) => void;
}

const MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: "chat-config", label: "Chat", hint: "I'll fill the form from your description." },
  { id: "optimizer", label: "Optimize", hint: "I'll tweak your config to fit better." },
  { id: "end-to-end", label: "End-to-end", hint: "I'll set everything from a brief." },
];

export function AgentPanel({ context, onToolCall }: AgentPanelProps) {
  const config = useAgentConfig();
  const storeRef = useRef<KeyStore | null>(null);
  const [ready, setReady] = useState(false); // key present and unlocked

  const [mode, setMode] = useState<AgentMode>("chat-config");
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<AgentTurn[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const store = storeRef.current;
      if (store && alive) setReady((await store.hasKey()) && store.isUnlocked());
    };
    getKeyStore().then((store) => {
      if (!alive) return;
      storeRef.current = store;
      void refresh();
    });
    const unsub = subscribeKeyStore(() => void refresh());
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0];

  if (!config) {
    return <p className={styles.empty}>Configure a provider and API key above to use the agent.</p>;
  }
  if (!ready) {
    return <p className={styles.empty}>Add or unlock your API key above to use the agent.</p>;
  }

  const send = async () => {
    const message = input.trim();
    const store = storeRef.current;
    if (!message || busy || !store) return;
    const apiKey = store.getKey();
    if (!apiKey && config.provider === "anthropic") {
      setHistory((h) => [...h, { role: "assistant", text: "", error: "API key is locked." }]);
      return;
    }
    setInput("");
    setHistory((h) => [...h, { role: "user", text: message }]);
    setBusy(true);
    try {
      const { content } = await runAgent({
        config,
        apiKey: apiKey ?? "",
        mode,
        message,
        context,
      });
      const toolCalls: ToolCall[] = [];
      let text = "";
      for (const block of content as ContentBlock[]) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use")
          toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
      for (const call of toolCalls) onToolCall(call);
      setHistory((h) => [
        ...h,
        {
          role: "assistant",
          text: text || (toolCalls.length > 0 ? "(applied changes)" : ""),
          toolCalls,
        },
      ]);
    } catch (err) {
      setHistory((h) => [
        ...h,
        { role: "assistant", text: "", error: err instanceof Error ? err.message : "Request failed." },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.tabs}>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`${styles.tab} ${mode === m.id ? styles.tabActive : ""}`}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className={styles.hint}>{activeMode.hint}</p>

      <div className={styles.history}>
        {history.length === 0 && <p className={styles.empty}>No messages yet.</p>}
        {history.map((turn, i) => (
          <div
            key={i}
            className={`${styles.turn} ${turn.role === "user" ? styles.user : styles.assistant}`}
          >
            <div className={styles.role}>{turn.role}</div>
            {turn.text && <div className={styles.text}>{turn.text}</div>}
            {turn.toolCalls && turn.toolCalls.length > 0 && (
              <ul className={styles.toolList}>
                {turn.toolCalls.map((tc) => (
                  <li key={tc.id} className={styles.toolItem}>
                    <code>{tc.name}</code> {JSON.stringify(tc.input)}
                  </li>
                ))}
              </ul>
            )}
            {turn.error && <div className={styles.error}>{turn.error}</div>}
          </div>
        ))}
      </div>

      <textarea
        className={styles.input}
        rows={3}
        placeholder={
          mode === "chat-config"
            ? "e.g. 'rectangular wall 60x40 cm on Bambu A1, 3 mm border'"
            : mode === "optimizer"
              ? "e.g. 'shrink to fit on the Kobra S1' or 'use a thinner border'"
              : "e.g. 'tool storage 80x100 cm for my garage, M3 hooks, Prusa MK4'"
        }
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
        }}
        disabled={busy}
      />
      <button
        type="button"
        className={styles.send}
        onClick={send}
        disabled={busy || !input.trim()}
      >
        {busy ? "Thinking..." : "Send (Cmd/Ctrl+Enter)"}
      </button>
    </div>
  );
}
