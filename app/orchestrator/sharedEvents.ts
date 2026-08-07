"use client";

// Cross-tab sharing for the GET /api/events stream.
//
// Chrome budgets SIX plain-HTTP/1.1 connections per origin ACROSS ALL TABS.
// When every Operator tab held its own global EventSource (plus a transcript
// stream), a few open tabs consumed the whole budget and mutations starved —
// "The save request timed out" with a perfectly healthy server. So exactly one
// tab (the leader) holds the real EventSource and rebroadcasts every message
// over a BroadcastChannel; the rest just listen.
//
// Leadership is a Web Lock: every tab queues on navigator.locks.request and
// the holder keeps the lock until the tab dies, at which point the browser
// releases it and the next queued tab takes over and opens its own stream.
// No heartbeats, no split-brain — the browser is the arbiter.
//
// Catch-up semantics mirror the old per-tab code: this stream is a live tail
// with no snapshot, so on every REopen (network blip, laptop sleep, leader
// takeover) each tab refetches the authoritative lists via onCatchUp. A tab's
// very first observed open is skipped — boot() just loaded everything —
// unless we were already following another tab's stream, in which case an
// "open" means a gap (old leader died) and the refetch is required.
//
// FUTURE (option 2, if this ever falls short): tabs viewing DIFFERENT tasks
// still hold one transcript stream each while visible, so enough simultaneously
// visible windows could refill the budget. The structural fix is moving the SSE
// endpoints to WebSockets, which live outside the HTTP/1.1 connection pool —
// server.js already terminates WS upgrades for /pty, so the auth/upgrade seam
// exists. Not built until a real need shows up.
//
// Fallback: no BroadcastChannel or no navigator.locks (Web Locks needs a
// secure context — localhost qualifies, plain-http tailnet origins don't) →
// this tab opens its own EventSource, exactly the old behavior.

import type { GlobalWireEvent } from "@/lib/events";

export type GlobalEventsSub = {
  onEvent: (ev: GlobalWireEvent) => void;
  // Fired on stream REopen — refetch authoritative state; events were lost.
  onCatchUp: () => void;
};

const CHANNEL = "orch-global-events";
const LOCK = "orch-global-events-leader";

const subs = new Set<GlobalEventsSub>();
let started = false;
let opensSeen = 0;
// True once we've received anything from another tab's stream — from then on
// even a "first" open of our own means a takeover gap, not a fresh boot.
let sawRemoteStream = false;
let channel: BroadcastChannel | null = null;

function deliverEvent(raw: string) {
  let ev: GlobalWireEvent;
  try { ev = JSON.parse(raw) as GlobalWireEvent; } catch { return; }
  for (const s of subs) s.onEvent(ev);
}

function deliverOpen() {
  opensSeen += 1;
  if (opensSeen === 1 && !sawRemoteStream) return;
  for (const s of subs) s.onCatchUp();
}

function openStream(broadcast: boolean) {
  const es = new EventSource("/api/events");
  es.onopen = () => {
    deliverOpen();
    if (broadcast) channel?.postMessage({ kind: "open" });
  };
  es.onmessage = (e) => {
    deliverEvent(e.data as string);
    if (broadcast) channel?.postMessage({ kind: "ev", data: e.data });
  };
  // Never closed explicitly: the stream (and, for a leader, the lock) lives
  // exactly as long as the tab. Subscribers come and go independently.
}

function start() {
  if (started) return;
  started = true;
  const canShare = typeof BroadcastChannel !== "undefined" && !!navigator.locks;
  if (!canShare) { openStream(false); return; }
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const m = e.data as { kind: string; data?: string };
    sawRemoteStream = true;
    if (m.kind === "ev" && typeof m.data === "string") deliverEvent(m.data);
    else if (m.kind === "open") deliverOpen();
  };
  void navigator.locks.request(LOCK, () => {
    openStream(true);
    // Hold the lock for the life of the tab; the browser releases it on death.
    return new Promise<void>(() => {});
  });
}

export function subscribeGlobalEvents(sub: GlobalEventsSub): () => void {
  subs.add(sub);
  start();
  return () => { subs.delete(sub); };
}
