/**
 * watch-app.ts
 *
 * Client for the study app (workflow-automation) used by watch.ts:
 *   POST {baseUrl}/api/applications                      one vacancy into the applications queue
 *   GET  {baseUrl}/api/applications?status=ready&brief=1  list for the "ready applications" digest
 *
 * No module state, no I/O besides fetch; the logger is injected, so unit tests can run it
 * against a local http server. Nothing here throws on HTTP or network errors: every failure
 * becomes a log line and a return value, because the Telegram flow must never be interrupted.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type AppSource = 'dou' | 'djinni';

/** Body of POST /api/applications. The endpoint is idempotent by url (200 when it already exists). */
export interface AppQueueItem {
  url: string;
  title: string;
  company: string;
  source: AppSource;
  score: number;
  description: string;
}

/** A POST that failed temporarily (network, 404 while the endpoint is not deployed yet, 5xx). */
export interface PendingAppQueueItem {
  item: AppQueueItem;
  queuedAt: string;
  attempts: number;
}

/** One line of GET /api/applications?status=ready&brief=1. */
export interface BriefApplication {
  title: string;
  company: string | null;
}

export type AppPostOutcome = 'ok' | 'retry' | 'drop';

export interface AppClientOptions {
  /** APP_URL without a trailing slash. */
  baseUrl: string;
  /** APP_TOKEN, sent as x-automation-token. */
  token: string;
  timeoutMs: number;
  log: (msg: string) => Promise<void>;
}

export interface FlushResult {
  pending: PendingAppQueueItem[];
  sent: number;
  expired: number;
}

export const APP_PENDING_MAX = 50;
export const APP_PENDING_MAX_AGE_MS = 7 * 86_400_000;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ─── Queue ────────────────────────────────────────────────────────────────────

/** One POST. 'drop' = the request itself is wrong (bad token / bad body), retrying cannot help. */
export async function postApplication(opts: AppClientOptions, item: AppQueueItem): Promise<AppPostOutcome> {
  const short = item.title.slice(0, 50);
  try {
    const res = await fetch(`${opts.baseUrl}/api/applications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-automation-token': opts.token },
      body: JSON.stringify(item),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.ok) return 'ok';
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    await opts.log(`App queue: HTTP ${res.status} for "${short}" ${body}`.trimEnd());
    const permanent = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422;
    return permanent ? 'drop' : 'retry';
  } catch (err) {
    await opts.log(`App queue: request failed for "${short}": ${errText(err)}`);
    return 'retry';
  }
}

/**
 * POST now; on a temporary failure add the item to `pending` (deduplicated by url,
 * capped at APP_PENDING_MAX, oldest dropped first). Returns the new pending list.
 */
export async function enqueueApplication(
  opts: AppClientOptions,
  pending: PendingAppQueueItem[],
  item: AppQueueItem,
  nowMs: number = Date.now(),
): Promise<PendingAppQueueItem[]> {
  const outcome = await postApplication(opts, item);
  if (outcome !== 'retry') return pending;
  if (pending.some((p) => p.item.url === item.url)) return pending;
  const next = [...pending, { item, queuedAt: new Date(nowMs).toISOString(), attempts: 1 }];
  return next.length > APP_PENDING_MAX ? next.slice(next.length - APP_PENDING_MAX) : next;
}

/** Retry every pending POST once; drop items older than APP_PENDING_MAX_AGE_MS. */
export async function flushPending(
  opts: AppClientOptions,
  pending: PendingAppQueueItem[],
  nowMs: number = Date.now(),
): Promise<FlushResult> {
  const keep: PendingAppQueueItem[] = [];
  let sent = 0;
  let expired = 0;
  for (const p of pending) {
    if (nowMs - new Date(p.queuedAt).getTime() > APP_PENDING_MAX_AGE_MS) { expired++; continue; }
    const outcome = await postApplication(opts, p.item);
    if (outcome === 'ok') { sent++; continue; }
    if (outcome === 'retry') keep.push({ ...p, attempts: p.attempts + 1 });
  }
  return { pending: keep, sent, expired };
}

// ─── Ready digest ─────────────────────────────────────────────────────────────

/** Accepts a bare array or { items: [...] } / { applications: [...] }; null = unknown shape. */
export function parseBriefApplications(json: unknown): BriefApplication[] | null {
  let list: unknown[] | null = null;
  if (Array.isArray(json)) {
    list = json;
  } else if (json !== null && typeof json === 'object') {
    const obj = json as { items?: unknown; applications?: unknown };
    if (Array.isArray(obj.items)) list = obj.items;
    else if (Array.isArray(obj.applications)) list = obj.applications;
  }
  if (list === null) return null;
  const out: BriefApplication[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const o = raw as { title?: unknown; company?: unknown };
    if (typeof o.title !== 'string' || o.title.trim() === '') continue;
    const company = typeof o.company === 'string' && o.company.trim() !== '' ? o.company.trim() : null;
    out.push({ title: o.title.trim(), company });
  }
  return out;
}

/** GET the ready applications. null = request failed or unknown shape (already logged). */
export async function fetchReadyApplications(opts: AppClientOptions): Promise<BriefApplication[] | null> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/api/applications?status=ready&brief=1`, {
      headers: { accept: 'application/json', 'x-automation-token': opts.token },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    await opts.log(`App digest: request failed: ${errText(err)}`);
    return null;
  }
  if (!res.ok) { await opts.log(`App digest: HTTP ${res.status}, nothing sent`); return null; }
  let json: unknown;
  try { json = await res.json(); }
  catch (err) { await opts.log(`App digest: invalid JSON: ${errText(err)}`); return null; }
  const items = parseBriefApplications(json);
  if (items === null) await opts.log('App digest: unexpected response shape, nothing sent');
  return items;
}

/** Ukrainian plural: 1 готова заявка, 2 готові заявки, 5 готових заявок. */
export function readyApplicationsPhrase(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} готова заявка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} готові заявки`;
  return `${n} готових заявок`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram HTML: header, up to 10 lines "title, company", link to the app page. */
export function buildAppDigestMessage(items: BriefApplication[], baseUrl: string, maxLines = 10): string {
  const lines = [`📋 <b>У черзі ${readyApplicationsPhrase(items.length)}</b>`, ''];
  items.slice(0, maxLines).forEach((it, i) => {
    lines.push(`${i + 1}. ${escapeHtml(it.title)}${it.company ? `, ${escapeHtml(it.company)}` : ''}`);
  });
  if (items.length > maxLines) lines.push(`… і ще ${items.length - maxLines}`);
  lines.push('', `${baseUrl}/applications`);
  return lines.join('\n');
}
