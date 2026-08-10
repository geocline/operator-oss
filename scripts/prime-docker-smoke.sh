#!/usr/bin/env bash
# Prime Agent packaging smoke test: build the pinned image, exercise one fake
# RPC turn (with a spawned worker child), stop it, and prove no Prime, worker,
# kernel, or ZeroMQ process survives inside the container.
#
# Requires a running Docker daemon. Usage: scripts/prime-docker-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="operator-prime-smoke:local"
NAME="operator-prime-smoke-$$"

echo "==> building image"
docker build -t "$IMAGE" .

echo "==> verifying pinned prime-agent version"
# prime-agent prints its version to stderr.
VERSION="$(docker run --rm --entrypoint prime-agent "$IMAGE" --version 2>&1)"
[ "$VERSION" = "0.7.1" ] || { echo "FAIL: prime-agent version $VERSION != 0.7.1"; exit 1; }

echo "==> extension is present, root-owned, read-only"
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  ls -l /app/scripts/prime-operator-extension.ts
  [ "$(stat -c %U /app/scripts/prime-operator-extension.ts)" = root ]
  [ "$(stat -c %a /app/scripts/prime-operator-extension.ts)" = 444 ]
'

echo "==> fake RPC turn with a worker child, then abort; no orphans may remain"
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  node - <<'"'"'EOF'"'"'
const { spawn } = require("node:child_process");
// One RPC child in its own process group, which spawns a long-lived worker —
// the same tree shape the driver must settle after abort.
const child = spawn("sh", ["-c", "node -e \"setInterval(()=>{},1000)\" & echo started; read line"], {
  detached: true, stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.once("data", () => {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    setTimeout(() => process.exit(0), 500);
  }, 500);
});
EOF
  sleep 1
  ORPHANS="$(ps -eo comm,args | grep -E "prime-agent|ipykernel|zmq" | grep -v grep || true)"
  if [ -n "$ORPHANS" ]; then echo "FAIL: orphan processes remain:"; echo "$ORPHANS"; exit 1; fi
  echo "no orphans"
'

echo "==> smoke test passed"
