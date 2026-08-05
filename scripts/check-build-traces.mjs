import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const serverOutput = path.join(projectRoot, ".next", "server");

const forbiddenExactPaths = new Set([
  ".dockerignore",
  ".gitignore",
  ".npmrc",
  "Dockerfile",
  "LICENSE",
  "docker-compose.yml",
  "next-env.d.ts",
  "package-lock.json",
  "scripts/check-build-traces.mjs",
  "scripts/fix-pty.js",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "vitest.config.ts",
]);

const forbiddenDirectoryPrefixes = [
  ".git/",
  ".github/",
  ".superpowers/",
  ".vercel/",
  "coverage/",
  "docs/",
  "tests/",
  "worktrees/",
];

function isForbiddenRepositoryPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const basename = path.posix.basename(normalized);

  return (
    forbiddenExactPaths.has(normalized) ||
    forbiddenDirectoryPrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    basename === ".DS_Store" ||
    /^\.env(?:\.|$)/.test(basename) ||
    (!normalized.includes("/") &&
      (normalized.endsWith(".html") || normalized.endsWith(".md")))
  );
}

function findTraceManifests(directory) {
  const manifests = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...findTraceManifests(absolutePath));
    } else if (entry.name.endsWith(".nft.json")) {
      manifests.push(absolutePath);
    }
  }
  return manifests;
}

if (!fs.existsSync(serverOutput)) {
  throw new Error(`Next server output is missing: ${serverOutput}`);
}

const manifests = findTraceManifests(serverOutput).sort();
if (manifests.length === 0) {
  throw new Error(`No Next trace manifests found under ${serverOutput}`);
}

const violations = [];
for (const manifestPath of manifests) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files)) {
    throw new Error(`Invalid trace manifest: ${manifestPath}`);
  }

  for (const tracedPath of manifest.files) {
    const absoluteTracedPath = path.resolve(path.dirname(manifestPath), tracedPath);
    const relativeToProject = path.relative(projectRoot, absoluteTracedPath);
    if (
      relativeToProject === "" ||
      relativeToProject.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToProject)
    ) {
      continue;
    }

    if (isForbiddenRepositoryPath(relativeToProject)) {
      violations.push({
        manifest: path.relative(projectRoot, manifestPath),
        traced: relativeToProject.split(path.sep).join("/"),
      });
    }
  }
}

if (violations.length > 0) {
  const unique = new Map(
    violations.map((violation) => [
      `${violation.manifest}\0${violation.traced}`,
      violation,
    ]),
  );
  const details = [...unique.values()]
    .sort((left, right) =>
      `${left.manifest}:${left.traced}`.localeCompare(
        `${right.manifest}:${right.traced}`,
      ),
    )
    .map(({ manifest, traced }) => `  ${manifest} -> ${traced}`)
    .join("\n");

  throw new Error(
    `Forbidden repository files found in Next server traces:\n${details}`,
  );
}

console.log(`Validated ${manifests.length} Next server trace manifests.`);
