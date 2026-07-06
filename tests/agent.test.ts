import { describe, it, expect } from "vitest";
import { AGENT_TOOLS } from "@/lib/agent/tools";
import { SYSTEM_PROMPTS } from "@/lib/agent/prompts";

describe("agent tool schemas", () => {
  for (const t of AGENT_TOOLS) {
    describe(t.name, () => {
      it("has a non-empty name", () => {
        expect(typeof t.name).toBe("string");
        expect(t.name.length).toBeGreaterThan(0);
      });

      it("has a description at least 10 chars", () => {
        expect(typeof t.description).toBe("string");
        expect(t.description?.length ?? 0).toBeGreaterThan(10);
      });

      it("has an object input_schema", () => {
        expect(t.input_schema).toBeDefined();
        expect((t.input_schema as { type: string }).type).toBe("object");
      });
    });
  }
});

describe("agent system prompts", () => {
  for (const mode of ["chat-config", "optimizer", "end-to-end"] as const) {
    describe(mode, () => {
      const p = SYSTEM_PROMPTS[mode];

      it("is a non-trivial string", () => {
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(100);
      });

      it("mentions tool-related terms", () => {
        expect(p).toMatch(/tool|set_|configure/i);
      });
    });
  }
});
