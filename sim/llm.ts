// One `claude -p` call that must answer with JSON, through the user's own Claude login, with no
// tools, saved session or settings (so no headsup hooks fire inside the simulation).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CAPTURING_ENV } from '../src/capture.js';

export type Model = 'haiku' | 'sonnet';
export const usage = { calls: 0, usd: 0 };

// Every call runs on the user's own Claude subscription, so each process stops at a ceiling rather than
// quietly using up the plan: SIM_MAX_CALLS calls or SIM_MAX_USD at API-equivalent prices, whichever first.
const MAX_CALLS = Number(process.env.SIM_MAX_CALLS ?? 600);
const MAX_USD = Number(process.env.SIM_MAX_USD ?? 10);
// Those limits reset with each process, so a campaign of several runs also has one shared ceiling:
// SIM_CAMPAIGN names it (any word), and every process adds its calls to sim/out/campaign-<name>.json until
// SIM_CAMPAIGN_MAX_CALLS / SIM_CAMPAIGN_MAX_USD.
const CAMPAIGN = process.env.SIM_CAMPAIGN;
const campaignFile = CAMPAIGN ? join(new URL('.', import.meta.url).pathname, 'out', `campaign-${CAMPAIGN.replace(/[^\w-]/g, '_')}.json`) : '';
const CAMPAIGN_MAX_CALLS = Number(process.env.SIM_CAMPAIGN_MAX_CALLS ?? 600);
const CAMPAIGN_MAX_USD = Number(process.env.SIM_CAMPAIGN_MAX_USD ?? 10);
const readCampaign = (): { calls: number; usd: number } => {
  try {
    return JSON.parse(readFileSync(campaignFile, 'utf8')) as { calls: number; usd: number };
  } catch {
    return { calls: 0, usd: 0 };
  }
};
export class BudgetError extends Error {}
export function record(usd: number): void {
  usage.calls++;
  usage.usd += usd;
  if (campaignFile) {
    const c = readCampaign();
    mkdirSync(dirname(campaignFile), { recursive: true });
    writeFileSync(campaignFile, JSON.stringify({ calls: c.calls + 1, usd: c.usd + usd }));
  }
}
export function checkBudget(): void {
  if (usage.calls >= MAX_CALLS || usage.usd >= MAX_USD) {
    throw new BudgetError(`budget reached: ${usage.calls} calls, $${usage.usd.toFixed(2)} (limits ${MAX_CALLS} calls, $${MAX_USD}); raise SIM_MAX_CALLS / SIM_MAX_USD to go on`);
  }
  if (campaignFile) {
    const c = readCampaign();
    if (c.calls >= CAMPAIGN_MAX_CALLS || c.usd >= CAMPAIGN_MAX_USD) {
      throw new BudgetError(`campaign "${CAMPAIGN}" budget reached: ${c.calls} calls, $${c.usd.toFixed(2)} (limits ${CAMPAIGN_MAX_CALLS} calls, $${CAMPAIGN_MAX_USD})`);
    }
  }
}

function once(model: Model, system: string, user: string): Promise<string> {
  checkBudget();
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '', '--system-prompt', system], {
      env: { ...process.env, [CAPTURING_ENV]: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 200)}`));
      try {
        const parsed = JSON.parse(out) as { result?: string; total_cost_usd?: number };
        record(parsed.total_cost_usd ?? 0);
        resolve(parsed.result ?? '');
      } catch {
        resolve(out);
      }
    });
    child.stdin.end(user);
  });
}

// The first JSON value in the reply, fences and prose around it ignored.
export function extractJson(text: string): unknown {
  const body = text.replace(/```(?:json)?/g, '');
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in reply: ${text.slice(0, 120)}`);
  const open = body[start]!;
  const close = open === '[' ? ']' : '}';
  for (let end = body.lastIndexOf(close); end > start; end = body.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      /* try a shorter span */
    }
  }
  throw new Error(`unparseable JSON in reply: ${text.slice(0, 120)}`);
}

// Writing a coding session sometimes makes the model act out tool calls; saying it has none, and
// retrying, keeps the reply to the JSON asked for.
const JSON_ONLY = '\n\nYou have no tools. Reply with the JSON only, nothing before or after it.';

export async function askJson<T>(model: Model, system: string, user: string, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return extractJson(await once(model, system + JSON_ONLY, user)) as T;
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function askText(model: Model, system: string, user: string): Promise<string> {
  return once(model, system, user);
}

// Runs tasks with at most `limit` in flight, keeping input order in the results.
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}
