import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workstream posting policy consolidation", () => {
  it("does not instruct agents to omit content the server now accepts", async () => {
    const definitions = await readFile(
      new URL("../lib/agentToolDefs.mjs", import.meta.url),
      "utf8",
    );

    expect(definitions).not.toMatch(/Never include private paths/i);
    expect(definitions).not.toMatch(/never include private implementation detail/i);
  });

  it("does not report the removed privacy policy as a current rejection reason", async () => {
    const implementation = await readFile(
      new URL("../lib/agentTools.ts", import.meta.url),
      "utf8",
    );

    expect(implementation).not.toMatch(/rejected by the card-facing privacy policy/i);
  });
});
