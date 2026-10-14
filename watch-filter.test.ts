/**
 * watch-filter.test.ts
 *
 * Unit tests for watch-filter.ts pure functions.
 * Run with: npm test  (tsx --test watch-filter.test.ts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasOwnStack,
  findForeignStacks,
  findYearsWithForeignStack,
  parseSections,
  checkForeignStackFilter,
} from './watch-filter.js';

const ALL_STACKS = [
  'rust', 'golang', 'go', 'java', 'kotlin', 'scala',
  'dotnet', 'csharp', 'php', 'ruby', 'rails', 'cpp',
  'elixir', 'Swift', 'android', 'ios', 'flutter', 'dart',
];

const PENALTY = -4;

// ─── hasOwnStack ─────────────────────────────────────────────────────────────

describe('hasOwnStack', () => {
  it('matches Node.js', () => assert.ok(hasOwnStack('Node.js developer')));
  it('matches bare Node', () => assert.ok(hasOwnStack('Senior Node Developer')));
  it('matches Node JS (with space)', () => assert.ok(hasOwnStack('Node JS backend')));
  it('matches TypeScript', () => assert.ok(hasOwnStack('TypeScript engineer')));
  it('matches JavaScript', () => assert.ok(hasOwnStack('JavaScript fullstack')));
  it('matches React', () => assert.ok(hasOwnStack('React developer')));
  it('matches React Native', () => assert.ok(hasOwnStack('React Native developer')));
  it('matches Next.js', () => assert.ok(hasOwnStack('Next.js / Node.js')));
  it('matches Python', () => assert.ok(hasOwnStack('Python FastAPI backend')));
  it('matches FastAPI', () => assert.ok(hasOwnStack('build services with FastAPI')));
  it('matches Django', () => assert.ok(hasOwnStack('Django REST framework')));
  it('does not match Rust alone', () => assert.ok(!hasOwnStack('Senior Rust Engineer')));
  it('does not match Go alone', () => assert.ok(!hasOwnStack('Go developer')));
});

// ─── findForeignStacks ───────────────────────────────────────────────────────

describe('findForeignStacks – Go false-positives', () => {
  it('does not match "go-to"', () =>
    assert.deepEqual(findForeignStacks('go-to engineer', ALL_STACKS), []));
  it('does not match "go live"', () =>
    assert.deepEqual(findForeignStacks('go live on Thursday', ALL_STACKS), []));
  it('does not match "on the go"', () =>
    assert.deepEqual(findForeignStacks('on the go', ALL_STACKS), []));
  it('does not match "Go beyond"', () =>
    assert.deepEqual(findForeignStacks('Go beyond the ordinary', ALL_STACKS), []));
  it('does not match "Good communication, MongoDB, Django"', () =>
    assert.deepEqual(findForeignStacks('Good communication, MongoDB, Django', ALL_STACKS), []));
});

describe('findForeignStacks – Go true-positives', () => {
  it('matches "Node.js, Go, PostgreSQL"', () =>
    assert.ok(findForeignStacks('Node.js, Go, PostgreSQL', ALL_STACKS).includes('go')));
  it('matches "Go developer"', () =>
    assert.ok(findForeignStacks('Go developer', ALL_STACKS).includes('go')));
  it('matches "Node.js / Go"', () =>
    assert.ok(findForeignStacks('Node.js / Go', ALL_STACKS).includes('go')));
  it('matches "(Go)"', () =>
    assert.ok(findForeignStacks('experience with (Go)', ALL_STACKS).includes('go')));
  it('matches golang regardless of case', () =>
    assert.ok(findForeignStacks('golang backend service', ALL_STACKS).includes('golang')));
});

describe('findForeignStacks – Java vs JavaScript', () => {
  it('"Senior Java Developer" → java', () =>
    assert.ok(findForeignStacks('Senior Java Developer', ALL_STACKS).includes('java')));
  it('"Senior JavaScript Developer" → no java', () =>
    assert.ok(!findForeignStacks('Senior JavaScript Developer', ALL_STACKS).includes('java')));
  it('"Java 17, Node.js" → java', () =>
    assert.ok(findForeignStacks('Java 17, Node.js', ALL_STACKS).includes('java')));
});

describe('findForeignStacks – .net', () => {
  it('matches ".NET"', () =>
    assert.ok(findForeignStacks('.NET 8 backend', ALL_STACKS).includes('dotnet')));
  it('matches "asp.net"', () =>
    assert.ok(findForeignStacks('ASP.NET Core', ALL_STACKS).includes('dotnet')));
  it('does not match "company.net"', () =>
    assert.ok(!findForeignStacks('visit company.net for details', ALL_STACKS).includes('dotnet')));
});

describe('findForeignStacks – c# and c++', () => {
  it('matches "C#"', () =>
    assert.ok(findForeignStacks('C# developer', ALL_STACKS).includes('csharp')));
  it('does not match "c#tag" (letter after #)', () =>
    assert.ok(!findForeignStacks('c#tag in description', ALL_STACKS).includes('csharp')));
  it('matches "C++"', () =>
    assert.ok(findForeignStacks('C++ engineer', ALL_STACKS).includes('cpp')));
});

describe('findForeignStacks – Swift (case-sensitive)', () => {
  it('matches "Swift"', () =>
    assert.ok(findForeignStacks('Swift developer', ALL_STACKS).includes('Swift')));
  it('does not match "SWIFT" (banking)', () =>
    assert.ok(!findForeignStacks('SWIFT payments', ALL_STACKS).includes('Swift')));
  it('does not match lowercase "swift"', () =>
    assert.ok(!findForeignStacks('swift response time', ALL_STACKS).includes('Swift')));
});

describe('findForeignStacks – rails', () => {
  it('matches "Rails framework"', () =>
    assert.ok(findForeignStacks('Rails framework experience', ALL_STACKS).includes('rails')));
  it('does not match "guardrails"', () =>
    assert.ok(!findForeignStacks('use guardrails for safety', ALL_STACKS).includes('rails')));
  it('does not match "guard rails"', () =>
    assert.ok(!findForeignStacks('add guard rails to the API', ALL_STACKS).includes('rails')));
});

describe('findForeignStacks – android / ios as role only', () => {
  it('matches "Android developer"', () =>
    assert.ok(findForeignStacks('Android developer', ALL_STACKS).includes('android')));
  it('matches "native Android"', () =>
    assert.ok(findForeignStacks('native Android experience', ALL_STACKS).includes('android')));
  it('does not match bare "Android" (platform mention)', () =>
    assert.ok(!findForeignStacks('supports Android and iOS', ALL_STACKS).includes('android')));
  it('matches "iOS developer"', () =>
    assert.ok(findForeignStacks('iOS developer', ALL_STACKS).includes('ios')));
  it('does not match bare "iOS" (platform mention)', () =>
    assert.ok(!findForeignStacks('React Native, iOS, Android', ALL_STACKS).includes('ios')));
});

// ─── findYearsWithForeignStack ────────────────────────────────────────────────

describe('findYearsWithForeignStack', () => {
  it('detects "5+ years of commercial Rust experience ..." → years:rust', () => {
    const text = '5+ years of commercial Rust experience building production applications';
    assert.equal(findYearsWithForeignStack(text, ALL_STACKS), 'rust');
  });
  it('returns null when own stack co-occurs ("5+ years Node.js and Rust")', () => {
    const text = '5+ years Node.js and Rust development';
    assert.equal(findYearsWithForeignStack(text, ALL_STACKS), null);
  });
  it('detects Ukrainian "5+ років досвіду з Java" → years:java', () => {
    const text = '5+ років досвіду з Java та Spring Boot';
    assert.equal(findYearsWithForeignStack(text, ALL_STACKS), 'java');
  });
  it('returns null when no years pattern', () => {
    assert.equal(findYearsWithForeignStack('Rust experience preferred', ALL_STACKS), null);
  });
  it('stops at sentence boundary (. ends snippet)', () => {
    // The Rust is past the sentence boundary — should NOT trigger
    const text = '3+ years of experience. Rust is a bonus skill.';
    assert.equal(findYearsWithForeignStack(text, ALL_STACKS), null);
  });
});

// ─── parseSections ────────────────────────────────────────────────────────────

describe('parseSections', () => {
  it('text with no headings → all goes to requirements', () => {
    const desc = 'We need Node.js and TypeScript skills.';
    const s = parseSections(desc);
    assert.ok(s.requirements.includes('Node.js'));
    assert.equal(s.niceTohave, '');
  });

  it('splits on "## Requirements" / "## Nice to have"', () => {
    const desc = [
      '## Requirements',
      '- Node.js 18+',
      '- TypeScript',
      '## Nice to have',
      '- Go',
      '- Rust',
    ].join('\n');
    const s = parseSections(desc);
    assert.ok(s.requirements.includes('Node.js'));
    assert.ok(s.niceTohave.includes('Go'));
    assert.ok(!s.requirements.includes('Rust'));
  });

  it('"Nice to have: Go" then "Tech Stack: Rust, Tokio" → Rust in requirements', () => {
    const desc = [
      '## What we need',
      '- Node.js',
      'Nice to have: Go',
      'Tech Stack: Rust, Tokio',
    ].join('\n');
    const s = parseSections(desc);
    assert.ok(s.niceTohave.includes('Go'), 'Go should be in niceTohave');
    assert.ok(s.requirements.includes('Rust'), 'Rust should be in requirements');
  });

  it('unknown heading (What we offer) resets to requirements', () => {
    const desc = [
      '## Nice to have',
      '- Go',
      '## What we offer',
      '- Competitive salary',
    ].join('\n');
    const s = parseSections(desc);
    assert.ok(s.niceTohave.includes('Go'));
    assert.ok(s.requirements.includes('Competitive salary'));
  });

  it('generic short colon heading resets to requirements from niceTohave', () => {
    const desc = [
      'Nice to have:',
      '- Go',
      'Responsibilities:',
      '- Build Node.js services',
    ].join('\n');
    const s = parseSections(desc);
    assert.ok(s.niceTohave.includes('Go'));
    assert.ok(s.requirements.includes('Node.js'));
  });
});

// ─── checkForeignStackFilter – spec test cases ────────────────────────────────

describe('checkForeignStackFilter – spec cases', () => {
  it('case 1: "Senior Full Stack (Rust) Engineer" + requirements "5+ years of commercial Rust" → blocked', () => {
    const title = 'Senior Full Stack (Rust) Engineer';
    const desc  = '## Requirements\n5+ years of commercial Rust experience building production applications';
    const r = checkForeignStackFilter(title, desc, 'fullstack', ALL_STACKS, PENALTY, true);
    assert.ok(r.blocked, `expected blocked, got reason=${r.reason}`);
  });

  it('case 2: "Senior Backend Engineer", Node+TS in requirements, Go in nice-to-have → not blocked, no penalty', () => {
    const title = 'Senior Backend Engineer';
    const desc  = [
      '## Requirements',
      '- Node.js',
      '- TypeScript',
      '## Nice to have',
      '- Go',
    ].join('\n');
    const r = checkForeignStackFilter(title, desc, 'backend', ALL_STACKS, PENALTY, true);
    assert.ok(!r.blocked);
    assert.equal(r.penalty, 0);
  });

  it('case 3: "Backend Engineer (Node.js / Go)" → not blocked, penalty', () => {
    const r = checkForeignStackFilter(
      'Backend Engineer (Node.js / Go)', '', 'backend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(!r.blocked);
    assert.equal(r.penalty, PENALTY);
  });

  it('case 4: "Senior Backend Engineer — PHP / Node.js / AWS" → not blocked, penalty', () => {
    const r = checkForeignStackFilter(
      'Senior Backend Engineer — PHP / Node.js / AWS', '', 'backend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(!r.blocked);
    assert.equal(r.penalty, PENALTY);
  });

  it('case 5a: "Senior Java Developer" → blocked (title:java)', () => {
    const r = checkForeignStackFilter(
      'Senior Java Developer', '', 'backend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(r.blocked);
    assert.ok(r.reason?.startsWith('title:'));
  });

  it('case 5b: "Senior JavaScript Developer" → not blocked', () => {
    const r = checkForeignStackFilter(
      'Senior JavaScript Developer', '', 'backend', ALL_STACKS, PENALTY, false,
    );
    assert.ok(!r.blocked);
  });

  it('case 6: "Good communication skills, MongoDB, Django" → no Go match', () => {
    const r = checkForeignStackFilter(
      'Backend Engineer', 'Good communication skills, MongoDB, Django', 'backend', ALL_STACKS, PENALTY, false,
    );
    assert.ok(!r.blocked);
    assert.equal(r.penalty, 0);
  });
});

describe('checkForeignStackFilter – additional cases', () => {
  it('"Senior Python Backend Engineer (FastAPI)" → not blocked (Python is own stack)', () => {
    const desc = '## Requirements\n- Python 3.11\n- FastAPI\n- PostgreSQL';
    const r = checkForeignStackFilter(
      'Senior Python Backend Engineer (FastAPI)', desc, 'backend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(!r.blocked, `expected not blocked, got reason=${r.reason}`);
  });

  it('"React Native Developer", requirements "React Native, iOS, Android" → not blocked', () => {
    const desc = '## Requirements\n- React Native\n- iOS\n- Android';
    const r = checkForeignStackFilter(
      'React Native Developer', desc, 'frontend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(!r.blocked, `expected not blocked, got reason=${r.reason}`);
  });

  it('"Senior Android Developer" → blocked (title:android)', () => {
    const r = checkForeignStackFilter(
      'Senior Android Developer', '', 'other', ALL_STACKS, PENALTY, true,
    );
    assert.ok(r.blocked);
    assert.equal(r.reason, 'title:android');
  });

  it('no-node rule: "Senior Backend Engineer", no own stack anywhere → blocked (no-node)', () => {
    const desc = '## Requirements\n- 5 years experience\n- REST APIs\n- PostgreSQL';
    const r = checkForeignStackFilter(
      'Senior Backend Engineer', desc, 'backend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(r.blocked);
    assert.equal(r.reason, 'no-node');
  });

  it('no-node rule: skipped for llm-pure category', () => {
    const desc = '## Requirements\n- LLM pipelines\n- RAG\n- Python';
    const r = checkForeignStackFilter(
      'AI/LLM Engineer', desc, 'llm-pure', ALL_STACKS, PENALTY, true,
    );
    // Python is own stack, so even if requireNodeInStack=true, no-node won't fire
    // (hasOwnStack finds Python in requirements)
    assert.ok(!r.blocked);
  });

  it('foreign stack only in nice-to-have → not blocked, no penalty', () => {
    const desc = [
      '## Requirements',
      '- Node.js, TypeScript',
      '## Nice to have',
      '- Rust experience',
    ].join('\n');
    const r = checkForeignStackFilter(
      'Senior Backend Engineer', desc, 'backend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(!r.blocked);
    assert.equal(r.penalty, 0);
  });

  it('foreign in requirements + own stack present → penalty not block', () => {
    const desc = '## Requirements\n- Node.js\n- Rust for performance-critical modules';
    const r = checkForeignStackFilter(
      'Backend Engineer', desc, 'backend', ALL_STACKS, PENALTY, true,
    );
    assert.ok(!r.blocked);
    assert.equal(r.penalty, PENALTY);
  });
});
