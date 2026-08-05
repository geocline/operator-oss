import { afterEach, describe, expect, it, vi } from "vitest";
import {
  saveTaskEdit,
  TASK_EDIT_SAVE_TIMEOUT_MS,
} from "../app/orchestrator/api";

describe("orchestrator API helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a stalled task edit after exactly 15 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })),
    );

    let failure: unknown;
    void saveTaskEdit("task-1", { title: "Updated" })
      .catch((cause) => {
        failure = cause;
      });

    await vi.advanceTimersByTimeAsync(TASK_EDIT_SAVE_TIMEOUT_MS - 1);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(failure).toEqual(new Error("The save request timed out. Try again."));
  });

  it("returns a successful task edit response unchanged", async () => {
    const saved = { id: "task-1", title: "Updated" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(saved), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveTaskEdit("task-1", { title: "Updated" })).resolves.toEqual(saved);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/task-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
      }),
    );
  });
});
