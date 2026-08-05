import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("EditTaskModal save feedback", () => {
  it("awaits saves and exposes progress and failure states", () => {
    const source = readFileSync(
      new URL("../app/orchestrator/modals.tsx", import.meta.url),
      "utf8",
    );
    const modal = source.slice(
      source.indexOf("export function EditTaskModal"),
      source.indexOf("export function ContextModal"),
    );

    expect(modal).toMatch(/onSave:[\s\S]*Promise<void>/);
    expect(modal).toMatch(/const \[saving, setSaving\] = useState\(false\)/);
    expect(modal).toMatch(/await onSave\(/);
    expect(modal).toMatch(/setSaveError\(/);
    expect(modal).toMatch(/saving \? "Saving…"/);
    expect(modal).toMatch(/role="alert" aria-live="assertive"/);
    expect(modal).toMatch(/<ErrNote[^>]*>\{saveError\}<\/ErrNote>/);
  });
});
