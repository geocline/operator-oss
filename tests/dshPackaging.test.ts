import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("dsh packaging", () => {
  it("does NOT add an npm dependency for dsh (the jsonrpc-composition peer graph is broken on the npm registry)", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).some((name) => name.includes("dsh"))).toBe(false);
    expect(Object.keys(pkg.dependencies).some((name) => name.startsWith("@deepseek-ai"))).toBe(false);
  });

  it("installs the pinned dsh runtime via the Python SDK's platform wheel, not npm", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/DSH_RUNTIME_VERSION=0\.1\.0rc6/);
    expect(dockerfile).toMatch(/pip install --no-cache-dir "deepseek-harness-sdk==\$\{DSH_RUNTIME_VERSION\}"/);
    expect(dockerfile).toMatch(/bundled_runtime_path/);
    expect(dockerfile).toMatch(/DSH_CLI_PATH=\/usr\/local\/bin\/dsh-jsonrpc-agent/);
    // A real protocol smoke, not a --version flag (the binary has none).
    expect(dockerfile).toMatch(/usage: dsh-jsonrpc-agent/);
  });

  it("creates a restrictive task-local state root at entrypoint", () => {
    const entrypoint = read("docker/entrypoint.sh");
    expect(entrypoint).toMatch(/\.operator\/litellm-dsh/);
    expect(entrypoint).toMatch(/chmod 700 "\$HOME\/\.operator\/litellm-dsh"/);
  });

  it("documents dsh configuration", () => {
    const env = read(".env.example");
    expect(env).toMatch(/DSH_CLI_PATH=/);
    expect(env).toMatch(/LITELLM_DSH_HOME=/);
    expect(env).toMatch(/pip install/i);
  });
});
