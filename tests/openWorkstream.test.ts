import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/open/route";
import { getDb } from "../lib/db";
import {
  createProject,
  getTask,
  updateTask,
} from "../lib/store";
import {
  getWorkstreamByExternalCard,
  getWorkstreamByTask,
} from "../lib/workstreams/store";
import { WORKSTREAM_LIFECYCLE_MESSAGES } from "../lib/workstreams/worker";

const TRACKER_BASE = "https://tracker.example";
const BRIDGE_TOKEN = "dedicated-bridge-secret";

function exchangeBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    workstream_id: "workstream-001",
    card_id: "card-001",
    title: "Review TIC information",
    deal_tag: "WOBBE",
    project_path: "",
    status: "activating",
    activation_ack_token: "opaque-ack-token-with-enough-entropy",
    ...overrides,
  };
}

function taskCount(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
      count: number;
    }
  ).count;
}

function linkCount(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS count FROM workstream_links").get() as {
      count: number;
    }
  ).count;
}

function outboxPayloads(taskId: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT o.payload
       FROM workstream_outbox o
       JOIN workstream_links l ON l.id = o.link_id
       WHERE l.task_id = ?
       ORDER BY o.created_at, o.id`,
    )
    .all(taskId)
    .map((row) =>
      JSON.parse((row as { payload: string }).payload) as Record<
        string,
        unknown
      >,
    );
}

describe("workstream activation deep link", () => {
  beforeEach(() => {
    vi.stubEnv("ARDENT_TRACKER_BASE_URL", TRACKER_BASE);
    vi.stubEnv("ARDENT_WORKSTREAM_BRIDGE_TOKEN", BRIDGE_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("exchanges the token first and creates a linked task in the containing lane", async () => {
    const lanePath = mkdtempSync(path.join(os.tmpdir(), "operator-lane-"));
    const cardPath = path.join(lanePath, "card-project");
    const lane = createProject({
      name: "Wobbe",
      repo_path: lanePath,
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        Response.json(
          exchangeBody({ card_id: "card-create", project_path: cardPath }),
        ),
      )
      .mockImplementationOnce(async () => {
        const local = getWorkstreamByExternalCard("ardent", "card-create");
        expect(local?.state).toBe("paused");
        return Response.json({ workstream: { status: "active" } });
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(
        "http://operator.test/open?workstream_token=opaque-activation&session=ignored&path=/ignored",
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `${TRACKER_BASE}/api/workstream-bridge/exchange`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: `Bearer ${BRIDGE_TOKEN}`,
        }),
        body: JSON.stringify({ activation_token: "opaque-activation" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${TRACKER_BASE}/api/workstream-bridge/activation/ack`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workstream_id: "workstream-001",
          activation_ack_token: "opaque-ack-token-with-enough-entropy",
        }),
      }),
    );
    const redirected = new URL(response.headers.get("location")!);
    expect(redirected.searchParams.get("project")).toBe(lane.id);
    const taskId = redirected.searchParams.get("task");
    expect(taskId).toBeTruthy();
    expect(getTask(taskId!)?.title).toBe("Review TIC information");
    expect(getTask(taskId!)?.description).not.toContain("card-create");
    expect(getTask(taskId!)?.description).not.toContain(cardPath);
    expect(getWorkstreamByTask(taskId!)?.external_card_id).toBe("card-create");
    expect(getWorkstreamByTask(taskId!)?.state).toBe("active");
    expect(outboxPayloads(taskId!)).toContainEqual({
      body: WORKSTREAM_LIFECYCLE_MESSAGES.activation,
      attachments: [],
    });
  });

  // Deep links must land the user back on the origin they clicked from: a
  // laptop on localhost stays on localhost, a phone on the tailnet stays on the
  // tailnet. Neither can be read from new URL(req.url) - behind the custom
  // server Next rebuilds that from an internal base and it always says
  // localhost:3000 - so the route reads the Host header, and refuses hosts it
  // doesn't recognise so a forged Host can't turn this into an open redirect.
  describe("deep-link redirect origin", () => {
    const PUBLIC = "http://geos-mbp.tail9f0829.ts.net:3000";

    async function openWith(headers: Record<string, string>, cardId: string) {
      const lanePath = mkdtempSync(path.join(os.tmpdir(), "operator-public-"));
      const lane = createProject({ name: `WR-${cardId}`, repo_path: lanePath });
      vi.stubEnv("PUBLIC_BASE_URL", PUBLIC);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) =>
          Response.json(
            url.endsWith("/activation/ack")
              ? { workstream: { status: "active" } }
              : exchangeBody({ card_id: cardId, project_path: path.join(lanePath, "card-project") }),
          ),
        ),
      );
      const response = await GET(
        new Request(`http://localhost:3000/open?workstream_token=${cardId}`, { headers }),
      );
      return { lane, redirected: new URL(response.headers.get("location")!) };
    }

    it("keeps a laptop on localhost instead of bouncing it to the tailnet", async () => {
      const { lane, redirected } = await openWith({ host: "localhost:3000" }, "card-local");
      expect(redirected.origin).toBe("http://localhost:3000");
      expect(redirected.searchParams.get("project")).toBe(lane.id);
      expect(redirected.searchParams.get("task")).toBeTruthy();
    });

    it("keeps a phone on the public hostname it arrived on", async () => {
      const { lane, redirected } = await openWith(
        { host: "geos-mbp.tail9f0829.ts.net:3000" },
        "card-public-origin",
      );
      expect(redirected.origin).toBe(PUBLIC);
      expect(redirected.searchParams.get("project")).toBe(lane.id);
    });

    it("honours a proxy's forwarded host and scheme", async () => {
      const { redirected } = await openWith(
        {
          host: "127.0.0.1:3000",
          "x-forwarded-host": "geos-mbp.tail9f0829.ts.net:3000",
          "x-forwarded-proto": "https",
        },
        "card-forwarded",
      );
      expect(redirected.origin).toBe("https://geos-mbp.tail9f0829.ts.net:3000");
    });

    it("refuses an unrecognised Host rather than redirecting off-instance", async () => {
      const { redirected } = await openWith({ host: "evil.example.com" }, "card-evil");
      expect(redirected.origin).toBe(PUBLIC);
    });

    it("falls back to the configured public origin when there's no Host at all", async () => {
      const { redirected } = await openWith({}, "card-nohost");
      expect(redirected.origin).toBe(PUBLIC);
    });
  });

  it("deduplicates repeated activation by provider and external card id", async () => {
    const lanePath = mkdtempSync(path.join(os.tmpdir(), "operator-lane-"));
    const lane = createProject({ name: "Wobbe", repo_path: lanePath });
    const remote = exchangeBody({
      card_id: "card-dedupe",
      project_path: path.join(lanePath, "card-project"),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) =>
        Response.json(
          url.endsWith("/activation/ack")
            ? { workstream: { status: "active" } }
            : remote,
        ),
      ),
    );

    const first = await GET(
      new Request("http://operator.test/open?workstream_token=first-token"),
    );
    const second = await GET(
      new Request("http://operator.test/open?workstream_token=second-token"),
    );

    const firstUrl = new URL(first.headers.get("location")!);
    const secondUrl = new URL(second.headers.get("location")!);
    expect(secondUrl.searchParams.get("project")).toBe(lane.id);
    expect(secondUrl.searchParams.get("task")).toBe(
      firstUrl.searchParams.get("task"),
    );
    expect(getWorkstreamByExternalCard("ardent", "card-dedupe")?.task_id).toBe(
      firstUrl.searchParams.get("task"),
    );
  });

  it("reopens the stable linked task even when the task is done", async () => {
    const lanePath = mkdtempSync(path.join(os.tmpdir(), "operator-lane-"));
    createProject({ name: "Wobbe", repo_path: lanePath });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) =>
        Response.json(
          url.endsWith("/activation/ack")
            ? { workstream: { status: "active" } }
            : exchangeBody({
                card_id: "card-done",
                project_path: path.join(lanePath, "card-project"),
              }),
        ),
      ),
    );

    const first = await GET(
      new Request("http://operator.test/open?workstream_token=first-token"),
    );
    const originalTaskId = new URL(
      first.headers.get("location")!,
    ).searchParams.get("task")!;
    updateTask(originalTaskId, { status: "done" });
    const before = taskCount();

    const reopened = await GET(
      new Request("http://operator.test/open?workstream_token=next-token"),
    );

    expect(
      new URL(reopened.headers.get("location")!).searchParams.get("task"),
    ).toBe(originalTaskId);
    expect(getTask(originalTaskId)?.status).toBe("done");
    expect(taskCount()).toBe(before);
  });

  it("creates nothing and redirects home quietly when exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: "activation token expired" }, { status: 410 }),
      ),
    );
    const tasksBefore = taskCount();
    const linksBefore = linkCount();

    const response = await GET(
      new Request("http://operator.test/open?workstream_token=expired-token"),
    );

    const redirected = new URL(response.headers.get("location")!);
    expect(redirected.pathname).toBe("/");
    expect(redirected.searchParams.get("workstream_error")).toBe("unavailable");
    expect(taskCount()).toBe(tasksBefore);
    expect(linkCount()).toBe(linksBefore);
  });

  it.each([null, ""] as const)(
    "routes a General card by validated project path when deal_tag is %s",
    async (dealTag) => {
      const lanePath = mkdtempSync(path.join(os.tmpdir(), "operator-general-"));
      const lane = createProject({ name: "General", repo_path: lanePath });
      const remote = exchangeBody({
        card_id: `card-general-${String(dealTag)}`,
        deal_tag: dealTag,
        project_path: path.join(lanePath, "card-project"),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) =>
          Response.json(
            url.endsWith("/activation/ack")
              ? { workstream: { status: "active" } }
              : remote,
          ),
        ),
      );

      const response = await GET(
        new Request("http://operator.test/open?workstream_token=general-token"),
      );

      expect(
        new URL(response.headers.get("location")!).searchParams.get("project"),
      ).toBe(lane.id);
    },
  );

  it("leaves a recoverable paused local link when activation acknowledgment fails", async () => {
    const lanePath = mkdtempSync(path.join(os.tmpdir(), "operator-ack-fail-"));
    createProject({ name: "General", repo_path: lanePath });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            exchangeBody({
              card_id: "card-ack-fail",
              project_path: path.join(lanePath, "card-project"),
            }),
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ error: "ack unavailable" }, { status: 503 }),
        ),
    );

    const response = await GET(
      new Request("http://operator.test/open?workstream_token=ack-fail"),
    );

    expect(
      getWorkstreamByExternalCard("ardent", "card-ack-fail")?.state,
    ).toBe("paused");
    expect(
      outboxPayloads(
        getWorkstreamByExternalCard("ardent", "card-ack-fail")!.task_id,
      ),
    ).toEqual([]);
    expect(
      new URL(response.headers.get("location")!).searchParams.get(
        "workstream_error",
      ),
    ).toBe("activation-pending");
  });
});
