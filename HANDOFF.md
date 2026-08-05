# HANDOFF - Operator fork + deal tracker integration (session of 2026-08-01 to 2026-08-03)

For any session working on the operator app or the Ardent deal tracker: this
records what a prior session already built, and the decisions Geo has locked
in. Do not undo or re-litigate these without asking him.

## What this fork is

Fork of iishyfishyy/operator-oss (Apache-2.0) at geocline/operator-oss.
Runs as launchd service com.geo.operator (port 3000) + com.geo.operator-pty
(PTY_PORT=3101, NOT upstream's 3001). Registered in services/config.yaml.
Logs: "/Users/geo/Claude Projects/.services/logs/operator.{log,err}".
Env: ORCH_PROJECTS_DIR="/Users/geo/Claude Projects" (new projects land there),
set in .env AND the launchd plist. Upstream remote configured; sync policy is
merge, never rebase; expect conflicts mostly in app/Orchestrator.tsx.

## HARD RULES (Geo corrections - violating these caused real damage)

1. NEVER restart/kickstart the operator service while any task turn is
   running. It kills the turn mid-tool with no closing message. Check first:
   `sqlite3 ~/.zen-orchestrator/orchestrator.db "SELECT title FROM tasks WHERE running=1"`
   Build, then kickstart only at zero running turns.
2. NO prompt injection for behavior shaping. Geo explicitly rejected adding
   communication/behavior rules to project contexts or CLAUDE.md files. A
   COMMUNICATION block was added to all project contexts on 2026-08-03 and
   then fully reverted at his direction. Project contexts hold deal/project
   facts and pointers ONLY. Claude's native summarize-at-end behavior is
   trusted as-is.
3. Transcript UI must read like Claude Code: prose only. ALL tool peeks are
   condensed to one-line headers unconditionally (app/orchestrator/
   SessionView.tsx sets condensed = true); errors still auto-open. Do not
   restore preview tiers without asking.
4. Never commit corpus documents (pdf/xlsx/docx/images) in the Ardent deal
   folders. Deal repos are code-and-notes only (whitelist .gitignore).
5. No em dashes in anything written for Geo (use plain hyphens).
6. Commits only when Geo asks; pushes only with his explicit OK per repo.

## Fork changes already shipped (all committed on main)

- fix(codex): close stdin pipe in verify exec turn (codex >= 0.145 blocks on
  an open stdin pipe).
- feat(quota): /api/quota + QuotaView + topbar QuotaStrip + QuotaAdvisor
  banner. Source: opencodex proxy 127.0.0.1:10100/api/provider-quotas.
  Percents are USED (not remaining); anthropic timestamps are ms, openai
  seconds; normalize on read. Settings keys quota_warn_threshold (default 80),
  quota_advisor_enabled. Per-model usage lines (Fable highlighted) read the
  conversations index DB read-only.
- feat(handoff): optional {agent} body on POST /api/tasks/[id]/clear switches
  the task's driver across the generation boundary (same worktree, summary
  carried). SessionView renders a two-step "Continue with Codex/Claude Code"
  button. window.confirm is BANNED in this app (embedded webviews suppress
  it); use the arm-then-confirm button pattern.
- feat(ui): "Renew" is the user-facing name for /clear (label change only,
  command still /clear). Focus mode button + Esc (hides project/task columns).
  Session header sh-tools row wraps (fix: controls were clipped off-screen).
  Mobile topbar: tb-mobile-hide class hides desktop-only icons; titlebar is
  flex on mobile.
- feat(open): GET /open deep-link resolver. Resolution order:
  1. session id operator ran -> its task.
  2. unknown session id -> looked up in conversations-dashboard index.db,
     transcript tail rebuilt from JSONL on disk, new task pre-seeded with the
     dialogue (cross-border Renew).
  3. exact repo_path project match -> that project.
  4. path INSIDE a lane's repo_path -> TASK in that lane (deal-lane routing,
     dedup by card path marker in the description).
  5. otherwise find-or-create project for the folder (only if it exists).
- feat(uploads): any file type attachable (composer says "file"); extension
  whitelist opened, traversal guard kept.
- feat(pwa): radar-sweep icons + apple-touch-icon (iOS cannot animate icons;
  motion is painted). manifest.json for Add to Home Screen over Tailscale.
- feat(projects): New folder / Existing folder / Clone modes; New auto-creates
  ORCH_PROJECTS_DIR/<name> at create time. BrowseDirButton uses the in-app
  picker on coarse-pointer devices (native macOS chooser opens on the host).
- guide at public/guide.html; toolbar links to cockpit (8770) and
  conversations dashboard (8772); package.json start:geo loads .env.

## Deal tracker changes already shipped (pushed to Vercel, geocline/ardent-deal-tracker)

- CardModal AI Workspace row: "Open in Operator" (targets
  http://geos-mbp.tail9f0829.ts.net:3000, override NEXT_PUBLIC_OPERATOR_BASE;
  localhost is wrong because Geo uses the tracker from iPhone), "Copy project
  path", existing "Copy cd + claude" and "Refresh".
- trackerOnline probe: 4s timeout (was 1.5s) + "Check again" retry buttons on
  both offline notices.
- Attached-conversation rows: "Continue in Operator" link (session id ->
  /open resolver).

## Workflow decisions (Geo's mental model - build to fit it)

- Project = deal/lane. Task = assignment (a tracker card is a task). Session =
  a generation inside a task; Renew rolls generations.
- Lanes live in operator for: Chamblee, WR1, WR2, Wobbe (deals), Ardent
  Internal, General (firm/catch-all), Fortress (Bedrock PMS tenant-side
  integration lane - NOT a deal; Sage-Intacct is the GL sibling and has no
  lane by choice). Each lane folder has a local nested git repo, code+notes
  only, corpus untracked. The Ardent ROOT is a commitless 8.8GB repo - never
  let operator baseline it; never point a lane at the Ardent root.
- Context philosophy: sessions preload only the lane blurb + task description
  (pointers). Knowledge stays on disk (INDEX.md per deal, ardent-find,
  Paperless MCP) and is pulled on demand. Never preload corpus.
- Tracker cards route into deal lanes as tasks via /open path containment.
  Two grandfathered pre-routing projects hold live work and must not be
  deleted: "Review TMF missed fees/Returned Check", "Ardent/Sage-Intacct".
- Retrieval Pipeline lane owns the corpus-search work (Paperless MCP is
  registered user-level; INDEX.md generator + eval harness live in its
  worktree, uncommitted by Geo's choice). Eval verdict: fix Paperless OCR
  before considering any embedding layer.
- Foreign files in this repo root (.superpowers/, *.html session artifacts)
  belong to other sessions - do not commit or delete them.

## Verification conventions

- After any operator code change: npm run build, wait for zero running turns,
  kickstart, curl health, then verify in the browser pane. Frontend changes
  in Work_Cockpit need a ?v= cache-bust.
- Tracker deploys via git push to GitHub (Vercel auto-builds). npm run build
  locally first.

## 2026-08-04 - Card workstreams, breadcrumbs, and hardening

- Operator commit `9e9c83f` implements the approved single-user card workstream
  bridge: manual activation, pause/resume/post-now/disconnect controls, durable
  delivery, proposal handling, exact conversation registration, and private
  task/card linkage.
- Tracker commit `05447de` implements owner-only workstreams, fixed bot
  attribution, exact breadcrumbs, proposal approval, private AI Workspace
  storage, hardened automatic HTML attachments, and migrations 0044 and 0045.
- MCP commit `c7480f3` implements exact standalone session breadcrumbs and the
  fixed `Geo's Bot` attribution. Conversations dashboard commit `5265797`
  exposes exact annotation revisions.
- Operator hardening commits through `3b9db50` upgrade the secure runtime to
  Next 16.3 and Node 20.9+, remove production audit findings, accept arbitrary
  composer files, atomically deduplicate historical external-session imports,
  add CI for Node 20.9 and Node 22, validate production traces, and migrate the
  Next file convention from middleware to proxy.
- Tracker hardening commits `f139569` and `36d3fdc` anchor Turbopack to the app
  root, upgrade Next to 16.3, replace the stale registry XLSX package with the
  official SheetJS CE 0.20.3 tarball, and reduce the production audit from four
  high findings to zero.
- Fresh release verification passed: Operator 450 tests, Tracker 103 tests,
  MCP 55 tests, dashboard 1 test, plus type checks, lint, builds, audit, trace
  checks, and independent reviews.
- Operator `main` is pushed and running locally. The tracker release is pushed
  only to `codex/card-workstreams-rollout`. Do not promote tracker `main` until
  migrations 0044 and 0045 have been applied and verified in that order.
- Production gate still open: the Supabase dashboard session is signed out.
  After Geo signs in, run migrations 0044 then 0045, verify the new tables,
  functions, RLS, and removal of `cards.ai_project_path`, push tracker `main`,
  confirm Vercel production, and complete the signed-in activation/breadcrumb/
  comment/control/proposal/attachment acceptance pass.
