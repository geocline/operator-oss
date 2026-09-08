// The office skin route serves PNGs straight off disk from an env-configured
// dir (ORCH_OFFICE_SKIN_DIR), so the two things worth pinning are: it's a
// no-op when unset (the default — every other test file's env), and it can't
// be walked outside that dir via a crafted path segment.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function getSkinFile(url: string, segments: string[]) {
  return import("@/app/api/office/skin/[...path]/route").then(({ GET }) =>
    GET(new NextRequest(url), { params: Promise.resolve({ path: segments }) }),
  );
}

describe("GET /api/office/skin", () => {
  it("reports disabled when ORCH_OFFICE_SKIN_DIR is unset", async () => {
    const { GET } = await import("@/app/api/office/skin/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("GET /api/office/skin/[...path]", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("404s on every request when ORCH_OFFICE_SKIN_DIR is unset", async () => {
    const res = await getSkinFile("http://127.0.0.1:3000/api/office/skin/foo.png", ["foo.png"]);
    expect(res.status).toBe(404);
  });

  it("serves a real PNG under the configured dir and reports enabled: true", async () => {
    const root = fs.mkdtempSync(path.join(process.env.ORCH_TEST_TMP!, "office-skin-"));
    const sub = path.join(root, "Theme_Sorter_Singles");
    fs.mkdirSync(sub, { recursive: true });
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
        "01f15c4890000000a4944415478da6360000002000155000d0a2db40000000049454e44ae426082",
      "hex",
    );
    fs.writeFileSync(path.join(sub, "dummy.png"), pngBytes);

    vi.stubEnv("ORCH_OFFICE_SKIN_DIR", root);
    vi.resetModules();

    const { GET: getEnabled } = await import("@/app/api/office/skin/route");
    expect(await (await getEnabled()).json()).toEqual({ enabled: true });

    const ok = await getSkinFile(
      "http://127.0.0.1:3000/api/office/skin/Theme_Sorter_Singles/dummy.png",
      ["Theme_Sorter_Singles", "dummy.png"],
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("private, max-age=3600");
    const body = Buffer.from(await ok.arrayBuffer());
    expect(body.equals(pngBytes)).toBe(true);
  });

  it("rejects a non-.png extension even inside the dir", async () => {
    const root = fs.mkdtempSync(path.join(process.env.ORCH_TEST_TMP!, "office-skin-"));
    fs.writeFileSync(path.join(root, "notes.txt"), "hello");
    vi.stubEnv("ORCH_OFFICE_SKIN_DIR", root);
    vi.resetModules();

    const res = await getSkinFile("http://127.0.0.1:3000/api/office/skin/notes.txt", ["notes.txt"]);
    expect(res.status).toBe(404);
  });

  it("rejects a traversal attempt that escapes the configured dir", async () => {
    const root = fs.mkdtempSync(path.join(process.env.ORCH_TEST_TMP!, "office-skin-"));
    // A real secret living just outside the configured skin dir.
    const secretDir = fs.mkdtempSync(path.join(process.env.ORCH_TEST_TMP!, "office-secret-"));
    fs.writeFileSync(path.join(secretDir, "secret.png"), "not actually a png");
    const escapeRel = path.relative(root, path.join(secretDir, "secret.png"));

    vi.stubEnv("ORCH_OFFICE_SKIN_DIR", root);
    vi.resetModules();

    // Encode the escape as literal ".." path segments, the way a crafted
    // request URL would arrive at the dynamic route regardless of how deep
    // ORCH_OFFICE_SKIN_DIR itself is nested.
    const segments = escapeRel.split(path.sep);
    const res = await getSkinFile(
      `http://127.0.0.1:3000/api/office/skin/${segments.join("/")}`,
      segments,
    );
    expect(res.status).toBe(404);
  });

  it("rejects a bare '..' segment and an absolute-looking segment", async () => {
    const root = fs.mkdtempSync(path.join(process.env.ORCH_TEST_TMP!, "office-skin-"));
    vi.stubEnv("ORCH_OFFICE_SKIN_DIR", root);
    vi.resetModules();

    const dotdot = await getSkinFile("http://127.0.0.1:3000/api/office/skin/..%2Fetc.png", ["..", "etc.png"]);
    expect(dotdot.status).toBe(404);
  });
});
