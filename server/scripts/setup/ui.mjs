import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

/**
 * Terminal UI. Every prompt goes through this object so tests can inject a scripted fake with the same shape:
 * say, warn, ask, confirm, select, multiselect, hidden, close.
 */
export function createUi({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });
  Object.defineProperty(sink, "isTTY", { get: () => Boolean(output.isTTY) });
  Object.defineProperty(sink, "columns", { get: () => output.columns });
  let rl = null;
  let closed = false;
  const queue = [];
  const waiters = [];
  const closedError = () => new Error("Input closed before all questions were answered. Use --answers and --yes for non-interactive runs.");
  const interactive = Boolean(input.isTTY && output.isTTY);
  const iface = () => {
    if (!rl) {
      rl = createInterface({ input, output: sink, terminal: interactive });
      rl.on("close", () => {
        closed = true;
        while (waiters.length) waiters.shift().reject(closedError());
      });
      // Piped input: buffer lines ourselves, because rl.question() drops lines that arrive before it is called.
      if (!interactive) {
        rl.on("line", (l) => (waiters.length ? waiters.shift().resolve(l) : queue.push(l)));
      }
    }
    return rl;
  };
  const line = async (prompt) => {
    const r = iface();
    if (interactive) {
      if (closed) throw closedError();
      try {
        return await r.question(prompt);
      } catch (error) {
        throw closed ? closedError() : error;
      }
    }
    if (prompt) output.write(prompt);
    let value;
    if (queue.length) value = queue.shift();
    else if (closed) throw closedError();
    else value = await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    output.write("\n");
    return value;
  };

  const ui = {
    say: (message = "") => void output.write(`${message}\n`),
    warn: (message = "") => void errorOutput.write(`${message}\n`),

    /** Free text with default and validation. `parse` returns { ok, value } | { ok, error }. */
    async ask(question, { default: def, parse = (v) => ({ ok: true, value: v }) } = {}) {
      for (;;) {
        const suffix = def !== undefined && def !== "" ? ` [${def}]` : "";
        const raw = (await line(`${question}${suffix}: `)).trim();
        const result = parse(raw === "" && def !== undefined ? String(def) : raw);
        if (result.ok) return result.value;
        ui.say(`  [!!] ${result.error}`);
      }
    },

    async confirm(question, def = false) {
      for (;;) {
        const raw = (await line(`${question} [${def ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
        if (raw === "") return def;
        if (["y", "yes"].includes(raw)) return true;
        if (["n", "no"].includes(raw)) return false;
        ui.say("  [!!] Answer y or n.");
      }
    },

    /** options: [{ value, label, hint? }]; returns the chosen value. */
    async select(question, options, defIndex = 0) {
      ui.say(question);
      options.forEach((o, i) => ui.say(`  ${i + 1}) ${o.label}${o.hint ? ` - ${o.hint}` : ""}`));
      for (;;) {
        const raw = (await line(`Choose 1-${options.length} [${defIndex + 1}]: `)).trim();
        const n = raw === "" ? defIndex + 1 : Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
        ui.say("  [!!] Pick one of the numbers above.");
      }
    },

    /** options: [{ value, label, hint? }]; defaults: values selected by default. Returns chosen values. */
    async multiselect(question, options, defaults = []) {
      ui.say(question);
      options.forEach((o, i) => ui.say(`  ${i + 1}) [${defaults.includes(o.value) ? "x" : " "}] ${o.label}${o.hint ? ` - ${o.hint}` : ""}`));
      const defText = options.flatMap((o, i) => (defaults.includes(o.value) ? [i + 1] : [])).join(",") || "none";
      for (;;) {
        const raw = (await line(`Numbers separated by commas, "none" for none [${defText}]: `)).trim().toLowerCase();
        if (raw === "") return [...defaults];
        if (raw === "none") return [];
        const picks = raw.split(/[\s,]+/).filter(Boolean).map(Number);
        if (picks.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length)) {
          return options.filter((_, i) => picks.includes(i + 1)).map((o) => o.value);
        }
        ui.say("  [!!] Pick numbers from the list.");
      }
    },

    /** Secret input: no echo on a TTY. */
    async hidden(question, { parse = (v) => ({ ok: true, value: v }) } = {}) {
      for (;;) {
        output.write(`${question}: `);
        muted = true;
        let raw;
        try {
          raw = (await line("")).trim();
        } finally {
          muted = false;
        }
        if (input.isTTY) output.write("\n");
        const result = parse(raw);
        if (result.ok) return result.value;
        ui.say(`  [!!] ${result.error}`);
      }
    },

    close() {
      rl?.close();
    },
  };
  return ui;
}
