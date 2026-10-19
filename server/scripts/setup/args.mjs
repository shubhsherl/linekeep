export const HELP = `Linekeep backend setup

Provisions and deploys the Cloudflare backend (Worker, D1, private R2, optional
Cloudflare Access, daily email and recording retention) from an API token.

Usage (from server/):
  npm run setup -- [flags]

Flags:
  --yes               Accept defaults and skip the final confirmation.
  --dry-run           Print the plan and exact resource names. No writes, no
                      mutating API calls, no REST probes.
  --answers <file>    JSON file with answers; prompts only for what is missing
                      (with --yes, missing required answers are an error).
  --env <name>        Environment to configure (default: production).
  --help              Show this help.

Environment:
  CLOUDFLARE_API_TOKEN   API token. Otherwise you are prompted (input hidden).
  MAILGUN_API_KEY        Optional; otherwise prompted when email is enabled.

Secrets are never written to disk or passed on command lines. Re-running is safe:
existing resources are reused and nothing is deleted.
`;

export function parseArgs(argv) {
  const out = { yes: false, dryRun: false, answers: null, env: null, help: false };
  const list = [...argv];
  const value = (flag, inline) => {
    if (inline !== undefined) return inline;
    const next = list.shift();
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
    return next;
  };
  while (list.length) {
    const raw = list.shift();
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    switch (flag) {
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--answers":
        out.answers = value(flag, inline);
        break;
      case "--env":
        out.env = value(flag, inline);
        break;
      default:
        throw new Error(`Unknown argument: ${raw}. Use --help.`);
    }
  }
  return out;
}
