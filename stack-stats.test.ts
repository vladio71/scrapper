/**
 * stack-stats.test.ts
 *
 * Unit tests for the alias matching and the statistics in stack-stats.ts.
 * Run with: npm test
 */

process.env.STACK_STATS_NO_MAIN = '1';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  aliasToRegExp, compileTechnologies, matchTechnologies, computeStats, loadConfig, readVacancyFile,
} = await import('./stack-stats.js');

const FIXTURE = 'test-data/vacancies.sample.json';
const CONFIG  = 'stack-stats.config.json';
/** Fixed clock so the fixture dates never age out of the window. */
const NOW_MS = Date.parse('2026-10-27T12:00:00.000Z');

// ─── aliasToRegExp ───────────────────────────────────────────────────────────

describe('aliasToRegExp', () => {
  it('matches a whole word, case-insensitive', () => {
    const re = aliasToRegExp('redis', false);
    assert.ok(re.test('Experience with Redis and Kafka'));
    assert.ok(re.test('redis,'));
  });
  it('does not match inside another word', () => {
    assert.ok(!aliasToRegExp('go', false).test('MongoDB and Django and golang'));
    assert.ok(!aliasToRegExp('react', false).test('reactive streams'));
  });
  it('treats a dot in the alias literally', () => {
    const re = aliasToRegExp('node.js', false);
    assert.ok(re.test('Node.JS developer'));
    assert.ok(!re.test('nodeXjs'));
  });
  it('spaces match any whitespace including none', () => {
    const re = aliasToRegExp('node js', false);
    assert.ok(re.test('NodeJS'));
    assert.ok(re.test('Node JS'));
    assert.ok(re.test('node   js'));
  });
  it('slash allows spaces around it', () => {
    const re = aliasToRegExp('ci/cd', false);
    assert.ok(re.test('CI/CD pipelines'));
    assert.ok(re.test('CI / CD'));
  });
  it('case-sensitive alias keeps the case', () => {
    const re = aliasToRegExp('Express', true);
    assert.ok(re.test('Node.js, Express, PostgreSQL'));
    assert.ok(!re.test('feel free to express yourself'));
  });
  it('works next to punctuation and Cyrillic text', () => {
    const re = aliasToRegExp('docker', false);
    assert.ok(re.test('досвід з Docker, Kubernetes'));
    assert.ok(re.test('(Docker)'));
    assert.ok(!re.test('Dockerfile'));
  });
});

// ─── matchTechnologies ───────────────────────────────────────────────────────

describe('matchTechnologies', () => {
  const compiled = compileTechnologies([
    { name: 'Node.js', aliases: ['node.js', 'node js'], caseSensitiveAliases: ['Node'] },
    { name: 'Express', aliases: ['express.js'], caseSensitiveAliases: ['Express'] },
    { name: 'RAG', aliases: [], caseSensitiveAliases: ['RAG'] },
    { name: 'LLM', aliases: ['llm', 'openai', 'gpt'] },
  ]);

  it('returns each technology once, in config order', () => {
    assert.deepEqual(
      matchTechnologies('Node.js and NodeJS and Node, plus OpenAI GPT-4 and an LLM', compiled),
      ['Node.js', 'LLM'],
    );
  });
  it('ignores English words that only look like technologies', () => {
    assert.deepEqual(matchTechnologies('express yourself in a rag-tag team', compiled), []);
  });
  it('matches the real names', () => {
    assert.deepEqual(matchTechnologies('Express, RAG pipelines', compiled), ['Express', 'RAG']);
  });
  it('does not match "gpt" inside "ChatGPT" without its own alias', () => {
    assert.deepEqual(matchTechnologies('ChatGPT plugins', compiled), []);
  });
});

// ─── computeStats on the fixture ─────────────────────────────────────────────

const cfg = await loadConfig(CONFIG);
const file = await readVacancyFile(FIXTURE);
const compiled = compileTechnologies(cfg.technologies);
const stats = computeStats(file.vacancies, cfg, compiled, NOW_MS, { input: FIXTURE, inputGeneratedAt: file.generatedAt });
const byName = new Map(stats.technologies.map((t) => [t.name, t]));

describe('computeStats (fixture)', () => {
  it('keeps only backend + fullstack, fresh, unique, not gone, dated', () => {
    assert.equal(stats.totalInInput, 9);
    assert.equal(stats.analysed, 3);
    assert.deepEqual(stats.skipped, { duplicates: 1, gone: 1, otherCategory: 2, tooOld: 1, undated: 1 });
  });
  it('reports the publish date range of the analysed vacancies', () => {
    assert.deepEqual(stats.dateRange, { from: '2026-09-15', to: '2026-10-20' });
    assert.equal(stats.inputGeneratedAt, '2026-10-27T09:00:00.000Z');
  });
  it('counts a technology once per vacancy and computes percent', () => {
    assert.deepEqual(byName.get('Node.js'), { name: 'Node.js', count: 3, percent: 100 });
    assert.deepEqual(byName.get('PostgreSQL'), { name: 'PostgreSQL', count: 3, percent: 100 });
    assert.deepEqual(byName.get('Redis'), { name: 'Redis', count: 2, percent: 66.7 });
    assert.deepEqual(byName.get('ClickHouse'), { name: 'ClickHouse', count: 0, percent: 0 });
  });
  it('whole-word and case rules hold on real text', () => {
    assert.equal(byName.get('Express')?.count, 1, 'only the vacancy with Express.js');
    assert.equal(byName.get('RAG')?.count, 1, 'only the vacancy with "RAG"');
    assert.equal(byName.get('Jest')?.count, 1, 'Jest in the fullstack one; "no jest about it" in the backend one does not count');
    assert.equal(byName.get('CI/CD')?.count, 2, '"CI / CD" and "GitLab CI"');
    assert.equal(byName.get('Kubernetes')?.count, 2, '"Kubernetes (k8s)" and "Kubernetes"');
    assert.equal(byName.get('Serverless')?.count, 1, '"Lambda" in the AWS line');
  });
  it('sorts by percent desc, then name', () => {
    const percents = stats.technologies.map((t) => t.percent);
    assert.deepEqual(percents, [...percents].sort((a, b) => b - a));
    const top = stats.technologies.filter((t) => t.percent === 100).map((t) => t.name);
    assert.deepEqual(top, [...top].sort((a, b) => a.localeCompare(b)));
  });
  it('--days narrows the window', () => {
    const narrow = computeStats(file.vacancies, { ...cfg, days: 20 }, compiled, NOW_MS, { input: FIXTURE, inputGeneratedAt: null });
    assert.equal(narrow.analysed, 2);
    assert.equal(narrow.skipped.tooOld, 2);
  });
});
