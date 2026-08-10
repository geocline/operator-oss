import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Static packaging pins for the Prime Agent runtime image. The real build +
// orphan-process smoke test lives in scripts/prime-docker-smoke.sh; these
// assertions keep the pinned version and copy/permission contract from
// regressing in review.
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("Prime Agent packaging", () => {
  it("pins exactly one PRIME_AGENT_VERSION=0.7.1 and verifies the binary", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile.match(/PRIME_AGENT_VERSION=0\.7\.1/g)).toHaveLength(1);
    expect(dockerfile).not.toMatch(/prime-agent@latest/);
    expect(dockerfile).toMatch(/prime-agent --version/);
    expect(dockerfile).toMatch(/PRIME_CLI_PATH=\/usr\/local\/bin\/prime-agent/);
  });

  it("ships the Operator extension root-owned and non-writable", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(
      /COPY --from=build --chown=root:root --chmod=444 \/app\/scripts\/prime-operator-extension\.ts \.\/scripts\/prime-operator-extension\.ts/,
    );
  });

  it("creates a restrictive Prime home at entrypoint and keeps the key strip", () => {
    const entrypoint = read("docker/entrypoint.sh");
    expect(entrypoint).toMatch(/\.operator\/litellm-prime/);
    expect(entrypoint).toMatch(/chmod 700 "\$HOME\/\.operator\/litellm-prime"/);
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]) {
      expect(entrypoint).toContain(key);
    }
  });

  it("documents the Prime env knobs", () => {
    const env = read(".env.example");
    expect(env).toMatch(/PRIME_CLI_PATH=/);
    expect(env).toMatch(/LITELLM_PRIME_HOME=/);
  });
});
