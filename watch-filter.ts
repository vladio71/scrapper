/**
 * watch-filter.ts
 *
 * Pure functions for the foreign-stack filter used by watch.ts.
 * No side effects, no I/O – safe to import in unit tests.
 *
 * Public API:
 *   categorize(vacancy)                                 → Category
 *   parseSections(description)                          → DescSections
 *   hasOwnStack(text)                                   → boolean
 *   findForeignStacks(text, enabledStacks)              → string[]
 *   findYearsWithForeignStack(text, enabledStacks)      → string | null
 *   checkForeignStackFilter(title, description,
 *     category, enabledStacks, penalty, requireOwn)    → FilterResult
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type Category = 'backend' | 'frontend' | 'fullstack' | 'llm-pure' | 'other';

/** The part of scraper Signals that categorize() looks at. */
export interface CategorySignals {
  languages: string[];
  frontend: string[];
  llm: string[];
}

/** Minimal vacancy shape for categorize(): a full scraper Vacancy satisfies it. */
export interface CategorizeInput {
  title: string;
  signals: CategorySignals;
}

export interface DescSections {
  requirements: string;
  niceTohave: string;
}

export interface FilterResult {
  blocked: boolean;
  reason?: string;
  /** Non-zero only when both own stack and foreign stack coexist (penalty, not a block). */
  penalty: number;
}

// ─── Classification ───────────────────────────────────────────────────────────
// Title is checked first; signals are the fallback when the title is neutral.
// 'other' = non-JS/TS, non-AI roles (annotators, analysts, Go, etc.), never sent.
// Shared by watch.ts (routing) and stack-stats.ts (backend + fullstack filter).
export function categorize(v: CategorizeInput): Category {
  const { languages: langs, frontend: feSignals, llm: llmSignals } = v.signals;
  const title = v.title;

  // ── Derived booleans ─────────────────────────────────────────────────────
  const titleFe    = /\bfrontend\b|\bfront-end\b|\breact\.?js?\b|\bangular\b|\bvue\.?js?\b|\bnext\.?js\b/i.test(title);
  const titleFs    = /full[\s-]?stack/i.test(title);
  const titleBe    = /\bbackend\b|\bback-end\b|\bnode\.?js\b|\bnest\.?js\b/i.test(title);
  const titleAI    = /\b(ai|ml|llm|genai|nlp)\b|machine learning/i.test(title);
  const titleJsTs  = /\bnode\.?js\b|\bnest\.?js\b|\btypescript\b|\bnext\.?js\b|\breact\.?js?\b/i.test(title);
  // Engineering role guard: llm-pure requires an engineering title.
  // Filters out growth managers, analysts, PMs and similar non-engineering titles.
  const isEngTitle = /\bengineer\b|\bdeveloper\b|\barchitect\b|\bml\b/i.test(title);

  // Signal booleans computed early so the Python-backend check can use them.
  const isJsTs = langs.includes('Node.js') || langs.includes('TypeScript');
  const hasFe  = feSignals.length > 0;
  const hasLlm = llmSignals.length > 0;

  // ── 1. Title-based routing ────────────────────────────────────────────────
  // Pure-frontend title (no backend / fullstack markers)
  if (titleFe && !titleBe && !titleFs)              return 'frontend';
  // Fullstack wins over any single-side title marker
  if (titleFs)                                       return 'fullstack';
  // Backend title: no JS/TS anywhere but LLM signals present = Python/other LLM backend, goes to digest
  if (titleBe && !titleFe) {
    if (!titleJsTs && !isJsTs && hasLlm)             return 'llm-pure';
    return 'backend';
  }
  // AI/LLM/ML title with no JS/TS: digest, but only for engineering roles
  if (titleAI && !titleJsTs && !titleBe && !titleFe) return isEngTitle ? 'llm-pure' : 'other';

  // ── 2. Signal fallback (title is neutral) ─────────────────────────────────
  if (hasLlm && !isJsTs) return isEngTitle ? 'llm-pure' : 'other';
  if (hasFe && isJsTs)   return 'fullstack';  // has both frontend + backend signals
  if (hasFe)             return 'frontend';
  if (isJsTs)            return 'backend';
  return 'other';
}

// ─── Own-stack detection ──────────────────────────────────────────────────────
// Covers: node (with or without .js / JS suffix), nest, typescript, javascript,
// react (incl. react native), next.js, express, python, fastapi, django.

// node / node.js / node js / NodeJS  |  nest / nest.js  |  ts / js  |  react / react native  |  next.js  |  express  |  python / fastapi / django
const OWN_STACK_RE =
  /\bnode(?:\.?\s*js|\s+js)?\b|\bnest(?:\.?js)?\b|\btypescript\b|\bjavascript\b|\breact(?:\s+native|\.?js?)?\b|\bnext\.?js\b|\bexpress(?:\.?js)?\b|\bpython\b|\bfastapi\b|\bdjango\b/i;

export function hasOwnStack(text: string): boolean {
  return OWN_STACK_RE.test(text);
}

// ─── Foreign stack patterns ───────────────────────────────────────────────────

/**
 * Go (case-sensitive): only when surrounded by list separators or tech role words.
 * Does NOT match "go-to", "go live", "on the go", "Go beyond", "good", "MongoDB", "Django".
 * DOES match "Node.js, Go, PostgreSQL" and "Go developer".
 */
const GO_RE =
  /(?:^|[,/|(;\s])\s*\bGo\b(?=\s*[,/|);]|\s+(?:developer|engineer|backend|services?|microservices?|language)\b|$)/m;

/** Returns true if "rails" appears NOT preceded by "guard" (handles "guardrails" / "guard rails"). */
function testRails(text: string): boolean {
  if (!/\brails\b/i.test(text)) return false;
  const re = /\brails\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Check up to 8 chars before the match for the word "guard"
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (!/guard/i.test(before)) return true;
  }
  return false;
}

type StackTestFn = (text: string) => boolean;

/** Map from stack name → test function. Defined once; O(1) lookup in findForeignStacks. */
const STACK_FN_MAP = new Map<string, StackTestFn>([
  ['rust',    (t) => /\brust\b/i.test(t)],
  ['golang',  (t) => /\bgolang\b/i.test(t)],
  ['go',      (t) => GO_RE.test(t)],
  ['java',    (t) => /\bjava\b(?!script)/i.test(t)],
  ['kotlin',  (t) => /\bkotlin\b/i.test(t)],
  ['scala',   (t) => /\bscala\b/i.test(t)],
  // .net: negative lookbehind prevents matching "company.net"
  ['dotnet',  (t) => /(?<![\w.])\.net\b|\bdotnet\b|\basp\.net\b/i.test(t)],
  // c#: word boundary on the right only (# is not a word char)
  ['csharp',  (t) => /\bc#(?!\w)/i.test(t)],
  ['php',     (t) => /\bphp\b/i.test(t)],
  ['ruby',    (t) => /\bruby\b/i.test(t)],
  ['rails',   testRails],
  // c++: word boundary on the right (+ is not a word char)
  ['cpp',     (t) => /\bc\+\+(?!\w)/i.test(t)],
  ['elixir',  (t) => /\belixir\b/i.test(t)],
  // Swift: case-sensitive — "Swift" (language) but not "SWIFT" (banking) or "swift" (adjective)
  ['Swift',   (t) => /\bSwift\b/.test(t)],
  // android / ios: only as a role, not as a platform mention
  ['android', (t) => /\bandroid\s+(?:developer|engineer)\b|native\s+android\b/i.test(t)],
  ['ios',     (t) => /\bios\s+(?:developer|engineer)\b/i.test(t)],
  ['flutter', (t) => /\bflutter\b/i.test(t)],
  ['dart',    (t) => /\bdart\b/i.test(t)],
]);

/**
 * Returns the names of all enabled stacks found in text.
 * @param enabledStacks – list from watch.config.json "foreignStacks"
 */
export function findForeignStacks(text: string, enabledStacks: string[]): string[] {
  const found: string[] = [];
  for (const name of enabledStacks) {
    const fn = STACK_FN_MAP.get(name);
    if (fn && fn(text)) found.push(name);
  }
  return found;
}

// ─── Years-of-experience check ────────────────────────────────────────────────

/**
 * Looks for "N+ years / N yrs / N років / від N років", then takes the rest of the
 * sentence (to `. ; \n`, max 80 chars total from the start of the match) and checks
 * for a foreign stack in that snippet.
 * If own stack is also present in the same snippet, this is NOT a block.
 * Returns the first blocking stack name, or null.
 */
export function findYearsWithForeignStack(text: string, enabledStacks: string[]): string | null {
  const yearsRe = /(?:\d+\+?\s*(?:years?|yrs?)|(?:від\s+)?\d+\+?\s*(?:рік|роки|років))/gi;
  let m: RegExpExecArray | null;
  while ((m = yearsRe.exec(text)) !== null) {
    const raw = text.slice(m.index, m.index + 80);
    const endM = raw.match(/[.;\n]/);
    const snippet = endM?.index != null ? raw.slice(0, endM.index) : raw;
    const found = findForeignStacks(snippet, enabledStacks);
    if (found.length === 0) continue;
    if (hasOwnStack(snippet)) continue; // own stack in same chunk → not a block
    return found[0];
  }
  return null;
}

// ─── Section parsing ──────────────────────────────────────────────────────────

type SectionKind = 'requirements' | 'niceTohave' | 'other';

// Known headings; sorted longest-first so "nice to have" is tested before "nice".
// Lower-case, no trailing colon.
const HEADING_LIST: Array<{ text: string; kind: SectionKind }> = ([
  // nice-to-have
  ['would be a plus',  'niceTohave'],
  ['will be a plus',   'niceTohave'],
  ['bonus points',     'niceTohave'],
  ['nice to have',     'niceTohave'],
  ['буде перевагою',   'niceTohave'],
  ['плюсом буде',      'niceTohave'],
  ['буде плюсом',      'niceTohave'],
  ['preferred',        'niceTohave'],
  ['бажано',           'niceTohave'],
  ['bonus',            'niceTohave'],
  // requirements
  ['what we are looking for', 'requirements'],
  ['необхідні навички',       'requirements'],
  ['your superpowers',        'requirements'],
  ['що ми очікуємо',          'requirements'],
  ['qualifications',          'requirements'],
  ['what we expect',          'requirements'],
  ['що потрібно',             'requirements'],
  ['must-have',               'requirements'],
  ['must have',               'requirements'],
  ['tech stack',              'requirements'],
  ['requirements',            'requirements'],
  ['вимоги',                  'requirements'],
  ['skills',                  'requirements'],
] as Array<[string, SectionKind]>)
  .map(([text, kind]) => ({ text, kind }))
  .sort((a, b) => b.text.length - a.text.length);

interface HeadingMatch {
  kind: SectionKind;
  /** Content on the same line after the heading keyword + colon, if any. */
  inlineContent: string;
}

/**
 * Returns heading metadata if `line` is a heading, or null otherwise.
 * Handles:
 *   - "## Heading" (from htmlToText)
 *   - "Known heading:" or "Known heading: inline content"
 *   - Generic short line ending with ":"
 *   - Short line followed by a list item (next line starts with "- " or "• ")
 */
function matchHeading(line: string, nextLine: string | undefined): HeadingMatch | null {
  const raw = line.startsWith('## ') ? line.slice(3).trim() : line.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // Check known headings (longest first)
  for (const { text, kind } of HEADING_LIST) {
    if (lower === text || lower === text + ':') {
      return { kind, inlineContent: '' };
    }
    if (lower.startsWith(text + ':')) {
      const inlineContent = raw.slice(text.length).replace(/^:\s*/, '').trim();
      return { kind, inlineContent };
    }
  }

  // Generic heading detection (only for lines that aren't already matched above).
  // List items (lines starting with "- " / "• ") are never headings.
  const isListItem = raw.startsWith('- ') || raw.startsWith('• ');
  const isShort = raw.length > 0 && raw.length <= 60;
  if (isShort && !isListItem) {
    if (raw.endsWith(':')) return { kind: 'other', inlineContent: '' };
    const nl = nextLine?.trimStart() ?? '';
    if (nl.startsWith('- ') || nl.startsWith('• ')) {
      return { kind: 'other', inlineContent: '' };
    }
  }

  // "## Heading" that didn't match any known set → still a heading (kind: other)
  if (line.startsWith('## ')) return { kind: 'other', inlineContent: '' };

  return null;
}

/**
 * Splits a vacancy description into "requirements" and "nice-to-have" sections.
 * Text before the first heading is treated as requirements.
 * Unknown headings (About us, Responsibilities, What we offer…) reset state to requirements.
 */
export function parseSections(description: string): DescSections {
  const lines = description.split('\n');
  let state: 'requirements' | 'niceTohave' = 'requirements';
  const reqLines: string[] = [];
  const nthLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = matchHeading(line, lines[i + 1]);

    if (heading !== null) {
      state = heading.kind === 'niceTohave' ? 'niceTohave' : 'requirements';
      if (heading.inlineContent) {
        (state === 'requirements' ? reqLines : nthLines).push(heading.inlineContent);
      }
      continue;
    }

    (state === 'requirements' ? reqLines : nthLines).push(line);
  }

  return {
    requirements: reqLines.join('\n').trim(),
    niceTohave:   nthLines.join('\n').trim(),
  };
}

// ─── Main filter ──────────────────────────────────────────────────────────────

/**
 * Checks whether a vacancy should be blocked or penalised due to a foreign tech stack.
 *
 * Rules (applied in order):
 *  4. Years pattern with foreign stack in same sentence → blocked "years:<stack>"
 *  2. Foreign stack in title, own stack absent         → blocked "title:<stack>"
 *     Foreign stack in title, own stack also present   → penalty
 *  3. Foreign stack in requirements, own stack absent  → blocked "required:<stack>"
 *     Foreign stack in requirements, own also present  → penalty
 *  5. backend/fullstack must have own stack in title or requirements → blocked "no-node"
 *     (skipped for llm-pure and frontend)
 *
 * @param category  Output of categorize() – 'backend' | 'frontend' | 'fullstack' | 'llm-pure' | 'other'
 */
export function checkForeignStackFilter(
  title: string,
  description: string,
  category: string,
  enabledStacks: string[],
  foreignStackPenalty: number,
  requireNodeInStack: boolean,
): FilterResult {
  const sections = parseSections(description);

  // Rule 4: years of experience with a foreign stack (search entire title + description)
  const yearsStack = findYearsWithForeignStack(`${title}\n${description}`, enabledStacks);
  if (yearsStack !== null) {
    return { blocked: true, reason: `years:${yearsStack}`, penalty: 0 };
  }

  // Rule 2: title analysis
  const titleForeign = findForeignStacks(title, enabledStacks);
  if (titleForeign.length > 0) {
    if (!hasOwnStack(title)) {
      return { blocked: true, reason: `title:${titleForeign[0]}`, penalty: 0 };
    }
    // Both stacks in title → soft penalty, not a block
    return { blocked: false, penalty: foreignStackPenalty };
  }

  // Rule 3: requirements section analysis
  const reqForeign = findForeignStacks(sections.requirements, enabledStacks);
  if (reqForeign.length > 0) {
    if (!hasOwnStack(sections.requirements) && !hasOwnStack(title)) {
      return { blocked: true, reason: `required:${reqForeign[0]}`, penalty: 0 };
    }
    return { blocked: false, penalty: foreignStackPenalty };
  }

  // Rule 3b: foreign stack only in nice-to-have → no action

  // Rule 5: backend / fullstack must have own stack somewhere visible
  if (requireNodeInStack && (category === 'backend' || category === 'fullstack')) {
    if (!hasOwnStack(title) && !hasOwnStack(sections.requirements)) {
      return { blocked: true, reason: 'no-node', penalty: 0 };
    }
  }

  return { blocked: false, penalty: 0 };
}

// ─── Remote / required-years gate ─────────────────────────────────────────────

export interface RemoteYearsInput {
  remote: boolean | null;
  experienceYears: number | null;
}

export interface RemoteYearsOptions {
  /** Block everything that is not explicitly remote (hybrid, office, unknown). */
  remoteOnly?: boolean;
  /** Block vacancies whose required years of experience exceed this number. */
  maxRequiredYears?: number | null;
}

/**
 * Returns a block reason or null.
 *   "not-remote"  – remoteOnly is on and the scraper did not see a remote marker
 *   "exp>N:M"     – vacancy asks for M years, limit is N
 * An unknown experienceYears (null) never blocks.
 */
export function checkRemoteAndYears(v: RemoteYearsInput, opts: RemoteYearsOptions): string | null {
  if (opts.remoteOnly && v.remote !== true) return 'not-remote';
  const max = opts.maxRequiredYears;
  if (max != null && v.experienceYears != null && v.experienceYears > max) {
    return `exp>${max}:${v.experienceYears}`;
  }
  return null;
}
