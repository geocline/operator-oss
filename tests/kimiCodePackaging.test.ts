import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8");

describe("Kimi Code packaging", () => {
  it("pins the official SDK and does not bundle the incompatible non-Wire npm CLI", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@moonshot-ai/kimi-agent-sdk"]).toBe("0.1.8");
    expect(pkg.dependencies).not.toHaveProperty("@moonshot-ai/kimi-code");
  });

  it("downloads, verifies, and pins the official Wire CLI 1.49.0", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/KIMI_CLI_VERSION=1\.49\.0/);
    expect(dockerfile).toMatch(/KIMI_CODE_CLI_PATH=\/usr\/local\/bin\/kimi/);
    expect(dockerfile).toMatch(/sha256sum -c/);
    expect(dockerfile).toMatch(/kimi --help[\s\S]*--wire[\s\S]*--work-dir/);
    expect(dockerfile).toMatch(
      /COPY --from=build .*kimi-code-launcher\.mjs .*kimi-code-launcher\.mjs/,
    );
  });

  it("creates a restrictive task-local state root at entrypoint", () => {
    const entrypoint = read("docker/entrypoint.sh");
    expect(entrypoint).toMatch(/\.operator\/litellm-kimi-code/);
    expect(entrypoint).toMatch(
      /chmod 700 "\$HOME\/\.operator\/litellm-kimi-code"/,
    );
  });

  it("documents Kimi Code configuration and honest permissions", () => {
    const env = read(".env.example");
    const readme = read("README.md");
    const architecture = read("docs/ARCHITECTURE.md");
    expect(env).toMatch(/KIMI_CODE_CLI_PATH=/);
    expect(env).toMatch(/LITELLM_KIMI_CODE_HOME=/);
    expect(readme).toMatch(/Kimi Code.*1\.49\.0/i);
    expect(readme).toMatch(/Auto-run only/i);
    expect(readme).toMatch(/not an OS sandbox/i);
    expect(architecture).toMatch(/litellm-kimi-code/);
    expect(architecture).toMatch(/non-persisted environment/i);
  });
});
