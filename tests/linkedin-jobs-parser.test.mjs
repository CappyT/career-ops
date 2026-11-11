// tests/linkedin-jobs-parser.test.mjs — offline contract tests for the
// LinkedIn guest search parser (scripts/parsers/linkedin-jobs.mjs):
// jobs-json-v1 fields, no cross-card field bleed, relative-date handling,
// detail JSON-LD extraction, and --url strictness. No network access.
// Run:  node --test tests/linkedin-jobs-parser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSearchFragment,
  parseDetailJsonLd,
  relativeToIso,
  buildSearchUrl,
} from '../scripts/parsers/linkedin-jobs.mjs';

// A two-card guest search fragment shaped like the real seeMoreJobPostings
// response: flat <ul> of <li> cards, base-search-card classes, a datetime
// attribute on the first card and a relative label on the second.
const FIXTURE = `<ul class="jobs-search__results-list">
<li>
  <div class="base-card">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/senior-backend-engineer-1000000001?position=1&pageNum=0">
      <span class="sr-only">Senior Backend Engineer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title"> Senior Backend Engineer </h3>
      <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme-corp">Acme Corp</a></h4>
      <span class="job-search-card__location">Rome, Lazio, Italy</span>
    </div>
    <time class="job-search-card__listdate" datetime="2026-09-25">2 weeks ago</time>
  </div>
</li>
<li>
  <div class="base-card">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/1000000002">
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title"> Sviluppatore back-end &amp; frontend </h3>
      <h4 class="base-search-card__subtitle">Example Srl</h4>
      <span class="job-search-card__location">Naples, Campania, Italy</span>
    </div>
    <time class="job-search-card__listdate--new" datetime="2026-10-01">just now</time>
  </div>
</li>
<li>
  <div class="base-card">
    <div>no link in this card, must be skipped</div>
  </div>
</li>
</ul>`;

test('parseSearchFragment extracts the jobs-json-v1 fields', () => {
  const jobs = parseSearchFragment(FIXTURE);
  assert.equal(jobs.length, 2, 'cards without a /jobs/view link are skipped');

  const [first, second] = jobs;
  assert.equal(first.title, 'Senior Backend Engineer');
  assert.equal(first.company, 'Acme Corp');
  assert.equal(first.location, 'Rome, Lazio, Italy');
  assert.equal(first.url, 'https://www.linkedin.com/jobs/view/senior-backend-engineer-1000000001?position=1&pageNum=0');
  assert.equal(first.jobId, '1000000001');
  assert.equal(first.postedAt, '2026-09-25', 'datetime attribute wins over the relative label');

  assert.equal(second.title, 'Sviluppatore back-end & frontend', 'entities are decoded');
  assert.equal(second.company, 'Example Srl');
  assert.equal(second.jobId, '1000000002');
  assert.equal(second.url, 'https://www.linkedin.com/jobs/view/1000000002', 'bare-view hrefs stay intact');
  assert.equal(second.postedAt, '2026-10-01');
});

test('parseSearchFragment falls back to the relative label for postedAt', () => {
  const html = `<li>
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/123456789"></a>
    <h3 class="base-search-card__title">Backend Engineer</h3>
    <time class="job-search-card__listdate">3 days ago</time>
  </li>`;
  const now = Date.parse('2026-10-05T12:00:00Z');
  const [job] = parseSearchFragment(html, { now });
  assert.equal(job.postedAt, '2026-10-02');
});

test('parseSearchFragment keeps rows without any date (scanner convention)', () => {
  const html = `<li>
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/987654321"></a>
    <h3 class="base-search-card__title">Backend Engineer</h3>
  </li>`;
  const [job] = parseSearchFragment(html);
  assert.ok('title' in job && 'url' in job, 'title and url are always present');
  assert.ok(!('postedAt' in job), 'no invented dates');
});

test('relativeToIso parses the guest labels', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(relativeToIso('2 days ago', now), '2026-10-03T12:00:00.000Z');
  assert.equal(relativeToIso('30 minutes ago', now), '2026-10-05T11:30:00.000Z');
  assert.equal(relativeToIso('just now', now), new Date(now).toISOString());
  assert.equal(relativeToIso('2 weeks ago', now), '2026-09-21T12:00:00.000Z');
  assert.equal(relativeToIso('sometime', now), null, 'unrecognised labels are null, not invented');
});

test('parseDetailJsonLd extracts the JobPosting block', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"schema.org","@type":"JobPosting","title":"Rust Engineer","datePosted":"2026-08-04","hiringOrganization":{"@type":"Organization","name":"Example Labs"}}</script>
  </head><body></body></html>`;
  const ld = parseDetailJsonLd(html);
  assert.deepEqual(ld, {
    title: 'Rust Engineer',
    datePosted: '2026-08-04',
    company: 'Example Labs',
  });
});

test('parseDetailJsonLd survives pages without JSON-LD', () => {
  assert.equal(parseDetailJsonLd('<html><body>authwall</body></html>'), null);
  assert.equal(parseDetailJsonLd('<script type="application/ld+json">not-json</script>'), null);
});

test('buildSearchUrl: flags become guest search params', () => {
  const url = buildSearchUrl({
    url: '', keywords: 'backend', location: 'Italy', geo: '', postedWindow: '1w',
    workplace: ['2', '3'], experience: ['4', '5'], easyApply: true,
  });
  assert.equal(url.pathname, '/jobs-guest/jobs/api/seeMoreJobPostings/search');
  assert.equal(url.searchParams.get('keywords'), 'backend');
  assert.equal(url.searchParams.get('location'), 'Italy');
  assert.equal(url.searchParams.get('f_TPR'), 'r604800');
  assert.equal(url.searchParams.get('f_WT'), '2,3');
  assert.equal(url.searchParams.get('f_E'), '4,5');
  assert.equal(url.searchParams.get('f_AL'), 'true');
});

test('buildSearchUrl: --url is rewritten to the guest fragment and keeps its params', () => {
  const url = buildSearchUrl({
    url: 'https://www.linkedin.com/jobs/search?keywords=rust&location=Europe&f_TPR=r2592000',
    keywords: '', location: '', geo: '', postedWindow: '', workplace: [], experience: [],
    easyApply: false,
  });
  assert.equal(url.pathname, '/jobs-guest/jobs/api/seeMoreJobPostings/search');
  assert.equal(url.searchParams.get('keywords'), 'rust');
  assert.equal(url.searchParams.get('location'), 'Europe');
  assert.equal(url.searchParams.get('f_TPR'), 'r2592000');
});

test('buildSearchUrl: --url flags are additive when the param is missing', () => {
  const url = buildSearchUrl({
    url: 'https://www.linkedin.com/jobs/search?keywords=rust',
    keywords: 'ignored-because-url-wins', location: 'Italy', geo: '', postedWindow: '',
    workplace: [], experience: [], easyApply: false,
  });
  assert.equal(url.searchParams.get('keywords'), 'rust', 'existing param untouched');
  assert.equal(url.searchParams.get('location'), 'Italy', 'missing param filled from flags');
});

test('buildSearchUrl rejects non-LinkedIn --url values', () => {
  assert.throws(
    () => buildSearchUrl({ url: 'https://example.com/jobs?keywords=x', keywords: '', location: '', geo: '', postedWindow: '', workplace: [], experience: [], easyApply: false }),
    /not a LinkedIn jobs search URL/,
  );
});
