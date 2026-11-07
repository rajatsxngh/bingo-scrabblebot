// Logs: a short line on the console, and one JSON object per line in
// logs/bingo-<date>.jsonl for later analysis (per-auction lines, per-match
// summaries, and flags for anything that went wrong).

import * as fs from "node:fs";
import * as path from "node:path";

export class Log {
  private stream: fs.WriteStream;

  constructor(dir: string, private readonly name: string) {
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.stream = fs.createWriteStream(path.join(dir, `${name}-${day}.jsonl`), { flags: "a" });
  }

  /** Writes a JSON record (and prints `text`, if given). */
  record(kind: string, data: Record<string, unknown>, text?: string) {
    const line = JSON.stringify({ t: new Date().toISOString(), kind, ...data }, (_k, v) =>
      typeof v === "bigint" ? Number(v) : v,
    );
    this.stream.write(line + "\n");
    if (text) console.log(`[${this.name}] ${text}`);
  }

  info(text: string) {
    this.record("info", { text }, text);
  }

  /** Something that needs a look: missed auction, rejected call, slow decision. */
  flag(what: string, data: Record<string, unknown> = {}) {
    this.record("flag", { what, ...data });
    console.warn(`[${this.name}] FLAG ${what} ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`);
  }
}
