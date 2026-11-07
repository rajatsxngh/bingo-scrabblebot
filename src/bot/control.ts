// control.json: tonight's switches, re-read every few seconds so changing
// them never needs a restart (and never drops the connection).
//   lobby         false = finish the current match, then stay connected and idle
//   tournamentId  register for this tournament (null = unregister / none)
//   brain         "fallback" now; "v1" once M6 lands. Switches between matches.
//   params        path to the params file. Switches between matches.

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
  brain: "fallback",
  params: "config/params.json",
};

export function parseControl(json: unknown): ControlSettings {
  const c = { ...DEFAULT_CONTROL };
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
      text = fs.readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    if (text === this.raw) return;
    this.raw = text;
    let next: ControlSettings;
    try {
      next = parseControl(JSON.parse(text));
    } catch {
      this.warn(`control.json isn't valid JSON; keeping the last settings`);
      return;
    }
    const prev = this.current;
    this.current = next;
    if (initial || JSON.stringify(prev) !== JSON.stringify(next)) this.onChange(next, prev);
  }
}
