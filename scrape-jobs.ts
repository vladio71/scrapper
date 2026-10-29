/**
 * ua-jobs-scraper: збирає вакансії з jobs.dou.ua та djinni.co в один JSON
 * для аналізу вимог (Node.js / Fullstack Node.js / AI-LLM).
 *
 * Запуск (Node 20+):
 *   npm i
 *   npm run scrape -- --limit=5     # швидка перевірка: до 5 сторінок-деталок на джерело
 *   npm run scrape                  # повний прогін (~10–20 хв через паузи між запитами)
 *
 * Прапорці:
 *   --out=vacancies.json   куди писати результат
 *   --max-pages=5          скільки разів догружати кожен список (DOU «Більше вакансій» / сторінки Djinni)
 *   --delay=1500           базова пауза між запитами, мс (+ до 50% випадкового джитера)
 *   --limit=0              ліміт сторінок-деталок на джерело (0 = без ліміту)
 *   --only=dou             лише вибрані джерела або id запитів через кому (напр. dou,djinni-node)
 *   --skip-details         не відкривати сторінки окремих вакансій
 *   --fresh                ігнорувати кеш у .cache/
 *
 * Необов'язкові змінні середовища:
 *   DJINNI_COOKIE   cookie залогіненої сесії Djinni (для аналізу вимог не потрібен)
 *   SCRAPER_UA      власний User-Agent
 *
 * Djinni: скрипт сам перевіряє на кількох вакансіях, чи тексти у списку повні,
 * і відкриває окремі сторінки лише тоді, коли це справді потрібно.
 *
 * Скрипт не обходить капчі та Cloudflare-челенджі: якщо сайт їх показує,
 * хост позначається як заблокований і запити до нього припиняються.
 * Ctrl+C зберігає те, що вже зібрано (meta.partial = true).
 */
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

// ─── Запити ────────────────────────────────────────────────────────────────
// URL-патерни перевірені вручну (вересень 2026). Якщо запит повертає 0 вакансій,
// відкрий URL у браузері та підправ його тут.

export type Source = 'dou' | 'djinni';
export type Track = 'node' | 'fullstack' | 'ai';

export interface Query {
  id: string;
  source: Source;
  track: Track;
  url: string;
  /** перекриває --max-pages для «широких» запитів */
  maxPages?: number;
}

export const QUERIES: Query[] = [
  // DOU: категорія Node.js, досвід 3–5 і 5+ років
  { id: 'dou-node-3-5', source: 'dou', track: 'node', url: 'https://jobs.dou.ua/vacancies/?category=Node.js&exp=3-5' },
  {
    id: 'dou-node-5plus',
    source: 'dou',
    track: 'node',
    url: 'https://jobs.dou.ua/vacancies/?category=Node.js&exp=5plus',
  },
  // DOU: fullstack за назвою в усіх категоріях (стек фільтрується при аналізі).
  // Пошук «full stack» на DOU дає ті самі результати, що й «fullstack», тому окремо не запитуємо.
  {
    id: 'dou-fullstack-3-5',
    source: 'dou',
    track: 'fullstack',
    url: 'https://jobs.dou.ua/vacancies/?search=fullstack&exp=3-5',
  },
  {
    id: 'dou-fullstack-5plus',
    source: 'dou',
    track: 'fullstack',
    url: 'https://jobs.dou.ua/vacancies/?search=fullstack&exp=5plus',
  },
  // DOU: категорія AI/ML + «LLM» в описах усіх вакансій (descr=1).
  // Догрузка сама зупиняється на лічильнику сайту, тож високий ліміт лише страхує.
  { id: 'dou-aiml', source: 'dou', track: 'ai', url: 'https://jobs.dou.ua/vacancies/?category=AI%2FML', maxPages: 10 },
  {
    id: 'dou-llm-in-descr',
    source: 'dou',
    track: 'ai',
    url: 'https://jobs.dou.ua/vacancies/?search=LLM&descr=1',
    maxPages: 10,
  },
  // Djinni (ліміт сторінок з --max-pages)
  { id: 'djinni-node', source: 'djinni', track: 'node', url: 'https://djinni.co/jobs/?primary_keyword=Node.js' },
  {
    id: 'djinni-fullstack',
    source: 'djinni',
    track: 'fullstack',
    url: 'https://djinni.co/jobs/?primary_keyword=Fullstack',
  },
  { id: 'djinni-ml-ai', source: 'djinni', track: 'ai', url: 'https://djinni.co/jobs/keyword-ml_ai/' },
  {
    id: 'djinni-ml-ai-engineer',
    source: 'djinni',
    track: 'ai',
    url: 'https://djinni.co/jobs/category-ml-ai-engineer/',
  },
  // Frontend queries (track: 'fullstack' — closest available; watcher's own categorize() routes them correctly)
  { id: 'dou-frontend-3-5',  source: 'dou',    track: 'fullstack', url: 'https://jobs.dou.ua/vacancies/?category=Front+End&exp=3-5' },
  { id: 'dou-frontend-5plus', source: 'dou',   track: 'fullstack', url: 'https://jobs.dou.ua/vacancies/?category=Front+End&exp=5plus' },
  { id: 'djinni-react',      source: 'djinni', track: 'fullstack', url: 'https://djinni.co/jobs/?primary_keyword=React' },
  { id: 'djinni-nextjs',     source: 'djinni', track: 'fullstack', url: 'https://djinni.co/jobs/?primary_keyword=Next.js' },
];

// ─── Типи результату ───────────────────────────────────────────────────────

export type DescOrigin = 'jsonld' | 'html' | 'rss' | 'listing' | 'fallback';

export interface Signals {
  /** LLM-інженерія в продукті: RAG, embeddings, агенти, evals... */
  llm: string[];
  /** AI-інструменти для розробки: Claude Code, Cursor, Copilot... */
  aiTooling: string[];
  languages: string[];
  frontend: string[];
}

export interface Vacancy {
  id: string;
  source: Source;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  salary: string | null;
  publishedAt: string | null;
  experienceYears: number | null;
  /** meta = з картки/JSON-LD, text = знайдено регуляркою в описі */
  experienceFrom: 'meta' | 'text' | null;
  englishLevel: string | null;
  remote: boolean | null;
  /** Djinni: «Countries where we consider candidates» (вільний текст: Poland, Countries of Europe or Ukraine) */
  countries: string | null;
  views: number | null;
  applications: number | null;
  /** id запитів, якими вакансію знайдено */
  foundBy: string[];
  queryTracks: Track[];
  /** треки за змістом (класифікатор нижче) */
  tracks: Track[];
  signals: Signals;
  /** текст зі збереженою структурою: «- » для пунктів, «## » для заголовків */
  description: string;
  descriptionSource: DescOrigin | 'none';
  /** хеш початку опису: однакові тексти на DOU і Djinni мають однаковий fingerprint */
  fingerprint: string | null;
  duplicateOf: string | null;
  /** сторінка вакансії повернула 404/410 */
  gone: boolean;
}

// ─── Опції ─────────────────────────────────────────────────────────────────

export interface Options {
  out: string;
  maxPages: number;
  delayMs: number;
  limit: number;
  only: string[];
  skipDetails: boolean;
  fresh: boolean;
  cacheDir: string;
  cacheTtlHours: number;
  /** If provided, called before reading from cache. Return true to skip cache for this request. */
  bypassCache?: (url: string, method: string) => boolean;
  /** Watch/test mode: DOU category queries use RSS only; DOU search queries skip xhr-load;
   *  combined with stopBeforeMs for early Djinni pagination stop. */
  watchMode?: boolean;
  /** Stop Djinni pagination when any item on a page was published before this timestamp (ms). */
  stopBeforeMs?: number;
  /** If provided, details are only fetched for drafts where this returns true. */
  detailFilter?: (id: string, url: string) => boolean;
}

function parseCli(argv = process.argv.slice(2)): Options {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      out: { type: 'string', default: 'vacancies.json' },
      'max-pages': { type: 'string', default: '5' },
      delay: { type: 'string', default: '1500' },
      limit: { type: 'string', default: '0' },
      only: { type: 'string', default: '' },
      'skip-details': { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      'cache-dir': { type: 'string', default: '.cache' },
      'cache-ttl-hours': { type: 'string', default: '24' },
    },
  });
  const num = (v: string | undefined, name: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} має бути числом ≥ 0, отримано: ${v}`);
    return n;
  };
  return {
    out: values.out ?? 'vacancies.json',
    maxPages: num(values['max-pages'], 'max-pages'),
    delayMs: num(values.delay, 'delay'),
    limit: num(values.limit, 'limit'),
    only: (values.only ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    skipDetails: values['skip-details'] ?? false,
    fresh: values.fresh ?? false,
    cacheDir: values['cache-dir'] ?? '.cache',
    cacheTtlHours: num(values['cache-ttl-hours'], 'cache-ttl-hours'),
  };
}

// ─── Контекст і логування ──────────────────────────────────────────────────

export interface QueryStat {
  id: string;
  source: Source;
  track: Track;
  url: string;
  found: number;
  error?: string;
}

export interface Ctx {
  opts: Options;
  http: Http;
  store: Store;
  warnings: string[];
  queryStats: QueryStat[];
  checks: Checks;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface Checks {
  /** чи повні тексти вакансій у списку Djinni (перевіряється на кількох сторінках вакансій) */
  djinniListingText: 'full' | 'truncated' | 'unknown' | 'not-checked';
}

export function makeCtx(opts: Options, store = new Store(), quiet = false): Ctx {
  const warnings: string[] = [];
  const log = (msg: string) => {
    if (!quiet) console.error(msg);
  };
  const warn = (msg: string) => {
    warnings.push(msg);
    if (!quiet) console.error(`⚠ ${msg}`);
  };
  const ctx: Ctx = {
    opts,
    store,
    warnings,
    queryStats: [],
    checks: { djinniListingText: 'not-checked' },
    log,
    warn,
    http: undefined as unknown as Http,
  };
  ctx.http = new Http(opts, warn);
  return ctx;
}

// ─── HTTP: пауза, ретраї, кеш, детекція челенджів ──────────────────────────

export interface HttpResponse {
  url: string;
  status: number;
  body: string;
  setCookie: string[];
  fromCache: boolean;
  /** True when server returned 304 Not Modified; body is from cache. */
  notModified?: boolean;
}

interface RequestInit2 {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
}

export class ChallengeError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

function defaultHeaders(url: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent':
      process.env.SCRAPER_UA ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
  };
  if (url.includes('djinni.co') && process.env.DJINNI_COOKIE) h.Cookie = process.env.DJINNI_COOKIE;
  return h;
}

function looksLikeChallenge(status: number, body: string): boolean {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return /cf-chl|challenge-platform|Just a moment|Attention Required|cf-turnstile|captcha/i.test(body);
}

/** Cached file format (persisted to disk). */
interface CacheEntry extends HttpResponse {
  fetchedAt: number;
  etag?: string;
  lastModified?: string;
}

export class Http {
  /** Per-host last-request timestamp (ms) for per-host jitter. */
  private lastAtByHost = new Map<string, number>();
  readonly blockedHosts = new Set<string>();

  constructor(
    private opts: Options,
    private warn: (m: string) => void,
  ) {}

  async request(url: string, init: RequestInit2 = {}): Promise<HttpResponse> {
    const method = init.method ?? 'GET';
    const host = new URL(url).host;
    if (this.blockedHosts.has(host)) throw new ChallengeError(`${host} заблокований челенджем, пропускаю`);

    const file = path.join(this.opts.cacheDir, `${sha1(`${method} ${url} ${init.body ?? ''}`)}.json`);

    // Read existing cache entry (used for both TTL check and conditional headers)
    let cached: CacheEntry | null = null;
    if (existsSync(file)) {
      try { cached = JSON.parse(await readFile(file, 'utf8')) as CacheEntry; } catch { /* ignore */ }
    }

    // Serve from cache if fresh enough and bypass is not requested
    const bypass = this.opts.bypassCache?.(url, method) ?? false;
    if (!this.opts.fresh && !bypass && cached) {
      if (Date.now() - cached.fetchedAt < this.opts.cacheTtlHours * 3_600_000) {
        return { ...cached, fromCache: true };
      }
    }

    // Build conditional request headers when we have cached validators and are bypassing cache
    const conditionalHeaders: Record<string, string> = {};
    if (bypass && cached) {
      if (cached.etag)         conditionalHeaders['If-None-Match']     = cached.etag;
      if (cached.lastModified) conditionalHeaders['If-Modified-Since'] = cached.lastModified;
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.pause(host);
      try {
        const res = await fetch(url, {
          method,
          body: init.body,
          headers: { ...defaultHeaders(url), ...init.headers, ...conditionalHeaders },
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
        });

        // 304 Not Modified: return cached body with notModified flag
        if (res.status === 304 && cached) {
          return { ...cached, fromCache: true, notModified: true };
        }

        const body = await res.text();
        if (looksLikeChallenge(res.status, body)) {
          this.blockedHosts.add(host);
          throw new ChallengeError(
            `${host} показав челендж/капчу (HTTP ${res.status}). Спробуй пізніше або з більшим --delay.`,
          );
        }
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * 2 ** attempt;
          if (attempt < maxAttempts) {
            this.warn(`HTTP ${res.status} на ${url}, повтор через ${Math.round(wait / 1000)} с`);
            await sleep(wait);
            continue;
          }
          // Exhausted all retries on 429/503 → mark host blocked (same as challenge)
          this.blockedHosts.add(host);
          throw new Error(`HTTP ${res.status} після ${maxAttempts} спроб — ${host} у backoff`);
        }
        const out: HttpResponse = {
          url: res.url || url,
          status: res.status,
          body,
          setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
          fromCache: false,
        };
        if (res.ok) {
          const entry: CacheEntry = {
            ...out,
            fetchedAt:    Date.now(),
            etag:         res.headers.get('etag')          ?? cached?.etag,
            lastModified: res.headers.get('last-modified') ?? cached?.lastModified,
          };
          await writeFile(file, JSON.stringify(entry));
        }
        return out;
      } catch (err) {
        if (err instanceof ChallengeError || attempt === maxAttempts) throw err;
        this.warn(`мережева помилка на ${url} (${errMsg(err)}), спроба ${attempt + 1}/${maxAttempts}`);
        await sleep(3000 * 2 ** attempt);
      } finally {
        this.lastAtByHost.set(host, Date.now());
      }
    }
    throw new Error(`не вдалося отримати ${url}`);
  }

  /** Per-host jitter pause: waits until delayMs has elapsed since the last request to this host. */
  private async pause(host: string): Promise<void> {
    const lastAt = this.lastAtByHost.get(host) ?? 0;
    const jitter = Math.random() * this.opts.delayMs * 0.5;
    const wait = lastAt + this.opts.delayMs + jitter - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── Сховище чернеток з пріоритетами полів ─────────────────────────────────

type FieldName =
  | 'title'
  | 'company'
  | 'location'
  | 'salary'
  | 'publishedAt'
  | 'experienceYears'
  | 'englishLevel'
  | 'remote'
  | 'countries'
  | 'views'
  | 'applications';

// Вище число = надійніше джерело; значення з нижчим пріоритетом не перезаписує вищий.
const PRIORITY = { jsonld: 4, html: 3, rss: 3, listing: 2, guess: 1 } as const;
export type FieldOrigin = keyof typeof PRIORITY;

export interface Draft {
  id: string;
  source: Source;
  url: string;
  fields: Partial<Record<FieldName, { value: string | number | boolean; prio: number }>>;
  foundBy: Set<string>;
  queryTracks: Set<Track>;
  descs: { origin: DescOrigin; text: string }[];
  gone: boolean;
}

const isGoodDesc = (t: string) => t.length >= 300 && !/(\.\.\.|…)\s*$/.test(t);

export class Store {
  readonly drafts = new Map<string, Draft>();

  touch(source: Source, rawId: string, url: string, q?: Query): Draft {
    const id = `${source}:${rawId}`;
    let d = this.drafts.get(id);
    if (!d) {
      d = { id, source, url, fields: {}, foundBy: new Set(), queryTracks: new Set(), descs: [], gone: false };
      this.drafts.set(id, d);
    }
    if (q) {
      d.foundBy.add(q.id);
      d.queryTracks.add(q.track);
    }
    return d;
  }

  set(d: Draft, field: FieldName, value: string | number | boolean | null | undefined, origin: FieldOrigin): void {
    if (value === null || value === undefined || value === '') return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    const prio = PRIORITY[origin];
    const cur = d.fields[field];
    if (!cur || prio > cur.prio) d.fields[field] = { value, prio };
  }

  addDesc(d: Draft, origin: DescOrigin, text: string | null | undefined): void {
    const t = (text ?? '').trim();
    if (t.length < 40) return;
    if (d.descs.some((x) => x.origin === origin && x.text === t)) return;
    d.descs.push({ origin, text: t });
  }

  hasGoodDesc(d: Draft, origins: DescOrigin[]): boolean {
    return d.descs.some((x) => origins.includes(x.origin) && isGoodDesc(x.text));
  }

  finalize(): Vacancy[] {
    const out: Vacancy[] = [];
    const firstByFingerprint = new Map<string, string>();
    // DOU першим: дублікати з Djinni посилатимуться на DOU-версію
    const drafts = [...this.drafts.values()].sort((a, b) =>
      a.source === b.source ? a.id.localeCompare(b.id) : a.source === 'dou' ? -1 : 1,
    );
    for (const d of drafts) {
      const f = <T>(k: FieldName) => (d.fields[k]?.value ?? null) as T | null;
      const best = pickDescription(d.descs);
      const title = f<string>('title') ?? '';
      const text = best?.text ?? '';
      const signals = detectSignals(title, text);

      let experienceYears = f<number>('experienceYears');
      let experienceFrom: Vacancy['experienceFrom'] = experienceYears !== null ? 'meta' : null;
      if (experienceYears === null) {
        experienceYears = experienceFromText(text);
        if (experienceYears !== null) experienceFrom = 'text';
      }

      const fp = text.length >= 200 ? fingerprint(text) : null;
      let duplicateOf: string | null = null;
      if (fp) {
        const first = firstByFingerprint.get(fp);
        if (first) duplicateOf = first;
        else firstByFingerprint.set(fp, d.id);
      }

      const location = f<string>('location');
      out.push({
        id: d.id,
        source: d.source,
        url: d.url,
        title,
        company: f<string>('company'),
        location,
        salary: f<string>('salary'),
        publishedAt: f<string>('publishedAt'),
        experienceYears,
        experienceFrom,
        englishLevel: f<string>('englishLevel') ?? englishFromText(text),
        remote: f<boolean>('remote') ?? (isRemoteText(`${title} ${location ?? ''}`) ? true : null),
        countries: f<string>('countries'),
        views: f<number>('views'),
        applications: f<number>('applications'),
        foundBy: [...d.foundBy].sort(),
        queryTracks: [...d.queryTracks].sort(),
        tracks: classify(title, signals),
        signals,
        description: text,
        descriptionSource: best?.origin ?? 'none',
        fingerprint: fp,
        duplicateOf,
        gone: d.gone,
      });
    }
    return out;
  }
}

function pickDescription(descs: Draft['descs']): Draft['descs'][number] | null {
  const good = descs.filter((x) => x.origin !== 'fallback');
  const pool = good.length ? good : descs;
  let best: Draft['descs'][number] | null = null;
  for (const x of pool) if (!best || x.text.length > best.text.length) best = x;
  return best;
}

const fingerprint = (text: string) =>
  sha1(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .slice(0, 400),
  ).slice(0, 12);

// ─── Текстові утиліти ──────────────────────────────────────────────────────

export const clean = (s: string | null | undefined): string =>
  (s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function normalizeText(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '-' && l !== '##')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML → текст зі збереженням структури списків і заголовків */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const $ = cheerio.load(`<section id="__root__">${html}</section>`);
  const root = $('#__root__');
  root.find('script, style, noscript, iframe, img, svg, button, form').remove();
  root.find('a[href*="reply-btn"]').remove(); // «Відгукнутись на вакансію» в RSS DOU
  root.find('br').replaceWith('\n');
  root.find('li').each((_, el) => {
    $(el).prepend('\n- ').append('\n');
  });
  root.find('h1, h2, h3, h4, h5, h6').each((_, el) => {
    $(el).prepend('\n\n## ').append('\n');
  });
  root.find('p, div, ul, ol, blockquote, tr, section, article, header, footer, table').each((_, el) => {
    $(el).append('\n');
  });
  return normalizeText(root.text());
}

/** HTML, заекранований один раз (&lt;p&gt;), розекрановуємо перед розбором */
function maybeUnescape(s: string): string {
  if (/&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z][^>]*>/i.test(s)) return cheerio.load(s).text();
  return s;
}

const decodeEntities = (s: string) => (/&[#a-z0-9]+;/i.test(s) ? cheerio.load(s).text() : s);

export function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const UK_MONTHS = [
  'січня',
  'лютого',
  'березня',
  'квітня',
  'травня',
  'червня',
  'липня',
  'серпня',
  'вересня',
  'жовтня',
  'листопада',
  'грудня',
];

/** «7 вересня 2026» → ISO; без року бере поточний (або минулий, якщо дата в майбутньому) */
export function parseUkDate(s: string | null | undefined): string | null {
  const m = clean(s)
    .toLowerCase()
    .match(/(\d{1,2})\s+([а-яіїєґʼ']+)\s*(\d{4})?/u);
  if (!m) return null;
  const month = UK_MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  const now = new Date();
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  let d = new Date(Date.UTC(year, month, Number(m[1])));
  if (!m[3] && d.getTime() > now.getTime() + 86_400_000) d = new Date(Date.UTC(--year, month, Number(m[1])));
  return d.toISOString();
}

// ─── Евристики: досвід, англійська, сигнали, треки ─────────────────────────

const REMOTE_RE = /\bfull remote\b|\bremote\b|віддалено/i;
const HYBRID_RE = /\bhybrid\b|гібрид/i;

/** «Hybrid Remote» містить слово Remote, але це не повністю віддалена робота */
export function isRemoteText(text: string): boolean {
  return !HYBRID_RE.test(text) && REMOTE_RE.test(text);
}

export function experienceFromText(text: string): number | null {
  const patterns = [
    /(\d{1,2})\s*\+?\s*(?:years?|yrs)\b[^.\n]{0,60}?\bexperience/i,
    /\bexperience\b[^.\n]{0,40}?\b(\d{1,2})\s*\+?\s*(?:years?|yrs)\b/i,
    /(\d{1,2})\s*\+?\s*(?:років|роки|рік)[^.\n]{0,40}?досвід/i,
    /досвід[^.\n]{0,40}?(\d{1,2})\s*\+?\s*(?:років|роки|рік)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 25) return n;
    }
  }
  return null;
}

const ENGLISH_LEVELS =
  'A1|A2|B1|B2|C1|C2|upper[\\s-]?intermediate|pre[\\s-]?intermediate|intermediate|advanced|fluent|proficient|native|none|no english';
const ENGLISH_META_RE = new RegExp(`\\bEnglish\\s*[-–:]\\s*(${ENGLISH_LEVELS})\\b`, 'i');
const ENGLISH_TEXT_RES = [
  // «English: B2», «англійська на рівні B2»
  new RegExp(`(?:english|англійськ[а-яії]*)[^.\\n]{0,40}?\\b(${ENGLISH_LEVELS})\\b`, 'i'),
  // «Upper-Intermediate or higher English», «B2+ English»
  new RegExp(`\\b(${ENGLISH_LEVELS})\\b[^.\\n]{0,25}?(?:\\benglish|англійськ)`, 'i'),
];

export function englishFromText(text: string): string | null {
  for (const re of ENGLISH_TEXT_RES) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** мета-рядок картки Djinni: «Full Remote · … · 5 years of experience · English - B2 · …» */
export function extractMeta(text: string) {
  const exp =
    text.match(/(\d{1,2})\s+years?\s+of\s+experience/i) ?? text.match(/(\d{1,2})\s+(?:рік|роки|років)\s+досвіду/i);
  const int = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1].replace(/\s/g, '')) : null;
  };
  return {
    experienceYears: exp ? Number(exp[1]) : null,
    englishLevel: text.match(ENGLISH_META_RE)?.[1] ?? null,
    views: int(/(\d[\d ]{0,6})\s+(?:views?|переглядів|перегляди|перегляд)\b/i),
    applications: int(/(\d[\d ]{0,6})\s+(?:applications?|відгуків|відгуки|відгук)\b/i),
    remote: isRemoteText(text) ? true : null,
  };
}

type Term = [name: string, re: RegExp];

const LLM_TERMS: Term[] = [
  ['LLM', /\bLLMs?\b|large language models?/i],
  ['RAG', /\bRAG\b|retrieval[- ]augmented/i],
  ['embeddings', /\bembeddings?\b/i],
  ['vector DB', /vector\s*(?:db|database|store|search)|pgvector|pinecone|weaviate|qdrant|milvus|chromadb/i],
  ['LangChain', /langchain/i],
  ['LangGraph', /langgraph/i],
  ['LlamaIndex', /llama[\s-]?index/i],
  ['OpenAI API', /\bopenai\b/i],
  ['Anthropic API', /\banthropic\b/i],
  ['Gemini', /\bgemini\b/i],
  ['Bedrock', /\bbedrock\b/i],
  ['MCP', /\bMCP\b|model context protocol/i],
  [
    'AI agents',
    /\bai[\s-]agents?\b|\bagentic\b|multi[- ]agent|\bagents?\s+(?:framework|orchestration|workflows?|development)/i,
  ],
  ['prompt engineering', /prompt\s*engineering|\bprompting\b/i],
  ['evals', /\bevals?\b|llm[- ]evaluation|evaluation\s+(?:harness|framework|pipeline)|llm[- ]as[- ]a?[- ]?judge/i],
  ['fine-tuning', /fine[- ]?tun/i],
  ['tool calling', /\btool[- ](?:use|calling)\b|function calling/i],
  ['guardrails', /guardrails?/i],
  ['Vercel AI SDK', /vercel ai sdk|\bai sdk\b/i],
  ['Mastra', /\bmastra\b/i],
];

const AI_TOOLING: Term[] = [
  ['Claude Code', /claude\s*code/i],
  ['Cursor', /\bCursor\b(?![- ]based)/],
  ['Copilot', /copilot/i],
  ['Codex', /\bcodex\b/i],
  [
    'AI-assisted development',
    /ai[- ](?:assisted|first|powered)\s+(?:development|engineering|coding|workflows?)|ai coding (?:assistants?|tools?)|ai[- ]інструмент/i,
  ],
];

const NODE_STRICT = /\bnode\s*\.?\s*js\b|\bnest\s*\.?\s*js\b/i;
// «Node» без .js зараховуємо лише в назві вакансії: в описі це часто вузол Kubernetes
const NODE_TITLE = /\bnode\b|\bnest\b/i;

const LANGS: Term[] = [
  ['TypeScript', /\btypescript\b/i],
  ['Python', /\bpython\b|\bfastapi\b|\bdjango\b/i],
  ['Go', /\bgolang\b|\bGo\s*\/|\/\s*Go\b|\(Go\b/],
  ['Java', /\bjava\b(?!\s*script)/i],
  ['.NET', /\.net\b|\bc#/i],
  ['PHP', /\bphp\b/i],
  ['Ruby', /\bruby\b|\brails\b/i],
];

const FRONTEND: Term[] = [
  ['React', /\breact(?:\.?js)?\b(?!\s*native)/i],
  ['React Native', /\breact\s*native\b/i],
  ['Next.js', /\bnext\s*\.?\s*js\b/i],
  ['Vue', /\bvue(?:\.?js)?\b/i],
  ['Angular', /\bangular\b/i],
];

export function detectSignals(title: string, text: string): Signals {
  const all = `${title}\n${text}`;
  const pick = (terms: Term[]) => terms.filter(([, re]) => re.test(all)).map(([name]) => name);
  const languages = pick(LANGS);
  if (NODE_STRICT.test(all) || NODE_TITLE.test(title)) languages.unshift('Node.js');
  return { llm: pick(LLM_TERMS), aiTooling: pick(AI_TOOLING), languages, frontend: pick(FRONTEND) };
}

const AI_TITLE_RE = /\b(?:AI|ML|LLM|GenAI|Gen\s?AI|NLP)\b|machine learning|штучн[а-яії]* інтелект/i;

export function classify(title: string, s: Signals): Track[] {
  const tracks = new Set<Track>();
  if (s.languages.includes('Node.js')) tracks.add('node');
  if (/full[\s-]?stack/i.test(title)) tracks.add('fullstack');
  if (AI_TITLE_RE.test(title) || s.llm.length > 0) tracks.add('ai');
  return [...tracks];
}

// ─── JSON-LD (schema.org JobPosting) ───────────────────────────────────────

type Json = Record<string, any>;

export function jsonLdJobPostings($: cheerio.CheerioAPI): Json[] {
  const found: Json[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Json;
    const type = o['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) found.push(o);
    if (o['@graph']) visit(o['@graph']);
    if (o.itemListElement) visit(o.itemListElement);
    if (o.item) visit(o.item);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    // деякі сайти лишають сирі переноси рядків у JSON-рядках, тож є санітизований варіант
    for (const candidate of [raw, raw.replace(/[\u0000-\u001f]+/g, ' ')]) {
      try {
        visit(JSON.parse(candidate));
        break;
      } catch {
        /* пробуємо наступний варіант */
      }
    }
  });
  return found;
}

export function fromJsonLd(jp: Json) {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? clean(decodeEntities(v)) : null);
  const salary = (() => {
    const b = jp.baseSalary;
    if (!b || typeof b !== 'object') return null;
    const v = b.value ?? {};
    const min = v.minValue ?? v.value;
    const max = v.maxValue;
    if (min === undefined && max === undefined) return null;
    const range = max !== undefined && max !== min ? `${min ?? ''}–${max}` : `${min}`;
    return [b.currency, range, v.unitText ? `/ ${v.unitText}` : ''].filter(Boolean).join(' ');
  })();
  const location = (() => {
    const names: string[] = [];
    const req = jp.applicantLocationRequirements;
    for (const r of Array.isArray(req) ? req : req ? [req] : []) if (r?.name) names.push(String(r.name));
    const loc = jp.jobLocation;
    for (const l of Array.isArray(loc) ? loc : loc ? [loc] : []) {
      const a = l?.address;
      const part = [
        a?.addressLocality,
        typeof a?.addressCountry === 'string' ? a.addressCountry : a?.addressCountry?.name,
      ]
        .filter(Boolean)
        .join(', ');
      if (part) names.push(part);
    }
    return names.length ? [...new Set(names)].join('; ') : null;
  })();
  const experienceYears = (() => {
    const e = jp.experienceRequirements;
    if (e && typeof e === 'object' && Number.isFinite(Number(e.monthsOfExperience))) {
      return Math.round(Number(e.monthsOfExperience) / 12);
    }
    return typeof e === 'string' ? experienceFromText(e) : null;
  })();
  return {
    title: str(jp.title),
    company: str(jp.hiringOrganization?.name),
    publishedAt: toIso(jp.datePosted),
    description: typeof jp.description === 'string' ? htmlToText(maybeUnescape(jp.description)) : null,
    salary,
    location,
    remote: jp.jobLocationType === 'TELECOMMUTE' ? true : null,
    experienceYears,
  };
}

function applyJsonLd(store: Store, d: Draft, jp: Json, descOrigin: DescOrigin, fieldOrigin: FieldOrigin): void {
  const ld = fromJsonLd(jp);
  store.set(d, 'title', ld.title, fieldOrigin);
  store.set(d, 'company', ld.company, fieldOrigin);
  store.set(d, 'publishedAt', ld.publishedAt, fieldOrigin);
  store.set(d, 'salary', ld.salary, fieldOrigin);
  store.set(d, 'location', ld.location, fieldOrigin);
  store.set(d, 'remote', ld.remote, fieldOrigin);
  store.set(d, 'experienceYears', ld.experienceYears, fieldOrigin);
  store.addDesc(d, descOrigin, ld.description);
}

// ─── DOU ───────────────────────────────────────────────────────────────────

const DOU_VAC_RE = /^(?:https?:\/\/jobs\.dou\.ua)?\/companies\/([^/?#]+)\/vacancies\/(\d+)\/?/;
const douUrl = (company: string, id: string) => `https://jobs.dou.ua/companies/${company}/vacancies/${id}/`;
const SALARY_RE = /\$|€|₴|грн|\busd\b|\beur\b/i;

export interface DouListItem {
  id: string;
  url: string;
  title: string | null;
  company: string | null;
  location: string | null;
  salary: string | null;
  short: string | null;
}

export function parseDouListing(html: string) {
  const $ = cheerio.load(html);
  const items = new Map<string, DouListItem>();
  const cards = $('li.l-vacancy');
  const anchors = cards.length ? cards.find('a[href]') : $('a[href]');
  anchors.each((_, a) => {
    const m = ($(a).attr('href') ?? '').match(DOU_VAC_RE);
    if (!m || items.has(m[2])) return;
    const li = $(a).closest('li.l-vacancy');
    items.set(m[2], {
      id: m[2],
      url: douUrl(m[1], m[2]),
      title: clean(li.find('a.vt').first().text()) || clean($(a).text()) || null,
      company: clean(li.find('a.company').first().text()) || null,
      location: clean(li.find('.cities').first().text()) || null,
      salary: clean(li.find('.salary').first().text()) || null,
      short: clean(li.find('.sh-info').first().text()) || null,
    });
  });
  const total = clean($('h1').first().text()).match(/(\d+)\s+ваканс/i);
  return {
    items: [...items.values()],
    total: total ? Number(total[1]) : null,
    hasMore: /Більше вакансій|More jobs/i.test(html),
    usedFallback: cards.length === 0,
  };
}

/** «Senior Dev в Company, до $7000, Київ, віддалено» → частини */
export function parseDouRssTitle(s: string) {
  const m = s.match(/^(.*)\s+в\s+(.+)$/s); // жадібний (.*) бере останнє « в »
  if (!m) return { title: s, company: null, location: null, salary: null };
  const [company, ...rest] = m[2].split(/,\s+/);
  let salary: string | null = null;
  const loc: string[] = [];
  for (const part of rest) {
    if (!salary && SALARY_RE.test(part)) salary = part;
    else loc.push(part);
  }
  return { title: m[1].trim(), company: company.trim() || null, location: loc.join(', ') || null, salary };
}

export function parseDouRss(xml: string) {
  const $ = cheerio.load(xml, { xml: true });
  const out: (ReturnType<typeof parseDouRssTitle> & {
    id: string;
    url: string;
    publishedAt: string | null;
    text: string;
  })[] = [];
  $('item').each((_, it) => {
    const $it = $(it);
    const m = clean($it.children('link').text()).match(DOU_VAC_RE);
    if (!m) return;
    out.push({
      id: m[2],
      url: douUrl(m[1], m[2]),
      // назва в RSS DOU заекранована двічі (до&amp;nbsp;$7000), тому ще один decode
      ...parseDouRssTitle(clean(decodeEntities($it.children('title').text()))),
      publishedAt: toIso(clean($it.children('pubDate').text())),
      text: htmlToText($it.children('description').text()),
    });
  });
  return out;
}

export function parseDouVacancy(html: string) {
  const $ = cheerio.load(html);
  const sections = $('.vacancy-section');
  let htmlDesc: string | null = null;
  if (sections.length) {
    htmlDesc = sections
      .toArray()
      .map((s) => htmlToText($(s).html()))
      .filter(Boolean)
      .join('\n\n');
  } else {
    const typo = $('.b-vacancy .b-typo, .b-typo').first();
    if (typo.length) htmlDesc = htmlToText(typo.html());
  }
  const jp = jsonLdJobPostings($)[0] ?? null;
  return {
    jp,
    htmlDesc,
    fallback: htmlDesc || jp ? null : htmlToText($('.b-vacancy').html() ?? $('main').html() ?? ''),
    title: clean($('h1.g-h2').first().text()) || clean($('h1').first().text()) || null,
    company: clean($('.b-compinfo .l-n a').first().text()) || clean($('.l-n a').first().text()) || null,
    location: clean($('.place').first().text()) || null,
    salary: clean($('.salary').first().text()) || null,
    publishedAt: parseUkDate($('.date').first().text()),
  };
}

function douCsrf(res: HttpResponse): string | null {
  for (const c of res.setCookie) {
    const m = c.match(/csrftoken=([^;]+)/);
    if (m) return m[1];
  }
  return (
    res.body.match(/CSRF_TOKEN\s*=\s*["']([^"']+)["']/)?.[1] ??
    res.body.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/)?.[1] ??
    null
  );
}

function upsertDouListItem(ctx: Ctx, q: Query, it: DouListItem): void {
  const d = ctx.store.touch('dou', it.id, it.url, q);
  ctx.store.set(d, 'title', it.title, 'listing');
  ctx.store.set(d, 'company', it.company, 'listing');
  ctx.store.set(d, 'location', it.location, 'listing');
  ctx.store.set(d, 'salary', it.salary, 'listing');
  ctx.store.addDesc(d, 'listing', it.short);
}

async function collectDouQuery(ctx: Ctx, q: Query): Promise<number> {
  const { http, store, log, warn } = ctx;
  const listUrl = new URL(q.url);
  const ids = new Set<string>();

  // 1) RSS дає повні тексти одним запитом. Беремо лише для запитів із категорією:
  //    для пошукових запитів фільтрацію RSS не перевіряли.
  if (listUrl.searchParams.has('category')) {
    const rssUrl = new URL(listUrl);
    rssUrl.pathname = '/vacancies/feeds/';
    try {
      const r = await http.request(rssUrl.href, {
        headers: { Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      if (r.status === 200) {
        const items = parseDouRss(r.body);
        for (const it of items) {
          ids.add(it.id);
          const d = store.touch('dou', it.id, it.url, q);
          store.set(d, 'title', it.title, 'rss');
          store.set(d, 'company', it.company, 'rss');
          store.set(d, 'location', it.location, 'rss');
          store.set(d, 'salary', it.salary, 'rss');
          store.set(d, 'publishedAt', it.publishedAt, 'rss');
          store.addDesc(d, 'rss', it.text);
        }
        log(`[${q.id}] RSS: ${items.length} вакансій з повними текстами`);
      } else {
        warn(`[${q.id}] RSS повернув HTTP ${r.status}`);
      }
    } catch (err) {
      if (err instanceof ChallengeError) throw err;
      warn(`[${q.id}] RSS не вдалося прочитати: ${errMsg(err)}`);
    }
    // watchMode: RSS gives the freshest items with full text — skip listing page + xhr-load.
    if (ctx.opts.watchMode && ids.size > 0) {
      // DOU RSS ignores the `remote` query param: filter non-remote results ourselves.
      if (listUrl.searchParams.has('remote')) {
        for (const id of [...ids]) {
          const d = store.drafts.get(`dou:${id}`);
          if (!d) continue;
          const loc  = String(d.fields.location?.value ?? '');
          const text = d.descs[0]?.text ?? '';
          if (!REMOTE_RE.test(`${loc} ${text}`)) {
            store.drafts.delete(`dou:${id}`);
            ids.delete(id);
          }
        }
      }
      return ids.size;
    }
  }

  // 2) Перша сторінка списку
  const res = await http.request(listUrl.href);
  // 304 → nothing changed since last cycle; skip this query
  if (res.notModified) { log(`[${q.id}] 304 Not Modified, пропускаю`); return ids.size; }
  if (res.status !== 200) throw new Error(`список повернув HTTP ${res.status}`);
  const first = parseDouListing(res.body);
  if (first.usedFallback && first.items.length)
    warn(`[${q.id}] не знайшов li.l-vacancy, посилання зібрано загальним пошуком (перевір розмітку DOU)`);
  for (const it of first.items) {
    ids.add(it.id);
    upsertDouListItem(ctx, q, it);
  }
  log(`[${q.id}] список: ${first.items.length}${first.total !== null ? ` з ${first.total}` : ''}`);

  // 3) «Більше вакансій»: POST на xhr-load з CSRF-токеном (skipped in watchMode)
  const maxPages = ctx.opts.watchMode ? 0 : (q.maxPages ?? ctx.opts.maxPages);
  const listed = new Set(first.items.map((i) => i.id));
  let stop: 'done' | 'cap' | 'error' = 'done';
  if (first.hasMore && maxPages > 0 && (first.total === null || listed.size < first.total)) {
    const csrf = douCsrf(res);
    if (!csrf) {
      warn(`[${q.id}] не знайшов CSRF-токен, догрузка пропущена (є лише перша сторінка + RSS)`);
    } else {
      let offset = first.items.length;
      stop = 'cap';
      for (let page = 1; page <= maxPages; page++) {
        try {
          const xhr = new URL('https://jobs.dou.ua/vacancies/xhr-load/');
          listUrl.searchParams.forEach((v, k) => xhr.searchParams.set(k, v));
          const r = await http.request(xhr.href, {
            method: 'POST',
            body: new URLSearchParams({ csrfmiddlewaretoken: csrf, count: String(offset) }).toString(),
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
              Accept: 'application/json, text/javascript, */*; q=0.01',
              Referer: listUrl.href,
              Cookie: `csrftoken=${csrf}`,
            },
          });
          if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
          const data = JSON.parse(r.body) as { html?: string; last?: boolean };
          const parsed = parseDouListing(String(data.html ?? ''));
          const fresh = parsed.items.filter((i) => !listed.has(i.id));
          for (const it of parsed.items) {
            listed.add(it.id);
            ids.add(it.id);
            upsertDouListItem(ctx, q, it);
          }
          offset += parsed.items.length;
          log(`[${q.id}] догрузка ${page}: +${fresh.length} (разом у списку ${listed.size})`);
          if (data.last || parsed.items.length === 0 || fresh.length === 0) {
            stop = 'done';
            break;
          }
          if (first.total !== null && listed.size >= first.total) {
            stop = 'done';
            break;
          }
        } catch (err) {
          if (err instanceof ChallengeError) throw err;
          warn(`[${q.id}] догрузка ${page} не вдалася: ${errMsg(err)}. Лишаю те, що є.`);
          stop = 'error';
          break;
        }
      }
    }
  }
  if (first.total !== null && listed.size < first.total && stop !== 'error') {
    warn(
      stop === 'cap'
        ? `[${q.id}] зібрано ${listed.size} з ${first.total}: спрацював ліміт догрузок (${maxPages}), збільш maxPages у QUERIES або --max-pages`
        : `[${q.id}] зібрано ${listed.size} з ${first.total}: сайт віддав менше, ніж показує лічильник`,
    );
  }
  return ids.size;
}

// ─── Djinni ────────────────────────────────────────────────────────────────

const DJINNI_JOB_RE = /^(?:https?:\/\/djinni\.co)?\/jobs\/(\d+)-([^/?#]+)\/?(?:[?#].*)?$/;

export interface DjinniListItem {
  id: string;
  url: string;
  title: string | null;
  titleFromAnchor: string | null;
  cardText: string;
  text: string | null;
  jp: Json | null;
}

export function parseDjinniListing(html: string) {
  const $ = cheerio.load(html);
  const ldById = new Map<string, Json>();
  for (const jp of jsonLdJobPostings($)) {
    const m = String(jp.url ?? jp['@id'] ?? '').match(DJINNI_JOB_RE);
    if (m) ldById.set(m[1], jp);
  }
  const items = new Map<string, DjinniListItem>();
  $('a[href]').each((_, a) => {
    const m = ($(a).attr('href') ?? '').match(DJINNI_JOB_RE);
    if (!m) return;
    const existing = items.get(m[1]);
    const anchorText = clean($(a).text()) || null;
    if (existing) {
      existing.titleFromAnchor ??= anchorText;
      return;
    }
    const card = $(a).closest('[id^="job-item-"]');
    const original = card.find('.js-original-text').first();
    items.set(m[1], {
      id: m[1],
      url: `https://djinni.co/jobs/${m[1]}-${m[2]}/`,
      title: card.length ? clean(card.find('h2, h3, [class*="title"]').first().text()) || null : null,
      titleFromAnchor: anchorText,
      cardText: card.length ? htmlToText(card.html()) : '',
      text: original.length ? htmlToText(original.html()) : null,
      jp: ldById.get(m[1]) ?? null,
    });
  });
  // JSON-LD без відповідного посилання в DOM теж беремо
  for (const [id, jp] of ldById) {
    if (items.has(id)) continue;
    const m = String(jp.url ?? jp['@id']).match(DJINNI_JOB_RE)!;
    items.set(id, {
      id,
      url: `https://djinni.co/jobs/${id}-${m[2]}/`,
      title: null,
      titleFromAnchor: null,
      cardText: '',
      text: null,
      jp,
    });
  }
  let lastPage: number | null = null;
  $('a[href*="page="]').each((_, a) => {
    try {
      const n = Number(new URL($(a).attr('href') ?? '', 'https://djinni.co').searchParams.get('page'));
      if (Number.isFinite(n) && n > (lastPage ?? 0)) lastPage = n;
    } catch {
      /* ігноруємо биті посилання */
    }
  });
  return {
    items: [...items.values()],
    lastPage,
    loginWall: /to see all posted jobs|щоб побачити всі вакансії/i.test($('body').text()),
  };
}

/**
 * Бічна панель вакансії Djinni: формат роботи («Full Remote», «Hybrid Remote», «Office») і
 * країни кандидатів (`.location-text`). remote тут false для гібриду й офісу, щоб значення
 * перекрило `true` з картки в списку.
 */
export function parseDjinniSidebar($: cheerio.CheerioAPI): { remote: boolean | null; countries: string | null } {
  const aside = $('aside').first();
  const countries = clean(aside.find('.location-text').first().text()) || null;
  const format = clean(
    aside
      .find('strong.d-block')
      .filter((_, el) => $(el).find('.location-text').length === 0)
      .first()
      .text(),
  );
  const remote = format ? isRemoteText(format) : null;
  return { remote: format ? remote : null, countries };
}

export function parseDjinniJob(html: string) {
  const $ = cheerio.load(html);
  const jp = jsonLdJobPostings($)[0] ?? null;
  const selectors = [
    '.job-post__description',
    '.job-post-description',
    '[class*="job-post"][class*="description"]',
    '.profile-page-section',
  ];
  let htmlDesc: string | null = null;
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length && clean(el.text()).length > 200) {
      htmlDesc = htmlToText(el.html());
      break;
    }
  }
  const main = $('main').length ? $('main') : $('body');
  const side = parseDjinniSidebar($);
  const meta = extractMeta(clean(main.text()));
  if (side.remote !== null) meta.remote = side.remote as true | null;
  return {
    jp,
    htmlDesc,
    fallback: htmlDesc || jp ? null : htmlToText(main.html()),
    title: clean($('h1').first().text()) || null,
    meta,
    countries: side.countries,
  };
}

async function collectDjinniQuery(ctx: Ctx, q: Query): Promise<number> {
  const { http, store, log, warn } = ctx;
  const ids = new Set<string>();
  // In watch mode only the first page is needed (listings are newest-first).
  const maxPages = ctx.opts.watchMode ? 1 : Math.max(1, q.maxPages ?? ctx.opts.maxPages);
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(q.url);
    if (page > 1) url.searchParams.set('page', String(page));
    const r = await http.request(url.href);
    if (r.notModified) { log(`[${q.id}] 304 Not Modified, пропускаю`); break; }
    if (r.status === 404 && page > 1) break;
    if (r.status !== 200) throw new Error(`сторінка ${page} повернула HTTP ${r.status}`);
    const parsed = parseDjinniListing(r.body);
    const fresh = parsed.items.filter((i) => !ids.has(i.id));
    for (const it of fresh) {
      ids.add(it.id);
      const d = store.touch('djinni', it.id, it.url, q);
      if (it.jp) applyJsonLd(store, d, it.jp, 'listing', 'listing');
      store.set(d, 'title', it.title, 'listing');
      store.set(d, 'title', it.titleFromAnchor, 'guess'); // текст посилання може містити компанію та зарплату
      store.addDesc(d, 'listing', it.text);
      if (it.cardText) {
        const meta = extractMeta(it.cardText);
        store.set(d, 'experienceYears', meta.experienceYears, 'listing');
        store.set(d, 'englishLevel', meta.englishLevel, 'listing');
        store.set(d, 'views', meta.views, 'listing');
        store.set(d, 'applications', meta.applications, 'listing');
        store.set(d, 'remote', meta.remote, 'listing');
      }
    }
    log(`[${q.id}] сторінка ${page}: +${fresh.length} (разом ${ids.size})`);
    if (fresh.length === 0) break;
    // watchMode age-stop: Djinni lists newest-first; if any item on this page predates the
    // cutoff, all following pages will be older too.
    if (ctx.opts.stopBeforeMs) {
      const hasOld = parsed.items.some(it => {
        const pub = it.jp?.datePosted;
        if (!pub) return false;
        const t = new Date(String(pub)).getTime();
        return !isNaN(t) && t < ctx.opts.stopBeforeMs!;
      });
      if (hasOld) { log(`[${q.id}] age stop at page ${page}`); break; }
    }
    if (parsed.lastPage !== null && page >= parsed.lastPage) {
      if (parsed.loginWall && !process.env.DJINNI_COOKIE)
        warn(`[${q.id}] Djinni без логіну показав ${page} стор., решта за входом`);
      break;
    }
    // якщо пагінації не видно, пробуємо наступну сторінку: зупинка буде, коли нових вакансій не з'явиться
  }
  if (ids.size === 0) warn(`[${q.id}] 0 вакансій: перевір URL або розмітку Djinni`);
  return ids.size;
}

// ─── Деталі вакансій ───────────────────────────────────────────────────────

function needsDetails(store: Store, d: Draft): boolean {
  if (d.source === 'dou') return !store.hasGoodDesc(d, ['rss', 'html', 'jsonld']);
  return !store.hasGoodDesc(d, ['jsonld', 'html', 'listing']) || !d.fields.company;
}

/** Відкриває сторінку вакансії та додає з неї поля й опис */
async function fetchDetail(ctx: Ctx, d: Draft): Promise<void> {
  const { http, store, warn } = ctx;
  const r = await http.request(d.url);
  if (r.status === 404 || r.status === 410) {
    d.gone = true;
    return;
  }
  if (r.status !== 200) {
    warn(`${d.id}: HTTP ${r.status}`);
    return;
  }
  if (d.source === 'dou') {
    const p = parseDouVacancy(r.body);
    if (p.jp) applyJsonLd(store, d, p.jp, 'jsonld', 'jsonld');
    store.set(d, 'title', p.title, 'html');
    store.set(d, 'company', p.company, 'html');
    store.set(d, 'location', p.location, 'html');
    store.set(d, 'salary', p.salary, 'html');
    store.set(d, 'publishedAt', p.publishedAt, 'html');
    store.addDesc(d, 'html', p.htmlDesc);
    store.addDesc(d, 'fallback', p.fallback);
  } else {
    const p = parseDjinniJob(r.body);
    if (p.jp) applyJsonLd(store, d, p.jp, 'jsonld', 'jsonld');
    store.set(d, 'title', p.title, 'html');
    store.set(d, 'experienceYears', p.meta.experienceYears, 'html');
    store.set(d, 'englishLevel', p.meta.englishLevel, 'html');
    store.set(d, 'views', p.meta.views, 'html');
    store.set(d, 'applications', p.meta.applications, 'html');
    store.set(d, 'remote', p.meta.remote, 'html');
    store.set(d, 'countries', p.countries, 'html');
    store.addDesc(d, 'html', p.htmlDesc);
    store.addDesc(d, 'fallback', p.fallback);
  }
  if (!d.descs.length) warn(`${d.id}: опис не знайдено (розмітка змінилась?)`);
}

/** довжина тексту без пробілів і пунктуації, щоб форматування не впливало на порівняння */
const contentLen = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, '').length;
const bestLen = (d: Draft, origins: DescOrigin[]) =>
  d.descs.filter((x) => origins.includes(x.origin)).reduce((max, x) => Math.max(max, contentLen(x.text)), 0);

/**
 * Djinni: тексти в списку можуть бути як повними, так і обрізаними.
 * Відкриваємо кілька сторінок і порівнюємо: якщо на сторінці помітно довше, список обрізає тексти.
 */
async function probeDjinniListingText(ctx: Ctx, sample: Draft[]): Promise<Checks['djinniListingText']> {
  let compared = 0;
  let truncated = 0;
  for (const d of sample) {
    const listed = bestLen(d, ['listing']);
    try {
      await fetchDetail(ctx, d);
    } catch (err) {
      ctx.warn(`${d.id}: ${errMsg(err)}`);
      if (err instanceof ChallengeError) break;
      continue;
    }
    const detailed = bestLen(d, ['jsonld', 'html']);
    if (!listed || !detailed) continue;
    compared++;
    if (detailed > listed * 1.15 && detailed - listed > 150) truncated++;
  }
  if (compared === 0) return 'unknown';
  return truncated > 0 ? 'truncated' : 'full';
}

export async function fetchDetails(ctx: Ctx): Promise<void> {
  const { store, log, warn, opts } = ctx;
  for (const source of ['dou', 'djinni'] as const) {
    const all = [...store.drafts.values()].filter((d) => d.source === source);
    let todo = all.filter(
      (d) => needsDetails(store, d) && (!opts.detailFilter || opts.detailFilter(d.id, d.url)),
    );

    if (source === 'djinni') {
      const complete = all.filter((d) => !needsDetails(store, d));
      if (complete.length) {
        const sample = complete.slice(0, 5);
        log(`\nDjinni: перевіряю на ${sample.length} сторінках, чи тексти у списку повні`);
        const verdict = await probeDjinniListingText(ctx, sample);
        ctx.checks.djinniListingText = verdict;
        if (verdict === 'truncated') {
          const rest = complete.slice(sample.length);
          todo = [...todo, ...rest];
          log(`  у списку тексти обрізані: відкрию ще ${rest.length} сторінок`);
        } else if (verdict === 'full') {
          log('  у списку тексти повні: сторінки відкриваю лише для неповних записів');
        } else {
          warn('Djinni: не вдалося порівняти тексти списку зі сторінками вакансій, тексти лишились зі списку');
        }
      }
    }

    const batch = opts.limit > 0 ? todo.slice(0, opts.limit) : todo;
    if (!batch.length) continue;
    log(`\nДеталі ${source}: ${batch.length}${batch.length < todo.length ? ` з ${todo.length} (--limit)` : ''}`);
    let done = 0;
    for (const d of batch) {
      done++;
      try {
        await fetchDetail(ctx, d);
      } catch (err) {
        warn(`${d.id}: ${errMsg(err)}`);
        if (err instanceof ChallengeError) break;
      }
      if (done % 10 === 0 || done === batch.length) log(`  ${source}: ${done}/${batch.length}`);
    }
  }
}

// ─── Збирання результату ───────────────────────────────────────────────────

export interface Output {
  meta: {
    generatedAt: string;
    partial: boolean;
    nodeVersion: string;
    options: Omit<Options, 'cacheDir' | 'out'>;
    queries: QueryStat[];
    checks: Checks;
    counts: {
      total: number;
      bySource: Record<string, number>;
      byTrack: Record<string, number>;
      byDescriptionSource: Record<string, number>;
      duplicates: number;
      missingDescription: number;
      gone: number;
    };
    blockedHosts: string[];
    warnings: string[];
  };
  vacancies: Vacancy[];
}

export function buildOutput(ctx: Ctx, partial: boolean): Output {
  const vacancies = ctx.store.finalize();
  const tally = (keys: string[]) =>
    keys.reduce<Record<string, number>>((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});
  const { cacheDir: _c, out: _o, ...options } = ctx.opts;
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      partial,
      nodeVersion: process.version,
      options,
      queries: ctx.queryStats,
      checks: ctx.checks,
      counts: {
        total: vacancies.length,
        bySource: tally(vacancies.map((v) => v.source)),
        byTrack: tally(vacancies.flatMap((v) => v.tracks)),
        byDescriptionSource: tally(vacancies.map((v) => v.descriptionSource)),
        duplicates: vacancies.filter((v) => v.duplicateOf).length,
        missingDescription: vacancies.filter((v) => !v.description).length,
        gone: vacancies.filter((v) => v.gone).length,
      },
      blockedHosts: [...ctx.http.blockedHosts],
      warnings: ctx.warnings,
    },
    vacancies,
  };
}

export function selectQueries(only: string[]): Query[] {
  if (!only.length) return QUERIES;
  const picked = QUERIES.filter((q) => only.includes(q.source) || only.includes(q.id));
  if (!picked.length) throw new Error(`--only=${only.join(',')} не збігся ні з джерелом, ні з id запиту`);
  return picked;
}

/** Collect all listing pages (no detail pages). */
export async function collectListings(ctx: Ctx): Promise<void> {
  await mkdir(ctx.opts.cacheDir, { recursive: true });
  for (const q of selectQueries(ctx.opts.only)) {
    const stat: QueryStat = { id: q.id, source: q.source, track: q.track, url: q.url, found: 0, error: 'не завершено' };
    ctx.queryStats.push(stat);
    try {
      stat.found = q.source === 'dou' ? await collectDouQuery(ctx, q) : await collectDjinniQuery(ctx, q);
      delete stat.error;
    } catch (err) {
      stat.error = errMsg(err);
      ctx.warn(`[${q.id}] ${stat.error}`);
    }
  }
}

export async function run(ctx: Ctx): Promise<void> {
  await collectListings(ctx);
  if (!ctx.opts.skipDetails) await fetchDetails(ctx);
}

function printSummary(out: Output, file: string): void {
  const c = out.meta.counts;
  console.error(`\n${out.meta.partial ? 'Частковий результат' : 'Готово'}: ${c.total} вакансій → ${file}`);
  console.error(`  джерела: ${JSON.stringify(c.bySource)}`);
  console.error(`  треки:   ${JSON.stringify(c.byTrack)}`);
  console.error(`  опис з:  ${JSON.stringify(c.byDescriptionSource)}`);
  console.error(`  дублікати між сайтами: ${c.duplicates}, без опису: ${c.missingDescription}, зняті: ${c.gone}`);
  for (const q of out.meta.queries)
    console.error(`  ${q.error ? '✗' : '✓'} ${q.id}: ${q.found}${q.error ? ` (${q.error})` : ''}`);
  if (out.meta.checks.djinniListingText !== 'not-checked') {
    console.error(`  тексти у списку Djinni: ${out.meta.checks.djinniListingText}`);
  }
  if (out.meta.blockedHosts.length) console.error(`  заблоковані хости: ${out.meta.blockedHosts.join(', ')}`);
  if (out.meta.warnings.length)
    console.error(`  попереджень: ${out.meta.warnings.length} (див. meta.warnings у файлі)`);
  if (out.meta.queries.some((q) => q.error?.includes('HTTP 403'))) {
    console.error('  Підказка: 403 без капчі зазвичай означає фільтр за User-Agent або мережею.');
    console.error('  Перевір URL у браузері; можна задати SCRAPER_UA з рядком свого браузера або вимкнути VPN.');
  }
}

async function main(): Promise<void> {
  const opts = parseCli();
  const ctx = makeCtx(opts);
  let written = false;
  const save = async (partial: boolean) => {
    if (written) return;
    written = true;
    const out = buildOutput(ctx, partial);
    await writeFile(opts.out, JSON.stringify(out, null, 2));
    printSummary(out, opts.out);
  };
  process.once('SIGINT', () => {
    console.error('\nЗупинка: зберігаю вже зібране...');
    save(true).finally(() => process.exit(130));
  });
  try {
    await run(ctx);
    await save(false);
  } catch (err) {
    ctx.warn(`фатальна помилка: ${errMsg(err)}`);
    await save(true);
    process.exitCode = 1;
  }
}

// Тести імпортують модуль з SCRAPER_NO_MAIN=1; звичайний запуск одразу стартує збір.
if (!process.env.SCRAPER_NO_MAIN) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}