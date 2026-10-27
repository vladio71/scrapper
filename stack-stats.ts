/**
 * stack-stats.ts
 *
 * Which technologies the backend + fullstack vacancies of the last N days ask for.
 *
 * Input: vacancies.json written by `npm run scrape` (the watcher keeps nothing but raw
 * HTML in .cache/, so the scrape output is the only structured store of vacancies).
 * Technologies and their aliases: stack-stats.config.json.
 *
 *   npm run stack-stats                     table, last 60 days (config "days")
 *   npm run stack-stats -- --days=30
 *   npm run stack-stats -- --json           machine-readable output
 *   npm run stack-stats -- --input=other.json --config=other.config.json
 *
 * Exit code 1 when the input file is missing or unreadable.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { categorize, type Category, type CategorySignals } from './watch-filter.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TechnologyConfig {
  name: string;
  /** Case-insensitive whole-word aliases. */
  aliases: string[];
  /** Exact-case whole-word aliases, for names that are also plain English words. */
  caseSensitiveAliases?: string[];
}

export interface StackStatsConfig {
  days: number;
  categories: Category[];
  technologies: TechnologyConfig[];
}

export interface CompiledTechnology {
  name: string;
  patterns: RegExp[];
}

/** The subset of a scraper Vacancy that the statistics need. */
export interface StatsVacancy {
  url: string;
  title: string;
  description: string;
  publishedAt: string | null;
  duplicateOf: string | null;
  gone: boolean;
  signals: CategorySignals;
}

export interface SkippedCounts {
  duplicates: number;
  gone: number;
  otherCategory: number;
  tooOld: number;
  undated: number;
}

export interface TechnologyStat {
  name: string;
  count: number;
  /** Share of the analysed vacancies, 0..100 with one decimal. */
  percent: number;
}

export interface StackStats {
  generatedAt: string;
  input: string;
  inputGeneratedAt: string | null;
  days: number;
  categories: Category[];
  totalInInput: number;
  analysed: number;
  dateRange: { from: string; to: string } | null;
  skipped: SkippedCounts;
  technologies: TechnologyStat[];
}

interface CliOptions {
  input: string;
  config: string;
  days: number | null;
  json: boolean;
}

interface VacancyFile {
  generatedAt: string | null;
  vacancies: StatsVacancy[];
}

/** One element of the input JSON before validation. */
interface RawVacancy {
  url?: unknown;
  title?: unknown;
  description?: unknown;
  publishedAt?: unknown;
  duplicateOf?: unknown;
  gone?: unknown;
  signals?: RawSignals;
}

interface RawSignals {
  languages?: unknown;
  frontend?: unknown;
  llm?: unknown;
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];

// ─── Alias matching ───────────────────────────────────────────────────────────
// Whole word without \b: \b is ASCII-only and fails for aliases that start or end
// with a non-word character (".net", "c++"). A letter, digit or underscore directly
// before or after the alias prevents a match, so "go" never matches inside "mongo".

const NOT_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NOT_AFTER  = '(?![\\p{L}\\p{N}_])';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function aliasToRegExp(alias: string, caseSensitive: boolean): RegExp {
  const body = escapeRegExp(alias.trim())
    .replace(/\s+/g, '\\s*')        // "node js" also matches "nodejs" and "node  js"
    .replace(/\//g, '\\s*\\/\\s*');  // "ci/cd" also matches "ci / cd"
  return new RegExp(`${NOT_BEFORE}${body}${NOT_AFTER}`, caseSensitive ? 'u' : 'iu');
}

export function compileTechnologies(technologies: TechnologyConfig[]): CompiledTechnology[] {
  return technologies.map((t) => ({
    name: t.name,
    patterns: [
      ...t.aliases.map((a) => aliasToRegExp(a, false)),
      ...(t.caseSensitiveAliases ?? []).map((a) => aliasToRegExp(a, true)),
    ],
  }));
}

/** Names of the technologies mentioned in the text, each at most once. */
export function matchTechnologies(text: string, compiled: CompiledTechnology[]): string[] {
  return compiled.filter((t) => t.patterns.some((re) => re.test(text))).map((t) => t.name);
}

// ─── Statistics ───────────────────────────────────────────────────────────────

export function computeStats(
  vacancies: StatsVacancy[],
  cfg: StackStatsConfig,
  compiled: CompiledTechnology[],
  nowMs: number,
  meta: { input: string; inputGeneratedAt: string | null },
): StackStats {
  const cutoffMs = nowMs - cfg.days * 86_400_000;
  const skipped: SkippedCounts = { duplicates: 0, gone: 0, otherCategory: 0, tooOld: 0, undated: 0 };
  const counts = new Map<string, number>(compiled.map((t) => [t.name, 0]));
  let analysed = 0;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;

  for (const v of vacancies) {
    if (v.gone) { skipped.gone++; continue; }
    if (v.duplicateOf) { skipped.duplicates++; continue; }
    if (!cfg.categories.includes(categorize(v))) { skipped.otherCategory++; continue; }
    const publishedMs = v.publishedAt ? new Date(v.publishedAt).getTime() : Number.NaN;
    if (Number.isNaN(publishedMs)) { skipped.undated++; continue; }
    if (publishedMs < cutoffMs) { skipped.tooOld++; continue; }

    analysed++;
    minMs = Math.min(minMs, publishedMs);
    maxMs = Math.max(maxMs, publishedMs);
    for (const name of matchTechnologies(`${v.title}\n${v.description}`, compiled)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const technologies: TechnologyStat[] = [...counts.entries()]
    .map(([name, count]) => ({
      name,
      count,
      percent: analysed === 0 ? 0 : Math.round((count / analysed) * 1000) / 10,
    }))
    .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    input: meta.input,
    inputGeneratedAt: meta.inputGeneratedAt,
    days: cfg.days,
    categories: cfg.categories,
    totalInInput: vacancies.length,
    analysed,
    dateRange: analysed === 0 ? null : { from: isoDay(minMs), to: isoDay(maxMs) },
    skipped,
    technologies,
  };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ─── Output ───────────────────────────────────────────────────────────────────

export function formatTable(stats: StackStats): string {
  const lines: string[] = [];
  const range = stats.dateRange ? `${stats.dateRange.from} .. ${stats.dateRange.to}` : 'no vacancies in the window';
  lines.push(`Stack stats: ${stats.analysed} vacancies (${stats.categories.join(' + ')}), published ${range}, last ${stats.days} days`);
  const generated = stats.inputGeneratedAt ? `, scraped ${stats.inputGeneratedAt.slice(0, 16).replace('T', ' ')}` : '';
  const s = stats.skipped;
  lines.push(
    `Input: ${stats.input} (${stats.totalInInput} vacancies${generated}); skipped: ` +
    `${s.otherCategory} other category, ${s.tooOld} older than ${stats.days} days, ${s.duplicates} duplicates, ${s.gone} gone, ${s.undated} without date`,
  );
  lines.push('');
  if (stats.analysed === 0) {
    lines.push('Nothing to count. Run `npm run scrape` first or widen the window with --days=N.');
    return lines.join('\n');
  }
  const nameWidth = Math.max(10, ...stats.technologies.map((t) => t.name.length));
  lines.push(`${'Technology'.padEnd(nameWidth)}  ${'Count'.padStart(5)}  ${'Percent'.padStart(7)}`);
  lines.push(`${'-'.repeat(nameWidth)}  ${'-'.repeat(5)}  ${'-'.repeat(7)}`);
  for (const t of stats.technologies) {
    lines.push(`${t.name.padEnd(nameWidth)}  ${String(t.count).padStart(5)}  ${`${t.percent.toFixed(1)}%`.padStart(7)}`);
  }
  return lines.join('\n');
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      input:  { type: 'string',  default: 'vacancies.json' },
      config: { type: 'string',  default: 'stack-stats.config.json' },
      days:   { type: 'string' },
      json:   { type: 'boolean', default: false },
    },
  });
  let days: number | null = null;
  if (values.days !== undefined) {
    const n = Number(values.days);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--days must be a positive integer, got: ${values.days}`);
    days = n;
  }
  return {
    input: values.input ?? 'vacancies.json',
    config: values.config ?? 'stack-stats.config.json',
    days,
    json: values.json ?? false,
  };
}

export async function loadConfig(file: string): Promise<StackStatsConfig> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<StackStatsConfig>;
  if (!Array.isArray(raw.technologies) || raw.technologies.length === 0) {
    throw new Error(`${file}: "technologies" must be a non-empty array`);
  }
  for (const t of raw.technologies) {
    if (typeof t.name !== 'string' || !Array.isArray(t.aliases)) {
      throw new Error(`${file}: every technology needs "name" and "aliases"`);
    }
  }
  return {
    days: typeof raw.days === 'number' && raw.days > 0 ? raw.days : 60,
    categories: Array.isArray(raw.categories) && raw.categories.length > 0 ? raw.categories : ['backend', 'fullstack'],
    technologies: raw.technologies,
  };
}

/** Accepts the scraper Output ({ meta, vacancies }) or a bare array; fills missing fields with defaults. */
export async function readVacancyFile(file: string): Promise<VacancyFile> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  let list: unknown[];
  let generatedAt: string | null = null;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { vacancies?: unknown }).vacancies)) {
    const out = parsed as { vacancies: unknown[]; meta?: { generatedAt?: unknown } };
    list = out.vacancies;
    generatedAt = typeof out.meta?.generatedAt === 'string' ? out.meta.generatedAt : null;
  } else {
    throw new Error(`${file}: expected { vacancies: [...] } or an array`);
  }

  const vacancies: StatsVacancy[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const v = raw as RawVacancy;
    const signals: RawSignals = v.signals ?? {};
    vacancies.push({
      url: typeof v.url === 'string' ? v.url : '',
      title: typeof v.title === 'string' ? v.title : '',
      description: typeof v.description === 'string' ? v.description : '',
      publishedAt: typeof v.publishedAt === 'string' ? v.publishedAt : null,
      duplicateOf: typeof v.duplicateOf === 'string' ? v.duplicateOf : null,
      gone: v.gone === true,
      signals: {
        languages: stringArray(signals.languages),
        frontend:  stringArray(signals.frontend),
        llm:       stringArray(signals.llm),
      },
    });
  }
  return { generatedAt, vacancies };
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const cfg = await loadConfig(opts.config);
  if (opts.days !== null) cfg.days = opts.days;

  let file: VacancyFile;
  try {
    file = await readVacancyFile(opts.input);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(code === 'ENOENT'
      ? `${opts.input} not found. Run \`npm run scrape\` first (writes vacancies.json) or pass --input=<file>.`
      : `Cannot read ${opts.input}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const stats = computeStats(file.vacancies, cfg, compileTechnologies(cfg.technologies), Date.now(), {
    input: opts.input,
    inputGeneratedAt: file.generatedAt,
  });
  console.log(opts.json ? JSON.stringify(stats, null, 2) : formatTable(stats));
}

// Tests import this module with STACK_STATS_NO_MAIN=1 (same pattern as SCRAPER_NO_MAIN in scrape-jobs.ts).
if (!process.env.STACK_STATS_NO_MAIN) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
