/**
 * watch-app.test.ts
 *
 * Tests for the study app client against a local http server that plays /api/applications.
 * Run with: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  APP_PENDING_MAX,
  buildAppDigestMessage,
  enqueueApplication,
  fetchReadyApplications,
  flushPending,
  parseBriefApplications,
  postApplication,
  readyApplicationsPhrase,
  type AppClientOptions,
  type AppQueueItem,
  type PendingAppQueueItem,
} from './watch-app.js';

// ─── Mock app ────────────────────────────────────────────────────────────────

interface ReceivedRequest {
  method: string;
  url: string;
  token: string | null;
  body: unknown;
}

interface MockReply {
  status: number;
  body: unknown;
}

const TOKEN = 'test-token';
const received: ReceivedRequest[] = [];
const logged: string[] = [];
/** Replies are consumed in order; when the list is empty the mock answers 201 { ok: true }. */
const replies: MockReply[] = [];

let server: Server;
let opts: AppClientOptions;

function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    received.push({
      method: req.method ?? '',
      url: req.url ?? '',
      token: typeof req.headers['x-automation-token'] === 'string' ? req.headers['x-automation-token'] : null,
      body: raw ? JSON.parse(raw) : null,
    });
    const reply = replies.shift() ?? { status: 201, body: { ok: true } };
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
}

before(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  opts = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: TOKEN,
    timeoutMs: 2_000,
    log: async (msg: string) => { logged.push(msg); },
  };
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const item = (url: string): AppQueueItem => ({
  url, title: 'Senior Node.js Developer', company: 'Acme', source: 'dou', score: 11, description: 'Node.js, NestJS',
});

const reset = () => { received.length = 0; logged.length = 0; replies.length = 0; };

// ─── postApplication ─────────────────────────────────────────────────────────

describe('postApplication', () => {
  it('sends the expected body and token, 201 = ok', async () => {
    reset();
    const outcome = await postApplication(opts, item('https://jobs.dou.ua/companies/acme/vacancies/1/'));
    assert.equal(outcome, 'ok');
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/api/applications');
    assert.equal(received[0].token, TOKEN);
    assert.deepEqual(received[0].body, {
      url: 'https://jobs.dou.ua/companies/acme/vacancies/1/',
      title: 'Senior Node.js Developer', company: 'Acme', source: 'dou', score: 11, description: 'Node.js, NestJS',
    });
    assert.deepEqual(logged, []);
  });
  it('200 (already exists) = ok', async () => {
    reset();
    replies.push({ status: 200, body: { ok: true, existed: true } });
    assert.equal(await postApplication(opts, item('https://x/1')), 'ok');
  });
  it('404 / 500 = retry, with a log line', async () => {
    reset();
    replies.push({ status: 404, body: 'Not found' }, { status: 500, body: { error: 'boom' } });
    assert.equal(await postApplication(opts, item('https://x/1')), 'retry');
    assert.equal(await postApplication(opts, item('https://x/1')), 'retry');
    assert.equal(logged.length, 2);
    assert.match(logged[0], /App queue: HTTP 404/);
    assert.match(logged[1], /App queue: HTTP 500 .*boom/);
  });
  it('400 / 401 = drop (retrying cannot help)', async () => {
    reset();
    replies.push({ status: 400, body: { error: 'bad body' } }, { status: 401, body: { error: 'bad token' } });
    assert.equal(await postApplication(opts, item('https://x/1')), 'drop');
    assert.equal(await postApplication(opts, item('https://x/1')), 'drop');
    assert.equal(logged.length, 2);
  });
  it('unreachable host = retry, never throws', async () => {
    reset();
    const dead: AppClientOptions = { ...opts, baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 };
    assert.equal(await postApplication(dead, item('https://x/1')), 'retry');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /App queue: request failed/);
  });
});

// ─── enqueueApplication / flushPending ───────────────────────────────────────

describe('enqueueApplication', () => {
  it('success leaves pending untouched', async () => {
    reset();
    const pending = await enqueueApplication(opts, [], item('https://x/1'));
    assert.deepEqual(pending, []);
  });
  it('temporary failure parks the item once per url', async () => {
    reset();
    replies.push({ status: 503, body: {} }, { status: 503, body: {} });
    const now = Date.parse('2026-10-27T10:00:00.000Z');
    let pending = await enqueueApplication(opts, [], item('https://x/1'), now);
    pending = await enqueueApplication(opts, pending, item('https://x/1'), now);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0], { item: item('https://x/1'), queuedAt: '2026-10-27T10:00:00.000Z', attempts: 1 });
  });
  it('permanent failure is not parked', async () => {
    reset();
    replies.push({ status: 401, body: {} });
    assert.deepEqual(await enqueueApplication(opts, [], item('https://x/1')), []);
  });
  it('pending list is capped, oldest dropped first', async () => {
    reset();
    let pending: PendingAppQueueItem[] = [];
    for (let i = 0; i < APP_PENDING_MAX + 3; i++) {
      replies.push({ status: 502, body: {} });
      pending = await enqueueApplication(opts, pending, item(`https://x/${i}`));
    }
    assert.equal(pending.length, APP_PENDING_MAX);
    assert.equal(pending[0].item.url, 'https://x/3');
  });
});

describe('flushPending', () => {
  it('sends what it can, keeps retries with attempts+1, drops permanent and expired', async () => {
    reset();
    const now = Date.parse('2026-10-27T10:00:00.000Z');
    const fresh = '2026-10-26T10:00:00.000Z';
    const old = '2026-10-01T10:00:00.000Z';
    const pending: PendingAppQueueItem[] = [
      { item: item('https://x/ok'),      queuedAt: fresh, attempts: 1 },
      { item: item('https://x/retry'),   queuedAt: fresh, attempts: 2 },
      { item: item('https://x/drop'),    queuedAt: fresh, attempts: 1 },
      { item: item('https://x/expired'), queuedAt: old,   attempts: 5 },
    ];
    replies.push({ status: 200, body: {} }, { status: 500, body: {} }, { status: 400, body: {} });
    const result = await flushPending(opts, pending, now);
    assert.equal(result.sent, 1);
    assert.equal(result.expired, 1);
    assert.deepEqual(result.pending, [{ item: item('https://x/retry'), queuedAt: fresh, attempts: 3 }]);
    assert.equal(received.length, 3, 'the expired item is not sent');
  });
});

// ─── Ready digest ─────────────────────────────────────────────────────────────

describe('parseBriefApplications', () => {
  it('accepts an array, { items }, { applications }', () => {
    const one = [{ title: ' A ', company: 'Acme' }, { title: 'B', company: null }, { title: 'C' }, { title: '' }, 42, null];
    const expected = [{ title: 'A', company: 'Acme' }, { title: 'B', company: null }, { title: 'C', company: null }];
    assert.deepEqual(parseBriefApplications(one), expected);
    assert.deepEqual(parseBriefApplications({ items: one }), expected);
    assert.deepEqual(parseBriefApplications({ applications: one }), expected);
  });
  it('unknown shape = null', () => {
    assert.equal(parseBriefApplications({ count: 3 }), null);
    assert.equal(parseBriefApplications('nope'), null);
    assert.equal(parseBriefApplications(null), null);
  });
});

describe('fetchReadyApplications', () => {
  it('GETs with status=ready&brief=1 and the token', async () => {
    reset();
    replies.push({ status: 200, body: [{ title: 'A', company: 'Acme' }] });
    const items = await fetchReadyApplications(opts);
    assert.deepEqual(items, [{ title: 'A', company: 'Acme' }]);
    assert.equal(received[0].method, 'GET');
    assert.equal(received[0].url, '/api/applications?status=ready&brief=1');
    assert.equal(received[0].token, TOKEN);
  });
  it('non-2xx, invalid JSON and unknown shape = null with a log line', async () => {
    reset();
    replies.push({ status: 500, body: {} }, { status: 200, body: '{not json' }, { status: 200, body: { count: 1 } });
    assert.equal(await fetchReadyApplications(opts), null);
    assert.equal(await fetchReadyApplications(opts), null);
    assert.equal(await fetchReadyApplications(opts), null);
    assert.equal(logged.length, 3);
    assert.match(logged[0], /HTTP 500/);
    assert.match(logged[1], /invalid JSON/);
    assert.match(logged[2], /unexpected response shape/);
  });
  it('unreachable host = null, never throws', async () => {
    reset();
    assert.equal(await fetchReadyApplications({ ...opts, baseUrl: 'http://127.0.0.1:1' }), null);
    assert.match(logged[0], /App digest: request failed/);
  });
});

describe('readyApplicationsPhrase', () => {
  it('Ukrainian plural forms', () => {
    assert.equal(readyApplicationsPhrase(1), '1 готова заявка');
    assert.equal(readyApplicationsPhrase(2), '2 готові заявки');
    assert.equal(readyApplicationsPhrase(4), '4 готові заявки');
    assert.equal(readyApplicationsPhrase(5), '5 готових заявок');
    assert.equal(readyApplicationsPhrase(11), '11 готових заявок');
    assert.equal(readyApplicationsPhrase(21), '21 готова заявка');
    assert.equal(readyApplicationsPhrase(112), '112 готових заявок');
  });
});

describe('buildAppDigestMessage', () => {
  it('header, numbered lines with escaping, link to the app page', () => {
    const msg = buildAppDigestMessage(
      [{ title: 'Node <Senior>', company: 'A & B' }, { title: 'Fullstack', company: null }],
      'https://app.example',
    );
    assert.equal(msg, [
      '📋 <b>У черзі 2 готові заявки</b>',
      '',
      '1. Node &lt;Senior&gt;, A &amp; B',
      '2. Fullstack',
      '',
      'https://app.example/applications',
    ].join('\n'));
  });
  it('caps at 10 lines and says how many more', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ title: `T${i + 1}`, company: null }));
    const lines = buildAppDigestMessage(items, 'https://app.example').split('\n');
    assert.equal(lines[0], '📋 <b>У черзі 12 готових заявок</b>');
    assert.equal(lines.filter((l) => /^\d+\. /.test(l)).length, 10);
    assert.ok(lines.includes('… і ще 2'));
  });
});
