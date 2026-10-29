import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';

process.env.SCRAPER_NO_MAIN = '1';
const { parseDjinniSidebar, extractMeta, isRemoteText } = await import('./scrape-jobs.js');
const { checkCountries } = await import('./watch-filter.js');

// Sidebars cut from real Djinni vacancy pages (2026-10-29).
const side = (name: string) => parseDjinniSidebar(cheerio.load(readFileSync(`test-data/djinni-aside-${name}.html`, 'utf8')));

describe('parseDjinniSidebar', () => {
  it('Full Remote, Poland only', () => {
    assert.deepEqual(side('poland'), { remote: true, countries: 'Poland' });
  });
  it('Hybrid Remote is not remote', () => {
    assert.deepEqual(side('hybrid-ukraine'), { remote: false, countries: 'Ukraine' });
  });
  it('Full Remote, Europe or Ukraine', () => {
    assert.deepEqual(side('europe-or-ukraine'), { remote: true, countries: 'Countries of Europe or Ukraine' });
  });
  it('no aside: nothing known', () => {
    assert.deepEqual(parseDjinniSidebar(cheerio.load('<main>x</main>')), { remote: null, countries: null });
  });
});

describe('hybrid is not remote', () => {
  it('isRemoteText', () => {
    assert.equal(isRemoteText('Full Remote'), true);
    assert.equal(isRemoteText('Hybrid Remote'), false);
    assert.equal(isRemoteText('Office'), false);
  });
  it('card meta line', () => {
    assert.equal(extractMeta('Hybrid Remote · 4 years of experience · English - B2').remote, null);
    assert.equal(extractMeta('Full Remote · 4 years of experience · English - B2').remote, true);
  });
});

describe('checkCountries', () => {
  it('blocks Poland only', () => assert.equal(checkCountries('Poland'), 'country:Poland'));
  it('blocks several other countries', () => assert.equal(checkCountries('Poland, Germany'), 'country:Poland, Germany'));
  it('keeps Ukraine', () => assert.equal(checkCountries('Ukraine'), null));
  it('keeps Europe or Ukraine', () => assert.equal(checkCountries('Countries of Europe or Ukraine'), null));
  it('keeps Poland and Ukraine', () => assert.equal(checkCountries('Poland, Ukraine'), null));
  it('keeps Ukrainian text', () => assert.equal(checkCountries('Україна'), null));
  it('unknown never blocks', () => {
    assert.equal(checkCountries(null), null);
    assert.equal(checkCountries(''), null);
  });
});
