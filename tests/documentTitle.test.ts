import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentTitle } from "@/app/orchestrator/useDocumentTitle";

function TitleHarness({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

describe("Operator document title", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", { title: "Marketing title" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the active workspace and resets to Operator without a selection", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(TitleHarness, {
          title: "WR2 / Bancorp extension",
        }),
      );
    });
    expect(document.title).toBe("WR2 / Bancorp extension - Operator");

    await act(async () => {
      renderer.update(React.createElement(TitleHarness, { title: null }));
    });
    expect(document.title).toBe("Operator");
  });
});
