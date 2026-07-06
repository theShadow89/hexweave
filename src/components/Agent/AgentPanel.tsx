"use client";

import { useEffect, useState } from "react";
import styles from "./AgentPanel.module.css";
import type { AgentMode } from "@/lib/agent/prompts";
import type { AgentConfigStatus } from "@/lib/agent/config";
import type Anthropic from "@anthropic-ai/sdk";

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
  const [config, setConfig] = useState<AgentConfigStatus | null>(null);
  const [mode, setMode] = useState<AgentMode>("chat-config");
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<AgentTurn[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/agent/config")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((data: AgentConfigStatus) => setConfig(data))
      .catch(() => setConfig({ enabled: false }));
  }, []);

  if (!config || !config.enabled) return null;

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    const userTurn: AgentTurn = { role: "user", text: message };
    setHistory((h) => [...h, userTurn]);
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          messages: [{ role: "user", content: message }],
          context,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setHistory((h) => [
          ...h,
          { role: "assistant", text: "", error: json.error ?? `Error ${res.status}` },
        ]);
        return;
      }

      const content = json.content as Anthropic.ContentBlock[];
      const toolCalls: ToolCall[] = [];
      let text = "";
      for (const block of content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
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
        {
          role: "assistant",
          text: "",
          error: err instanceof Error ? err.message : "Network error.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0];

  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>Agent</div>
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
    </div>
  );
}
