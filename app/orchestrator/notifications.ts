"use client";

// OS notifications for the events worth leaving your desk for.
//
// The old notifier lived in useOrchestrator and read `realTasks`, which only
// ever holds the SELECTED project's rows - so an agent parked on a question in
// any other project produced a silent badge and nothing else. This one is
// driven by the GLOBAL lifecycle stream instead (useGlobalEvents), which sees
// every task in every project, and each event now carries its own task title
// and project name so a notification can say what happened and where.
//
// Three deliberate choices about being HARD to ignore:
//   - anything that needs a decision sets requireInteraction, so the banner
//     stays on screen instead of dissolving after ~5 seconds;
//   - a short synthesized chime (no audio asset to ship or fail to load) marks
//     the ones that need you, off by default for the ones that don't;
//   - the count also lands on the tab title and the dock badge (useAppBadge),
//     so a missed banner is still visible everywhere the app is.

import type { GlobalWireEvent } from "@/lib/events";
import type { Settings } from "./types";

/** What happened, in the terms a person cares about. */
export type NotifyKind = "question" | "finished" | "failed" | "agent";

export type NotifyRequest = {
  kind: NotifyKind;
  title: string;
  body: string;
  /** Collapses repeats of the same subject rather than stacking them. */
  tag: string;
  /** Where clicking the banner should land, when there is a task to open. */
  target?: { projectId: string; taskId: string };
};

export const notifySupported = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

export const notifyPermission = (): NotificationPermission | "unsupported" =>
  notifySupported() ? Notification.permission : "unsupported";

export async function requestNotifyPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notifySupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// Which settings flag gates each kind. Everything is on by default (see
// DEFAULT_SETTINGS): a notification layer nobody opted into is the one we just
// replaced.
const PREF_KEY: Record<NotifyKind, keyof Settings> = {
  question: "notifyQuestion",
  finished: "notifyFinished",
  failed: "notifyFailed",
  agent: "notifyAgent",
};

// A decision is waiting, so the banner should persist until it is dismissed.
// "finished" is informational and allowed to auto-dismiss.
const STICKY: Record<NotifyKind, boolean> = {
  question: true,
  finished: false,
  failed: true,
  agent: true,
};

/**
 * A short two-note chime, synthesized rather than loaded, so there is no asset
 * to 404 and no autoplay-policy surprise beyond the one every page has: the
 * AudioContext only starts after the user has interacted with the page, which
 * by definition they have if Operator is open and running turns.
 */
export function playChime(): void {
  if (typeof window === "undefined") return;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    gain.connect(ctx.destination);
    for (const [freq, at] of [[784, 0], [1046.5, 0.11]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + at);
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + at + 0.4);
    }
    // Free the hardware context once the sound has finished.
    window.setTimeout(() => void ctx.close().catch(() => {}), 900);
  } catch {
    // No audio device, or a context limit. Never worth breaking a notification.
  }
}

/** Fire one OS notification. No-op unless permission was actually granted. */
export function showNotification(
  req: NotifyRequest,
  opts: { sound: boolean; onOpen?: (projectId: string, taskId: string) => void },
): void {
  if (notifyPermission() !== "granted") return;
  try {
    const n = new Notification(req.title, {
      body: req.body,
      tag: req.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      requireInteraction: STICKY[req.kind],
    });
    n.onclick = () => {
      window.focus();
      if (req.target && opts.onOpen) opts.onOpen(req.target.projectId, req.target.taskId);
      n.close();
    };
    if (opts.sound) playChime();
  } catch {
    // Some browsers throw when constructing notifications from a background
    // document. A missed banner must never take the event handler down with it.
  }
}

/**
 * Translate one global lifecycle event into a notification, or null when it
 * isn't worth interrupting for.
 *
 * The mapping deserves a note, because Operator's model collapses two things
 * people think of as different. A turn that ends mid-task ALWAYS sets
 * awaiting_input - "finished" and "your turn" are the same row state. So the
 * distinction here is drawn from the event instead: an `awaiting_input` event
 * is the agent explicitly asking a question mid-turn, while `turn_end` is the
 * agent stopping and handing back. They never both fire for one hand-off, since
 * a turn parked on a question has not ended yet.
 */
export function describeEvent(
  ev: GlobalWireEvent,
  agentLabel: (id: string) => string,
): NotifyRequest | null {
  if (ev.type === "agent_auth") {
    if (!ev.broken) return null;
    return {
      kind: "agent",
      title: `${agentLabel(ev.agent)} needs reconnecting`,
      body: "Its login expired, so every queued message is parked until you reconnect it in Settings.",
      tag: `agent-${ev.agent}`,
    };
  }
  if (ev.type !== "task") return null;
  const where = ev.projectName ? `${ev.projectName} · ${ev.title}` : ev.title;
  const target = { projectId: ev.projectId, taskId: ev.taskId };

  if (ev.event === "awaiting_input") {
    return {
      kind: "question",
      title: `${agentLabel(ev.agent)} has a question`,
      body: where,
      tag: `ask-${ev.taskId}`,
      target,
    };
  }
  if (ev.event === "turn_failed") {
    // A dead login is announced instance-wide by its own agent_auth event, which
    // is both more actionable and fires once per outage rather than once per
    // task - so the per-task copy is dropped instead of doubling the banners.
    if (ev.failure === "auth") return null;
    return ev.failure === "limit"
      ? {
          kind: "failed",
          title: `${agentLabel(ev.agent)} hit its usage limit`,
          body: `${where} is parked until the quota resets.`,
          tag: `limit-${ev.agent}`,
          target,
        }
      : {
          kind: "failed",
          title: "A task failed",
          body: where,
          tag: `fail-${ev.taskId}`,
          target,
        };
  }
  if (ev.event === "turn_end" && !ev.running && ev.status === "in_progress") {
    return {
      kind: "finished",
      title: `${agentLabel(ev.agent)} finished a turn`,
      body: where,
      tag: `done-${ev.taskId}`,
      target,
    };
  }
  return null;
}

/** Whether this kind is switched on, defaulting to on for an unseen setting. */
export function notifyEnabled(settings: Settings, kind: NotifyKind): boolean {
  return settings[PREF_KEY[kind]] !== false;
}

/**
 * Mirror the "needs you" count onto the app icon. Supported on installed PWAs
 * in Chromium; everywhere else the guard makes it a no-op rather than a throw.
 */
export function setAppBadge(count: number): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count)?.catch?.(() => {});
    else void nav.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    // Unsupported or blocked. Cosmetic either way.
  }
}
