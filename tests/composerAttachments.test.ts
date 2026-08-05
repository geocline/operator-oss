import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  stateIndex: 0,
  refIndex: 0,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => void) => effect(),
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.stateIndex++;
      if (hooks.states.length <= index) {
        hooks.states[index] = typeof initial === "function"
          ? (initial as () => T)()
          : initial;
      }
      const setState = (next: T | ((previous: T) => T)) => {
        const previous = hooks.states[index] as T;
        hooks.states[index] = typeof next === "function"
          ? (next as (value: T) => T)(previous)
          : next;
      };
      return [hooks.states[index] as T, setState] as const;
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.refIndex++;
      hooks.refs[index] ??= { current: initial };
      return hooks.refs[index] as { current: T };
    },
  };
});

import { Composer } from "@/app/orchestrator/Composer";

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (predicate(element)) return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return undefined;
}

describe("Composer file attachments", () => {
  beforeEach(() => {
    hooks.states = [];
    hooks.refs = [];
    hooks.stateIndex = 0;
    hooks.refIndex = 0;
    vi.restoreAllMocks();
  });

  it("uploads arbitrary files as files while retaining image previews", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ path: "/tmp/upload" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
    const tree = Composer({
      task: { id: "task-123", title: "Upload test" } as never,
      agentLabel: "Codex",
      disabled: false,
      running: false,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onClear: vi.fn(),
    });
    const input = findElement(
      tree,
      (element) => element.type === "input"
        && (element.props as { type?: string }).type === "file",
    );
    expect(input).toBeDefined();

    const pdf = new File(["pdf"], "offering-memo.pdf", { type: "application/pdf" });
    const image = new File(["png"], "site-plan.png", { type: "image/png" });
    (input!.props as { onChange: (event: unknown) => void }).onChange({
      target: { files: [pdf, image], value: "selected" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/tasks/task-123/uploads",
      "/api/tasks/task-123/uploads",
    ]);
    expect(hooks.states[3]).toEqual([
      expect.objectContaining({ kind: "file", name: "offering-memo.pdf", preview: "" }),
      expect.objectContaining({ kind: "image", name: "site-plan.png", preview: "blob:image-preview" }),
    ]);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledWith(image);
  });
});
