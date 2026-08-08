import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("transcript copy controls", () => {
  it("copies complete user and assistant messages from their source text", () => {
    const transcript = source("app/orchestrator/Transcript.tsx");
    expect(transcript).toContain('label="Copy message"');
    expect(transcript).toContain("text={text}");
    expect(transcript).toContain("msg-copy");
  });

  it("copies fenced code independently without its Markdown fence", () => {
    const markdown = source("app/Markdown.tsx");
    expect(markdown).toContain("MarkdownPre");
    expect(markdown).toContain("nodeText");
    expect(markdown).toContain('label="Copy code"');
    expect(markdown).toContain("code-copy");
  });

  it("keeps copy controls visible and touch-sized on mobile", () => {
    const css = source("app/globals.css");
    expect(css).toContain(".msg-copy");
    expect(css).toContain(".code-copy");
    expect(css).toContain("min-height:44px");
  });
});
