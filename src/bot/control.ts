// control.json: tonight's switches, re-read every few seconds so changing
// them never needs a restart (and never drops the connection).
//   lobby         false = finish the current match, then stay connected and idle
//   tournamentId  register for this tournament (null = unregister / none)
//   brain         "v1" (or "fallback"). Switches between matches.
//   params        path to the params file. Switches between matches.
// A key left out of the file keeps its current value, and a UTF-8 byte-order
// mark (PowerShell 5.1's Out-File writes one) is ignored, so an edit can never
// silently reset the bot to defaults (lobby on, no tournament).

import * as fs from "node:fs";

export interface ControlSettings {
  lobby: boolean;
  tournamentId: string | null;
  brain: string;
  params: string;
}

export const DEFAULT_CONTROL: ControlSettings = {
  lobby: true,
  tournamentId: null,
  brain: "v1",
  params: "config/params.json",
};

/** Settings from parsed JSON; keys the file leaves out keep their value in `base`. */
export function parseControl(json: unknown, base: ControlSettings = DEFAULT_CONTROL): ControlSettings {
  const c = { ...base };
  if (typeof json !== "object" || json === null) return c;
  const o = json as Record<string, unknown>;
  if (typeof o.lobby === "boolean") c.lobby = o.lobby;
  if (o.tournamentId === null) c.tournamentId = null;
  else if (typeof o.tournamentId === "string" || typeof o.tournamentId === "number") {
    c.tournamentId = String(o.tournamentId);
  }
  if (typeof o.brain === "string") c.brain = o.brain;
  if (typeof o.params === "string") c.params = o.params;
  return c;
}

export class Control {
  current: ControlSettings;
  private raw = "";

  constructor(
    private readonly path: string,
    private readonly onChange: (next: ControlSettings, prev: ControlSettings) => void,
    private readonly warn: (msg: string) => void,
  ) {
    if (!fs.existsSync(path)) {
      fs.writeFileSync(path, JSON.stringify(DEFAULT_CONTROL, null, 2) + "\n");
    }
    this.current = { ...DEFAULT_CONTROL };
    this.read(true);
    setInterval(() => this.read(false), 2000).unref();
  }

  private read(initial: boolean) {
    let text: string;
    try {
      text = fs.readFileSync(this.path, "utf8").replace(/^﻿/, "");
    } catch {
      return;
    }
    if (text === this.raw) return;
    this.raw = text;
    let next: ControlSettings;
    try {
      next = parseControl(JSON.parse(text), this.current);
    } catch {
      this.warn(`control.json isn't valid JSON; keeping the last settings`);
      return;
    }
    const prev = this.current;
    this.current = next;
    if (initial || JSON.stringify(prev) !== JSON.stringify(next)) this.onChange(next, prev);
  }
}
