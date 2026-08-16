// Mini plugin registries (batch two, Package F): four in-repo seams so
// adding a tool card / slash command / row-status contributor / composer
// seat is one register*() call instead of editing a switch. NOT Cordis, NOT
// dynamic loading, NOT third-party plugins - the owning file registers into
// these at module load (e.g. Transcript.tsx registers its own ask card), and
// the existing dispatch site consults the registry first, falling back to
// its pre-registry behavior when a key isn't registered. With only the
// proof-case registrations this batch moves, nothing about the rendered UI
// changes.
//
// Module-level Maps survive dev HMR the same way lib/events.ts's globalThis
// registries do. Re-registering the same name with the identical value (the
// owning module's top-level register*() call running again) is a no-op;
// registering the same name with a genuinely different value is a real
// collision and throws outside production.

import type { ReactElement } from "react";
import type { ToolData } from "@/lib/types";
import type { RowStatus } from "./statusLadder";
import type { TaskRow } from "./types";

function upsert<T>(
  store: Map<string, T>,
  name: string,
  value: T,
  sameValue: (a: T, b: T) => boolean,
  label: string,
): void {
  const existing = store.get(name);
  if (existing !== undefined) {
    if (sameValue(existing, value)) return; // HMR re-running the same registration
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`${label}: "${name}" is already registered`);
    }
    return; // never crash a production session over a seam collision
  }
  store.set(name, value);
}

// --- F1: tool cards -------------------------------------------------------
// Keyed by tool name or a synthetic "intent" (e.g. "ask") derived from the
// ToolData shape. Transcript's ToolView dispatch consults this first and
// falls back to the generic ToolView rendering.

export type ToolCardProps = { data: ToolData; agentLabel: string };
export type ToolCardComponent = (props: ToolCardProps) => ReactElement | null;

const toolCards = new Map<string, ToolCardComponent>();

export function registerToolCard(key: string, Component: ToolCardComponent): void {
  upsert(toolCards, key, Component, (a, b) => a === b, "registerToolCard");
}

export function getToolCard(key: string | undefined): ToolCardComponent | undefined {
  return key ? toolCards.get(key) : undefined;
}

// --- F2: slash commands -----------------------------------------------------
// Composer's slash menu builds its list from these instead of a hardcoded
// array. `visible` mirrors the old inline gating (e.g. /clear and /handoff
// only once a session exists); `run` gets the composer's live instance state
// since a module-level registration can't close over any one render.

export type ComposerCommandCtx = {
  task: TaskRow;
  setVal: (v: string) => void;
  setSlash: (v: boolean) => void;
  onClear: () => void;
  focus: () => void;
};
export type ComposerCommand = {
  name: string; // e.g. "/clear"
  description: string;
  visible: (ctx: ComposerCommandCtx) => boolean;
  run: (ctx: ComposerCommandCtx) => void;
};

const commands = new Map<string, ComposerCommand>();

export function registerCommand(cmd: ComposerCommand): void {
  upsert(commands, cmd.name, cmd, (a, b) => a.run === b.run && a.visible === b.visible, "registerCommand");
}

export function listCommands(): ComposerCommand[] {
  return [...commands.values()];
}

// --- F3: session-status contributors ---------------------------------------
// statusLadder's rowStatus() consults these below the built-in precedence
// (awaiting > running > unviewed): the first contributor to return non-null
// wins. Ships with zero contributors this batch - the seam exists for future
// row-status sources without touching TasksColumn/TaskBoard again.

export type SessionStatusCtx = { running: boolean; unviewed: boolean };
export type SessionStatusContributor = (
  task: { status: string; awaiting_input: number | boolean },
  ctx: SessionStatusCtx,
) => RowStatus | null;

const sessionStatusContributors = new Map<string, SessionStatusContributor>();

export function registerSessionStatus(name: string, fn: SessionStatusContributor): void {
  upsert(sessionStatusContributors, name, fn, (a, b) => a === b, "registerSessionStatus");
}

export function sessionStatusContributions(): SessionStatusContributor[] {
  return [...sessionStatusContributors.values()];
}

// --- F4: composer seats ------------------------------------------------------
// Composer's foot renders whatever is registered for each side, in `order`.
// The attach-file button is this batch's proof case (right side); nothing is
// registered on the left yet, so that fold renders nothing.

export type ComposerSeatCtx = { disabled: boolean; openFilePicker: () => void };
export type ComposerSeatComponent = (props: ComposerSeatCtx) => ReactElement | null;
export type ComposerSeatEntry = { name: string; seat: "left" | "right"; order: number; Component: ComposerSeatComponent };

const composerSeats = new Map<string, ComposerSeatEntry>();

export function registerComposerSeat(
  name: string,
  seat: "left" | "right",
  spec: { order: number; Component: ComposerSeatComponent },
): void {
  upsert(
    composerSeats,
    name,
    { name, seat, ...spec },
    (a, b) => a.seat === b.seat && a.order === b.order && a.Component === b.Component,
    "registerComposerSeat",
  );
}

export function composerSeatsFor(seat: "left" | "right"): ComposerSeatEntry[] {
  return [...composerSeats.values()].filter((s) => s.seat === seat).sort((a, b) => a.order - b.order);
}
