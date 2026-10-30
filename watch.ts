/**
 * ua-jobs-watcher
 *
 * Categories:  backend / frontend / fullstack → instant Telegram notification
 *              llm-pure                        → daily digest
 *              other                           → silently ignored, never sent
 *
 * Study app (APP_URL + APP_TOKEN in .env):
 *   every instant match is also POSTed to {APP_URL}/api/applications (appQueueEnabled in
 *   watch.config.json); appDigestCron sends "У черзі N готових заявок" once a day.
 *   Failures there are logged and never stop the Telegram flow.
 *
 * npm run watch          long-running cron process
 * npm run watch:dry      print classification + scores, send nothing, save nothing
 * npm run watch:test     run once, send example messages to Telegram, save nothing
 */

process.env.SCRAPER_NO_MAIN = '1';
process.title = 'JobWatcherBot';

import 'dotenv/config';
import { schedule, validate as validateCron } from 'node-cron';
import { Bot, InlineKeyboard } from 'grammy';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import {
  categorize,
  checkForeignStackFilter,
  checkRemoteAndYears,
  checkCountries,
  type Category,
  type FilterResult,
} from './watch-filter.js';
import {
  buildAppDigestMessage,
  enqueueApplication,
  fetchReadyApplications,
  flushPending,
  type AppClientOptions,
  type AppQueueItem,
  type AppSource,
  type PendingAppQueueItem,
} from './watch-app.js';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// ─── Type mirrors (keep in sync with scrape-jobs.ts) ─────────────────────────
interface Signals { llm: string[]; aiTooling: string[]; languages: string[]; frontend: string[]; }
interface Vacancy {
  id: string; source: string; url: string; title: string;
  company: string | null; location: string | null; salary: string | null;
  publishedAt: string | null; experienceYears: number | null;
  englishLevel: string | null; remote: boolean | null; countries?: string | null;
  description: string; fingerprint: string | null;
  duplicateOf: string | null; gone: boolean; signals: Signals;
}
interface ScraperOptions {
  out: string; maxPages: number; delayMs: number; limit: number; only: string[];
  skipDetails: boolean; fresh: boolean; cacheDir: string; cacheTtlHours: number;
  bypassCache?: (url: string, method: string) => boolean;
  watchMode?: boolean;
  stopBeforeMs?: number;
  detailFilter?: (id: string, url: string) => boolean;
}
interface ScraperOutput {
  meta: { queries: Array<{ id: string; error?: string }> };
  vacancies: Vacancy[];
}

// ─── Scraper (dynamic — SCRAPER_NO_MAIN already set above) ───────────────────
const { makeCtx, run: scraperRun, collectListings: scraperCollect,
        fetchDetails: scraperFetchDetails, buildOutput, Store } =
  await import('./scrape-jobs.js') as {
    makeCtx: (o: ScraperOptions, s: object, q: boolean) => object;
    run:             (c: object) => Promise<void>;
    collectListings: (c: object) => Promise<void>;
    fetchDetails:    (c: object) => Promise<void>;
    buildOutput: (c: object, p: boolean) => ScraperOutput;
    Store: new () => object;
  };

// ─── Constants ───────────────────────────────────────────────────────────────
const WATCH_DIR        = '.watch';
const STATE_FILE       = path.join(WATCH_DIR, 'state.json');
const LOG_FILE         = path.join(WATCH_DIR, 'watch.log');
const REJECTED_LOG     = path.join(WATCH_DIR, 'rejected.jsonl');
const CONFIG_FILE      = 'watch.config.json';
const LOCK_PORT        = 47811;
const MAX_MSGS_PER_RUN = 15;

// ─── Interfaces ───────────────────────────────────────────────────────────────
const INSTANT_CATS = new Set<Category>(['backend', 'frontend', 'fullstack']);

interface WatchConfig {
  minScore: number;
  minSalaryUsd: number;
  maxPublishedAgeDays: number;
  maxPagesPerQuery: number;
  alertEveryNFailures: number;
  digestCron: string;
  cycleIntervalMinutes: number;
  cycleJitterSeconds: number;
  hostBackoffCycles: number;
  /** POST instant matches to the study app queue (needs APP_URL + APP_TOKEN in .env). */
  appQueueEnabled: boolean;
  /** Cron for the "ready applications" digest; empty string disables it. */
  appDigestCron: string;
  categoryMinScore: Record<string, number>;
  titleBlocklist: string[];
  titleWeights: Record<string, number>;
  signalWeights: Record<string, number>;
  textWeights: Record<string, number>;
  foreignStacks: string[];
  foreignStackPenalty: number;
  requireNodeInStack: boolean;
  /** Block vacancies that are not explicitly remote (hybrid / office / unknown). */
  remoteOnly?: boolean;
  /** Block vacancies that require more years of experience than this. */
  maxRequiredYears?: number | null;
}

interface RejectedByReason { title: number; required: number; years: number; noNode: number; other: number; notRemote?: number; exp?: number; country?: number; }
interface DayStats { date: string; runs: number; instantSent: number; failedRuns: number; rejectedByReason: RejectedByReason; }

interface QueuedDigestItem {
  id: string; url: string; title: string;
  company: string | null; salary: string | null;
  remote: boolean | null; location: string | null; experienceYears: number | null;
  descSnippet: string; languages: string[]; llmSignals: string[];
  score: number; matched: string[]; queuedAt: string;
}

interface WatchState {
  seenKeys: string[];
  firstRunDone: boolean;
  consecutiveFailures: number;
  lastAlertRun: number;
  digestQueue: QueuedDigestItem[];
  dayStats: DayStats;
  noDescRetries: Record<string, number>; // vacancyKey → attempt count (1-based)
  /** host → epoch-ms until which the host is skipped (after 429/503/challenge). */
  hostBackoff: Record<string, number>;
  /** Study app POSTs that failed temporarily; retried at the start of the next run. */
  appQueuePending: PendingAppQueueItem[];
}

interface ScoreResult { score: number; matched: string[]; blocked: boolean; blockReason?: string; }

// ─── Utilities ────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function log(msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  await appendFile(LOG_FILE, line + '\n').catch(() => {});
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function truncateWords(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(' ', maxLen);
  return text.slice(0, cut > 0 ? cut : maxLen) + '…';
}

// ─── State I/O ────────────────────────────────────────────────────────────────
const EMPTY_REJECTED: RejectedByReason = { title: 0, required: 0, years: 0, noNode: 0, other: 0 };

async function loadState(): Promise<WatchState> {
  if (!existsSync(STATE_FILE)) return {
    seenKeys: [], firstRunDone: false, consecutiveFailures: 0, lastAlertRun: 0,
    digestQueue: [],
    dayStats: { date: '', runs: 0, instantSent: 0, failedRuns: 0, rejectedByReason: { ...EMPTY_REJECTED } },
    noDescRetries: {},
    hostBackoff: {},
    appQueuePending: [],
  };
  const s = JSON.parse(await readFile(STATE_FILE, 'utf8')) as WatchState;
  s.digestQueue         ??= [];
  s.dayStats            ??= { date: '', runs: 0, instantSent: 0, failedRuns: 0, rejectedByReason: { ...EMPTY_REJECTED } };
  s.dayStats.rejectedByReason ??= { ...EMPTY_REJECTED };
  s.noDescRetries       ??= {};
  s.hostBackoff         ??= {};
  s.appQueuePending     ??= [];
  return s;
}

const saveState = (s: WatchState) => writeFile(STATE_FILE, JSON.stringify(s, null, 2));

// ─── Config ───────────────────────────────────────────────────────────────────
async function loadConfig(): Promise<WatchConfig> {
  const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_'))) as unknown as WatchConfig;
}

// ─── Cache bypass predicate ───────────────────────────────────────────────────
// Listing/RSS/pagination pages are always fetched fresh.
// Detail pages stay cached for cacheTtlHours.
// POST (DOU xhr-load) bypasses naturally: CSRF token changes → different cache key.
function bypassListingCache(url: string, method: string): boolean {
  if (method === 'POST') return false;
  if (/jobs\.dou\.ua\/companies\/[^/]+\/vacancies\/\d+/.test(url)) return false;
  if (/djinni\.co\/jobs\/\d+-[a-z]/.test(url)) return false;
  return url.includes('jobs.dou.ua') || url.includes('djinni.co');
}

// ─── Vacancy keys ─────────────────────────────────────────────────────────────
function buildDuplicatesMap(vacancies: Vacancy[]): Map<string, Vacancy[]> {
  const map = new Map<string, Vacancy[]>();
  for (const v of vacancies) {
    if (!v.duplicateOf) continue;
    const list = map.get(v.duplicateOf) ?? [];
    list.push(v);
    map.set(v.duplicateOf, list);
  }
  return map;
}

function vacancyKeys(v: Vacancy, dups: Map<string, Vacancy[]>): string[] {
  return [
    `${v.fingerprint ?? ''}:${v.url}`,
    ...(dups.get(v.id) ?? []).map(d => `${d.fingerprint ?? ''}:${d.url}`),
  ];
}

// ─── Classification ───────────────────────────────────────────────────────────
// categorize() lives in watch-filter.ts so stack-stats.ts can reuse it without
// importing this file (Telegram bot, port lock and cron start on import here).

// ─── Scoring ──────────────────────────────────────────────────────────────────
function scoreVacancy(v: Vacancy, cfg: WatchConfig, cat: Category): ScoreResult {
  const lower = v.title.toLowerCase();
  for (const t of cfg.titleBlocklist)
    if (lower.includes(t.toLowerCase()))
      return { score: 0, matched: [], blocked: true, blockReason: `title:"${t}"` };

  if (v.salary?.includes('$')) {
    const nums = [...v.salary.replace(/,/g, '').matchAll(/\d+/g)]
      .map(m => Number(m[0])).filter(n => n > 500);
    if (nums.length && Math.max(...nums) < cfg.minSalaryUsd)
      return { score: 0, matched: [], blocked: true, blockReason: `salary<$${cfg.minSalaryUsd}` };
  }

  const gate = checkRemoteAndYears(v, { remoteOnly: cfg.remoteOnly, maxRequiredYears: cfg.maxRequiredYears });
  if (gate) return { score: 0, matched: [], blocked: true, blockReason: gate };
  const countryGate = checkCountries(v.countries);
  if (countryGate) return { score: 0, matched: [], blocked: true, blockReason: countryGate };

  // Foreign-stack filter (Part 2)
  const stacks = cfg.foreignStacks ?? [];
  if (stacks.length > 0) {
    const fr: FilterResult = checkForeignStackFilter(
      v.title, v.description, cat,
      stacks, cfg.foreignStackPenalty ?? -4, cfg.requireNodeInStack ?? true,
    );
    if (fr.blocked) return { score: 0, matched: [], blocked: true, blockReason: fr.reason };
    // Penalty is added to the score below
    var stackPenalty = fr.penalty;
  } else {
    var stackPenalty = 0;
  }

  let score = stackPenalty; // start with penalty (0 if no foreign-stack issue)
  const matched: string[] = [];
  const add = (w: number, l: string) => { score += w; matched.push(`${l}(${w > 0 ? '+' : ''}${w})`); };

  if (stackPenalty !== 0) matched.push(`stack(${stackPenalty > 0 ? '+' : ''}${stackPenalty})`);

  for (const [pat, w] of Object.entries(cfg.titleWeights))
    if (new RegExp(pat, 'i').test(v.title)) add(w, `t:${pat}`);

  const allSig = [...v.signals.languages, ...v.signals.llm, ...v.signals.aiTooling, ...v.signals.frontend];
  for (const [label, w] of Object.entries(cfg.signalWeights))
    if (allSig.includes(label)) add(w, `~${label}`);

  const full = `${v.title}\n${v.description}`;
  for (const [pat, w] of Object.entries(cfg.textWeights))
    if (new RegExp(pat, 'i').test(full)) add(w, `tx:${pat}`);

  return { score, matched, blocked: false };
}

// ─── Digest formatting ────────────────────────────────────────────────────────
function formatDigestItem(n: number, item: QueuedDigestItem): string {
  const lines = [`${n}. <b>${escapeHtml(item.title)}</b>`, item.company ? escapeHtml(item.company) : 'Unknown'];
  const meta: string[] = [];
  if (item.salary) meta.push(`💰 ${escapeHtml(item.salary)}`);
  if (item.remote) meta.push(`🌍 Remote`);
  if (item.location) meta.push(`📍 ${escapeHtml(item.location)}`);
  if (meta.length) lines.push(meta.join(' · '));
  const stack = [...new Set([...item.languages.slice(0, 3), ...item.llmSignals.slice(0, 3)])].join(', ');
  if (stack) lines.push(`🔧 ${escapeHtml(stack)}`);
  if (item.descSnippet) lines.push(escapeHtml(item.descSnippet));
  lines.push(item.url);
  return lines.join('\n') + '\n\n';
}

// Split into ≤4096-char messages; never cut a vacancy entry in half.
function buildDigestMessages(queue: QueuedDigestItem[], stats: DayStats, label = ''): string[] {
  const date = new Date().toISOString().slice(0, 10);
  const r = stats.rejectedByReason ?? { title: 0, required: 0, years: 0, noNode: 0, other: 0 };
  const notRemote = r.notRemote ?? 0, exp = r.exp ?? 0, country = r.country ?? 0;
  const totalRej = r.title + r.required + r.years + r.noNode + r.other + notRemote + exp + country;
  const rejLine = totalRej > 0
    ? `🚫 Відсіяно ${totalRej}: title ${r.title}, required ${r.required}, years ${r.years}, no-node ${r.noNode}, not-remote ${notRemote}, exp ${exp}, country ${country}\n`
    : '';
  const header = `📊 <b>Daily digest${label} – ${date}</b>\n` +
    `🟢 Alive · ${stats.runs} runs · ${stats.instantSent} instant · ${stats.failedRuns} failed\n` +
    rejLine + '\n';

  if (queue.length === 0) return [header + '<i>No new LLM/AI vacancies today</i>'];

  const messages: string[] = [];
  let cur = header + `<b>${queue.length} LLM/AI vacancies:</b>\n\n`;
  for (let i = 0; i < queue.length; i++) {
    const entry = formatDigestItem(i + 1, queue[i]);
    if (cur.length + entry.length > 4000) { messages.push(cur.trimEnd()); cur = entry; }
    else cur += entry;
  }
  if (cur.trim()) messages.push(cur.trimEnd());
  return messages;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID ?? '';
if (!BOT_TOKEN || !CHAT_ID) { console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env'); process.exit(1); }
const bot = new Bot(BOT_TOKEN);

async function sendRaw(text: string, kb?: InlineKeyboard, mode: 'HTML' | undefined = 'HTML'): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await bot.api.sendMessage(CHAT_ID, text, {
        parse_mode: mode, link_preview_options: { is_disabled: true }, reply_markup: kb,
      });
      return true;
    } catch (err: unknown) {
      const e = err as { error_code?: number; description?: string; message?: string; parameters?: { retry_after?: number } };
      if (e?.error_code === 429) {
        const wait = (e.parameters?.retry_after ?? 5) * 1000;
        await log(`Telegram 429, retry in ${Math.round(wait / 1000)}s`); await sleep(wait); continue;
      }
      if (mode === 'HTML' && e?.error_code === 400) {
        await log('Telegram HTML error, retrying plain');
        return sendRaw(text.replace(/<[^>]+>/g, ''), kb, undefined);
      }
      await log(`Telegram error (${e?.error_code ?? '?'}): ${e?.description ?? e?.message ?? String(err)}`);
      return false;
    }
  }
  return false;
}

const sendAlert = (text: string) => sendRaw(text, undefined, undefined);

// Human-readable labels for title-weight and text-weight regex patterns.
const PATTERN_LABELS: Record<string, string> = {
  'senior|lead': 'Senior', 'backend|node\\.?js': 'Backend', 'full.?stack': 'Fullstack',
  '\\bai\\b|\\bllm\\b|genai|gen\\s?ai': 'AI/LLM', 'frontend|front-end': 'Frontend',
  '\\breact\\.?js?\\b': 'React', 'nest\\.?js': 'NestJS', 'postgresql|postgres\\b': 'Postgres',
  '\\bredis\\b': 'Redis',
  '\\baws\\b|\\blambda\\b|\\bsqs\\b|\\becs\\b|\\bfargate\\b': 'AWS',
  'microservices?|rabbitmq|\\bkafka\\b|graphql': 'Microservices',
};

/** Convert raw matched[] entries to ≤8 human-readable labels sorted by weight desc. */
function matchedToLabels(matched: string[]): string[] {
  const parsed: { label: string; w: number }[] = [];
  for (const e of matched) {
    const m = e.match(/^(t:|tx:|~)?(.+)\(([+-]\d+)\)$/);
    if (!m) continue;
    const [, prefix, pat, wStr] = m;
    const w = Number(wStr);
    if (w <= 0) continue; // skip negative signals
    const label = prefix === '~'
      ? pat.trim()
      : (PATTERN_LABELS[pat.trim()] ??
         pat.split('|')[0].replace(/\\[bBdwWsS]/g, '').replace(/\\/g, '').trim());
    parsed.push({ label, w });
  }
  const seen = new Set<string>();
  return parsed
    .sort((a, b) => b.w - a.w)
    .filter(({ label }) => { if (seen.has(label)) return false; seen.add(label); return true; })
    .slice(0, 8)
    .map(({ label }) => label);
}

/** Escape HTML, then promote markdown headings/bold to HTML tags Telegram understands. */
function formatDescHtml(rawText: string, maxLen: number): string {
  return escapeHtml(truncateWords(rawText, maxLen))
    .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>')       // ## Heading → <b>Heading</b>
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')     // **bold** → <b>bold</b>
    .replace(/^\s*- /gm, '• ');                      // - list item → • list item
}

function buildVacancyMessage(v: Vacancy, r: ScoreResult, cat: Category): string {
  const lines = [
    `[${cat.toUpperCase()}] <b>${escapeHtml(v.title)}</b>`,
    `${v.company ? escapeHtml(v.company) : 'Unknown'} · ${v.source}`,
  ];
  const meta: string[] = [];
  if (v.salary) meta.push(`💰 ${escapeHtml(v.salary)}`);
  if (v.remote) meta.push(`🌍 Remote`);
  // Skip location if it just duplicates the remote flag (e.g. "Remote" / "віддалено").
  const locStr = v.location ?? '';
  if (locStr && !(v.remote && /remote|віддален|дистанц/i.test(locStr)))
    meta.push(`📍 ${escapeHtml(locStr)}`);
  if (v.experienceYears !== null) meta.push(`🧑‍💼 ${v.experienceYears}y exp`);
  if (v.englishLevel) meta.push(`🇬🇧 ${escapeHtml(v.englishLevel)}`);
  if (meta.length) lines.push(meta.join(' · '));
  lines.push(`🎯 ${r.score}: ${matchedToLabels(r.matched).join(', ')}`);
  if (v.description) lines.push(`<blockquote expandable>${formatDescHtml(v.description, 2500)}</blockquote>`);
  return lines.join('\n\n');
}

const sendVacancy = (v: Vacancy, r: ScoreResult, cat: Category) =>
  sendRaw(buildVacancyMessage(v, r, cat), new InlineKeyboard().url('Open vacancy', v.url));

// ─── Daily digest send ────────────────────────────────────────────────────────
async function sendDailyDigest(overrideQueue?: QueuedDigestItem[]): Promise<void> {
  const state = await loadState();
  const queue = overrideQueue ?? state.digestQueue;
  const label = overrideQueue ? ' (TEST)' : '';
  const messages = buildDigestMessages(queue, state.dayStats, label);

  let allOk = true;
  for (let i = 0; i < messages.length; i++) {
    if (!await sendRaw(messages[i])) { allOk = false; break; }
    if (i < messages.length - 1) await sleep(1000);
  }
  if (allOk && !overrideQueue) {
    state.digestQueue = [];
    await saveState(state);
    await log(`Digest sent: ${messages.length} msg(s), queue cleared`);
  }
}

// ─── Study app: applications queue + ready digest (client in watch-app.ts) ───
// APP_URL / APP_TOKEN come from .env. Without both, everything here is a no-op
// (one log line at startup), so the Telegram watcher keeps working unchanged.
const APP_URL   = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
const APP_TOKEN = (process.env.APP_TOKEN ?? '').trim();
const APP_CONFIGURED = APP_URL !== '' && APP_TOKEN !== '';
const appClient: AppClientOptions = { baseUrl: APP_URL, token: APP_TOKEN, timeoutMs: 15_000, log };

function appQueueEnabled(cfg: WatchConfig): boolean {
  return APP_CONFIGURED && (cfg.appQueueEnabled ?? true);
}

function toAppQueueItem(v: Vacancy, score: number): AppQueueItem {
  const source: AppSource = v.source === 'djinni' ? 'djinni' : 'dou';
  return {
    url: v.url,
    title: v.title,
    company: v.company ?? '',
    source,
    score,
    description: v.description,
  };
}

/** POST one match; a temporary failure parks it in state.appQueuePending for the next run. */
async function queueApplication(state: WatchState, item: AppQueueItem): Promise<void> {
  state.appQueuePending = await enqueueApplication(appClient, state.appQueuePending, item);
}

/** Retry parked POSTs once each. Returns true when state changed. */
async function flushAppQueuePending(state: WatchState, cfg: WatchConfig): Promise<boolean> {
  if (!appQueueEnabled(cfg) || state.appQueuePending.length === 0) return false;
  const result = await flushPending(appClient, state.appQueuePending);
  state.appQueuePending = result.pending;
  await log(`App queue: retried pending, sent=${result.sent} expired=${result.expired} still pending=${result.pending.length}`);
  return true;
}

/** GET ready applications and send one Telegram message. Nothing is sent on any failure or when N = 0. */
async function sendAppDigest(): Promise<void> {
  if (!APP_CONFIGURED) return;
  const items = await fetchReadyApplications(appClient);
  if (items === null) return;
  if (items.length === 0) { await log('App digest: 0 ready applications, nothing sent'); return; }
  const ok = await sendRaw(buildAppDigestMessage(items, APP_URL));
  await log(`App digest: ${items.length} ready, sent=${ok}`);
}

// ─── Rejected-vacancy log ────────────────────────────────────────────────────
async function logRejected(v: Vacancy, blockReason: string, dayStats: DayStats): Promise<void> {
  const entry = { date: new Date().toISOString(), title: v.title, url: v.url, blockReason };
  await appendFile(REJECTED_LOG, JSON.stringify(entry) + '\n').catch(() => {});
  const r = dayStats.rejectedByReason;
  if (blockReason.startsWith('title:'))    r.title++;
  else if (blockReason.startsWith('required:')) r.required++;
  else if (blockReason.startsWith('years:'))    r.years++;
  else if (blockReason === 'no-node')      r.noNode++;
  else if (blockReason === 'not-remote')   r.notRemote = (r.notRemote ?? 0) + 1;
  else if (blockReason.startsWith('exp>')) r.exp = (r.exp ?? 0) + 1;
  else if (blockReason.startsWith('country:')) r.country = (r.country ?? 0) + 1;
  else                                     r.other++;
}

// ─── Core run ─────────────────────────────────────────────────────────────────
let running = false;

async function watchRun(dryRun = false, testMode = false): Promise<void> {
  if (running && !testMode) { await log('Previous run in progress, skipping'); return; }
  running = true;
  try { await _watchRun(dryRun, testMode); }
  catch (err) { await log(`Unhandled error: ${err}`); }
  finally { running = false; }
}

async function _watchRun(dryRun: boolean, testMode: boolean): Promise<void> {
  await log(`Run start${dryRun ? ' (dry-run)' : testMode ? ' (test)' : ''}`);
  await mkdir(WATCH_DIR, { recursive: true });
  await mkdir('.cache',   { recursive: true });

  const [state, cfg] = await Promise.all([loadState(), loadConfig()]);

  // Reset day stats on UTC date change
  const today = new Date().toISOString().slice(0, 10);
  if (state.dayStats.date !== today)
    state.dayStats = { date: today, runs: 0, instantSent: 0, failedRuns: 0, rejectedByReason: { ...EMPTY_REJECTED } };
  if (!dryRun && !testMode) state.dayStats.runs++;

  // Study app POSTs that failed last time (endpoint down / not deployed yet) get one more try.
  if (!dryRun && !testMode && await flushAppQueuePending(state, cfg)) await saveState(state);

  const maxAgeMs   = (cfg.maxPublishedAgeDays ?? 3) * 86_400_000;
  const cutoffMs   = Date.now() - maxAgeMs;

  // IDs whose details should be fetched; populated after listing phase (non-dry-run).
  // The closure below captures this Set by reference so it sees updates made between phases.
  const newEligibleIds = new Set<string>();

  // Purge expired backoff entries and collect currently-blocked hosts
  const cycleStartMs = Date.now();
  const intervalMs = (cfg.cycleIntervalMinutes ?? 10) * 60_000;
  for (const [host, until] of Object.entries(state.hostBackoff)) {
    if (until <= cycleStartMs) delete state.hostBackoff[host];
  }
  const preBlockedHosts = new Set(
    Object.entries(state.hostBackoff).filter(([, until]) => until > cycleStartMs).map(([h]) => h),
  );

  const store = new Store();
  const ctx = makeCtx({
    out: path.join(WATCH_DIR, 'tmp.json'),
    maxPages: cfg.maxPagesPerQuery ?? 2,
    delayMs: 1500, limit: 0, only: [],
    skipDetails: false,
    fresh: false,
    cacheDir: '.cache', cacheTtlHours: 24,
    bypassCache: bypassListingCache,
    watchMode: true,
    stopBeforeMs: cutoffMs,
    detailFilter: dryRun
      ? undefined
      : (id: string) => !state.firstRunDone || newEligibleIds.has(id),
  }, store, false);

  // Pre-populate hosts that are still in backoff from previous cycles
  const ctxHttp = (ctx as { http: { blockedHosts: Set<string> } }).http;
  for (const host of preBlockedHosts) ctxHttp.blockedHosts.add(host);

  if (dryRun) {
    // Dry-run uses the full run() path (listings + all details).
    await scraperRun(ctx);
  } else {
    // Phase 1: collect listing pages only.
    await scraperCollect(ctx);

    // Phase 2: determine which vacancies are new + eligible so we skip stale detail fetches.
    if (state.firstRunDone) {
      const listed = buildOutput(ctx, true).vacancies;
      // Extract seen URLs from state keys (format: "${fingerprint}:${url}").
      const seenUrls = new Set(state.seenKeys.map(k => k.slice(k.indexOf(':') + 1)));
      for (const v of listed) {
        if (v.gone || v.duplicateOf) continue;
        if (v.publishedAt && Date.now() - new Date(v.publishedAt).getTime() > maxAgeMs) continue;
        if (!seenUrls.has(v.url)) newEligibleIds.add(v.id);
      }
      await log(`Pre-filter: ${listed.length} listed → ${newEligibleIds.size} new/eligible for detail fetch`);
    }

    // Phase 3: fetch details (filtered via detailFilter closure above).
    await scraperFetchDetails(ctx);
  }
  const output = buildOutput(ctx, false);

  // Persist any newly-blocked hosts into state.hostBackoff for future cycles
  if (!dryRun && !testMode) {
    const backoffMs = (cfg.hostBackoffCycles ?? 3) * intervalMs;
    for (const host of ctxHttp.blockedHosts) {
      if (!preBlockedHosts.has(host)) {
        state.hostBackoff[host] = cycleStartMs + backoffMs;
        await log(`Host ${host} in backoff for ${cfg.hostBackoffCycles ?? 3} cycles`);
      }
    }
  }

  const { queries } = output.meta;
  const allFailed = queries.length > 0 && queries.every(q => q.error);

  if (allFailed || output.vacancies.length === 0) {
    const reason = allFailed
      ? `All ${queries.length} queries failed. First: ${queries[0]?.error ?? '?'}`
      : 'Scraper returned 0 vacancies';
    await log(`Scraper failure: ${reason}`);
    if (!dryRun && !testMode) {
      state.consecutiveFailures++;
      state.dayStats.failedRuns++;
      const every = cfg.alertEveryNFailures ?? 6;
      if (state.consecutiveFailures === 1 || state.consecutiveFailures - state.lastAlertRun >= every) {
        state.lastAlertRun = state.consecutiveFailures;
        await sendAlert(`⚠️ Watcher: scraper failed (#${state.consecutiveFailures})\n${reason}`);
      }
      await saveState(state);
    }
    return;
  }

  if (state.consecutiveFailures > 0 && !dryRun && !testMode) {
    state.consecutiveFailures = 0; state.lastAlertRun = 0;
    await sendAlert('✅ Watcher: scraper is working again');
  }

  const failedQ = queries.filter(q => q.error);
  if (failedQ.length) await log(`Partial: ${failedQ.length} query failures — ${failedQ.map(q => q.id).join(', ')}`);
  await log(`Scraper: ${output.vacancies.length} total`);

  const duplicatesOf = buildDuplicatesMap(output.vacancies);
  const now = Date.now();

  // eligible: not gone, not a duplicate, not too old
  const eligible = output.vacancies.filter(v =>
    !v.gone && !v.duplicateOf &&
    (!v.publishedAt || now - new Date(v.publishedAt).getTime() <= maxAgeMs),
  );

  if (testMode) { await runTestMode(eligible, duplicatesOf, cfg); return; }

  // ── Dry-run: always show all eligible, ignore seen state ─────────────────
  // (useful even before the first real `npm run watch` run; shows everything for weight tuning)
  if (dryRun) {
    const withDesc = eligible.filter(v => v.description.trim().length > 0);
    const noDesc   = eligible.filter(v => v.description.trim().length === 0);
    const eligibleIds = new Set(eligible.map(v => v.id));
    const skipped  = output.vacancies.filter(v => !eligibleIds.has(v.id));
    runDryRun(withDesc, noDesc, eligible, cfg, skipped);
    return;
  }

  const seenSet = new Set(state.seenKeys);

  // ── First run: index everything ───────────────────────────────────────────
  if (!state.firstRunDone) {
    for (const v of output.vacancies) vacancyKeys(v, duplicatesOf).forEach(k => seenSet.add(k));
    state.seenKeys = [...seenSet];
    state.firstRunDone = true;
    await sendAlert(`👁 Watcher started. ${output.vacancies.length} vacancies indexed.`);
    await saveState(state);
    await log(`First run: indexed ${output.vacancies.length}`);
    return;
  }

  const newVacancies = eligible.filter(v => vacancyKeys(v, duplicatesOf).every(k => !seenSet.has(k)));

  // Description guard with 3-attempt cap.
  // Each run where a vacancy still has no description increments its retry counter.
  // After 3 failed attempts the vacancy is scored on title + signals (description = '').
  const withDesc: Vacancy[] = [];
  const retryNext: Vacancy[] = [];

  for (const v of newVacancies) {
    if (v.description.trim().length > 0) {
      withDesc.push(v);
    } else {
      const key     = `${v.fingerprint ?? ''}:${v.url}`;
      const attempt = (state.noDescRetries[key] ?? 0) + 1;
      if (attempt >= 3) {
        delete state.noDescRetries[key];
        withDesc.push(v); // score on title + signals; description stays ''
        await log(`no-desc cap: scoring "${v.title.slice(0, 50)}" after ${attempt} attempts`);
      } else {
        state.noDescRetries[key] = attempt;
        retryNext.push(v);
      }
    }
  }

  if (retryNext.length) await log(`${retryNext.length} vacancies missing description (attempt <3), retry next run`);
  await log(`Eligible: ${eligible.length}  New: ${newVacancies.length}  Scoreable: ${withDesc.length}  RetryNext: ${retryNext.length}`);

  // ── Classify → route ─────────────────────────────────────────────────────
  const toSend:  Array<{ v: Vacancy; result: ScoreResult; cat: Category }> = [];
  const toQueue: QueuedDigestItem[] = [];

  for (const v of withDesc) {
    const cat      = categorize(v);
    const result   = scoreVacancy(v, cfg, cat);
    const minScore = cfg.categoryMinScore?.[cat] ?? cfg.minScore ?? 8;

    if (cat === 'other' || result.blocked || result.score < minScore) {
      if (result.blocked && result.blockReason && !result.blockReason.startsWith('title:"') && !result.blockReason.startsWith('salary')) {
        // Log foreign-stack blocks (not legacy title-blocklist or salary blocks)
        await logRejected(v, result.blockReason, state.dayStats);
      }
      vacancyKeys(v, duplicatesOf).forEach(k => seenSet.add(k));
      state.seenKeys = [...seenSet];
      continue;
    }

    if (INSTANT_CATS.has(cat)) {
      toSend.push({ v, result, cat });
    } else {
      // llm-pure → digest; mark seen when queued
      toQueue.push({
        id: v.id, url: v.url, title: v.title, company: v.company,
        salary: v.salary, remote: v.remote, location: v.location,
        experienceYears: v.experienceYears,
        descSnippet: truncateWords(v.description, 500),
        languages: v.signals.languages,
        llmSignals: v.signals.llm.slice(0, 5),
        score: result.score, matched: result.matched,
        queuedAt: new Date().toISOString(),
      });
      vacancyKeys(v, duplicatesOf).forEach(k => seenSet.add(k));
      state.seenKeys = [...seenSet];
    }
  }

  if (toQueue.length) {
    state.digestQueue.push(...toQueue);
    await saveState(state);
    await log(`Queued ${toQueue.length} llm-pure for digest`);
  }

  toSend.sort((a, b) => b.result.score - a.result.score);
  if (toSend.length > MAX_MSGS_PER_RUN)
    await log(`${toSend.length} instant matches, capping at ${MAX_MSGS_PER_RUN}`);

  let sent = 0;
  let appQueued = 0;
  for (const { v, result, cat } of toSend) {
    if (sent >= MAX_MSGS_PER_RUN) break;
    if (await sendVacancy(v, result, cat)) {
      vacancyKeys(v, duplicatesOf).forEach(k => seenSet.add(k));
      state.seenKeys = [...seenSet];
      state.dayStats.instantSent++;
      // Same vacancy goes to the study app queue; a failure there is only logged.
      if (appQueueEnabled(cfg)) { await queueApplication(state, toAppQueueItem(v, result.score)); appQueued++; }
      await saveState(state);
      sent++;
      if (sent < Math.min(toSend.length, MAX_MSGS_PER_RUN)) await sleep(1000);
    }
  }

  await saveState(state);
  await log(`Run complete: instant=${sent} app-queue=${appQueued} queued=${toQueue.length} retry-next=${retryNext.length}`);
}

// ─── Dry-run output ───────────────────────────────────────────────────────────
/** Why a vacancy never reached scoring (gone / duplicate / too old). */
function skipReason(v: Vacancy, maxAgeDays: number): string {
  if (v.gone) return 'gone';
  if (v.duplicateOf) return `duplicate of ${v.duplicateOf}`;
  if (v.publishedAt) {
    const days = Math.floor((Date.now() - new Date(v.publishedAt).getTime()) / 86_400_000);
    return `published ${days}d ago (limit ${maxAgeDays}d)`;
  }
  return 'unknown';
}

function runDryRun(
  withDesc: Vacancy[], noDesc: Vacancy[], eligible: Vacancy[], cfg: WatchConfig,
  skipped: Vacancy[] = [],
): void {
  const all = [...withDesc, ...noDesc];
  if (all.length === 0) { console.log('[dry-run] No new vacancies'); return; }
  console.log(`\n[dry-run] ${all.length} new  (${eligible.length} eligible, duplicates excluded)\n${'─'.repeat(74)}`);

  type Row = { v: Vacancy; result: ScoreResult | null; noDesc: boolean };
  const byCat = new Map<Category, Row[]>([
    ['backend', []], ['frontend', []], ['fullstack', []], ['llm-pure', []], ['other', []],
  ]);

  for (const v of noDesc) {
    const cat = categorize(v);
    byCat.get(cat)!.push({ v, result: null, noDesc: true });
  }
  for (const v of withDesc) {
    const cat = categorize(v);
    byCat.get(cat)!.push({ v, result: scoreVacancy(v, cfg, cat), noDesc: false });
  }

  const catMin = (cat: Category) => cfg.categoryMinScore?.[cat] ?? cfg.minScore ?? 8;

  for (const [cat, rows] of byCat) {
    if (rows.length === 0) continue;
    const mode     = cat === 'llm-pure' ? 'DIGEST' : cat === 'other' ? 'IGNORE' : 'INSTANT';
    const notify   = rows.filter(r => !r.noDesc && r.result && !r.result.blocked && r.result.score >= catMin(cat));
    const blocked  = rows.filter(r => r.result?.blocked);
    const below    = rows.filter(r => !r.noDesc && r.result && !r.result.blocked && r.result.score < catMin(cat));
    const missing  = rows.filter(r => r.noDesc);

    console.log(`\n[${mode}] ${cat.toUpperCase()}  total=${rows.length}  notify/queue=${notify.length}  blocked=${blocked.length}  below=${below.length}  no-desc=${missing.length}`);
    for (const { v, result } of notify.slice(0, 8)) {
      const title = v.title.slice(0, 46).padEnd(48);
      const co    = (v.company ?? '?').slice(0, 18).padEnd(20);
      console.log(`  [${String(result!.score).padStart(3)}] ${title} ${co} ${v.source}`);
      console.log(`        ${result!.matched.join(' ')}`);
    }
    if (notify.length > 8) console.log(`        … ${notify.length - 8} more`);

    // Everything that did NOT pass, with the reason (so a missing vacancy can be found here).
    const line = (v: Vacancy, tag: string) =>
      console.log(`  ${tag} ${v.title.slice(0, 46).padEnd(48)} ${(v.company ?? '?').slice(0, 18).padEnd(20)} ${v.source}`);
    for (const { v, result } of blocked) line(v, `[skip: ${result!.blockReason}]`);
    for (const { v, result } of below)   line(v, `[low: ${result!.score}<${catMin(cat)}]`);
    for (const { v } of missing)         line(v, '[no description]');
  }

  if (skipped.length > 0) {
    console.log(`\n[SKIPPED BEFORE SCORING] ${skipped.length}`);
    for (const v of skipped)
      console.log(`  [${skipReason(v, cfg.maxPublishedAgeDays ?? 3)}] ${v.title.slice(0, 46).padEnd(48)} ${(v.company ?? '?').slice(0, 18).padEnd(20)} ${v.source}`);
  }
  console.log(`\n${'─'.repeat(74)}`);
}

// ─── Test mode ────────────────────────────────────────────────────────────────
async function runTestMode(eligible: Vacancy[], duplicatesOf: Map<string, Vacancy[]>, cfg: WatchConfig): Promise<void> {
  await log('Test mode: sending examples to Telegram');
  const catMin = (cat: Category) => cfg.categoryMinScore?.[cat] ?? cfg.minScore ?? 8;

  const scored = eligible
    .filter(v => v.description.trim().length > 0) // require description in test too
    .map(v => { const cat = categorize(v); return { v, cat, result: scoreVacancy(v, cfg, cat) }; })
    .filter(({ cat, result }) => cat !== 'other' && !result.blocked && result.score >= catMin(cat));

  for (const cat of ['backend', 'frontend', 'fullstack'] as Category[]) {
    const top = scored.filter(x => x.cat === cat).sort((a, b) => b.result.score - a.result.score)[0];
    if (!top) { await log(`test: no qualifying ${cat} vacancy`); continue; }
    const ok = await sendVacancy(top.v, top.result, top.cat);
    await log(`test: sent ${cat} — "${top.v.title.slice(0, 50)}" ok=${ok}`);
    await sleep(1500);
  }

  const llmTop: QueuedDigestItem[] = scored
    .filter(x => x.cat === 'llm-pure')
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, 5)
    .map(x => ({
      id: x.v.id, url: x.v.url, title: x.v.title, company: x.v.company,
      salary: x.v.salary, remote: x.v.remote, location: x.v.location,
      experienceYears: x.v.experienceYears,
      descSnippet: truncateWords(x.v.description, 500),
      languages: x.v.signals.languages,
      llmSignals: x.v.signals.llm.slice(0, 5),
      score: x.result.score, matched: x.result.matched,
      queuedAt: new Date().toISOString(),
    }));

  await sendDailyDigest(llmTop);
  await log(`test: digest sent (${llmTop.length} llm-pure items)`);

  // Read-only check of the study app integration; test mode never POSTs to the queue.
  if (APP_CONFIGURED) {
    await sendAppDigest();
    await log('test: app digest attempted (see lines above)');
  }
}

// ─── Process-level error guards (keep the process alive on uncaught errors) ───
process.on('unhandledRejection', reason => { log(`unhandledRejection: ${reason}`).catch(() => {}); });
process.on('uncaughtException',  err    => { log(`uncaughtException: ${err}`).catch(() => {}); });

// ─── Single-instance lock (port-based) ───────────────────────────────────────
// Bind a local TCP port for the lifetime of the process.
// The OS releases the port unconditionally when the process dies (no stale locks).
await new Promise<void>((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(LOCK_PORT, '127.0.0.1', () => resolve());
  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Watcher already running');
      process.exit(1);
    }
    reject(err);
  });
});

const stop = (signal: string) => () => {
  console.log(`Received ${signal}, exiting`);
  process.exit(0);
};
process.on('SIGINT',  stop('SIGINT'));
process.on('SIGHUP',  stop('SIGHUP'));

// ─── Active-hours guard (Europe/Kyiv, 08:00–23:00) ───────────────────────────
function isWithinActiveHours(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  return h >= 8 && h < 23;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const isDryRun  = process.argv.includes('--dry-run');
const isTest    = process.argv.includes('--test');

if (!APP_CONFIGURED) await log('Study app integration off: set APP_URL and APP_TOKEN in .env to enable the queue and the ready digest');

if (isDryRun) {
  await watchRun(true);
} else if (isTest) {
  await watchRun(false, true);
} else {
  const cfg = await loadConfig();

  // Immediate run on process start — skip outside active hours.
  // Apply startup jitter (0–cycleJitterSeconds) so concurrent restarts don't pile up.
  if (isWithinActiveHours()) {
    const startJitter = Math.random() * (cfg.cycleJitterSeconds ?? 90) * 1_000;
    if (startJitter > 2_000) {
      await log(`Startup jitter: ${Math.round(startJitter / 1000)}s`);
      await sleep(startJitter);
    }
    await watchRun();
  } else {
    await log('Process started outside active hours (08:00–23:00 Kyiv), skipping immediate run');
  }

  const cycleMin    = cfg.cycleIntervalMinutes ?? 10;
  const jitterMs    = (cfg.cycleJitterSeconds  ?? 90) * 1_000;
  const cycleCron   = `*/${cycleMin} 8-22 * * *`;

  schedule(cfg.digestCron ?? '0 19 * * *', async () => {
    await log('Digest cron fired');
    await sendDailyDigest();
  });

  // "У черзі N готових заявок": same mechanism as the llm-pure digest, machine-local time.
  const appDigestCron = cfg.appDigestCron ?? '0 20 * * *';
  if (APP_CONFIGURED && appDigestCron !== '') {
    if (validateCron(appDigestCron)) {
      schedule(appDigestCron, async () => {
        await log('App digest cron fired');
        await sendAppDigest();
      });
      await log(`App digest scheduled (cron ${appDigestCron})`);
    } else {
      await log(`Invalid appDigestCron "${appDigestCron}", app digest disabled`);
    }
  }

  schedule(cycleCron, async () => {
    const jitter = Math.random() * jitterMs;
    await log(`Scheduled run in ${Math.round(jitter / 1000)}s`);
    await sleep(jitter);
    await watchRun();
  }, { timezone: 'Europe/Kyiv' });

  await log(`Watcher scheduled (cron ${cycleCron} Europe/Kyiv, jitter 0–${cfg.cycleJitterSeconds ?? 90}s)`);
}
