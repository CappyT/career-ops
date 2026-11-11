#!/usr/bin/env node
/**
 * linkedin-jobs.mjs — LinkedIn job scanner as a career-ops local parser.
 *
 * Scans LinkedIn's guest job search (no account, no API key, zero LLM tokens)
 * and prints the jobs-json-v1 contract to stdout (docs/local-parser-cookbook.md):
 * clean JSON on stdout, every log line on stderr. Zero dependencies beyond
 * Node's stdlib (>=18, global fetch).
 *
 * Sources, in order:
 *   1. Guest search fragment
 *      https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?...
 *      (the same endpoint the logged-out www.linkedin.com/jobs page paginates
 *      with; returns <li> cards with a `datetime` posting date attribute).
 *   2. Optional --details: one guest detail page per job,
 *      https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>, whose
 *      JSON-LD `JobPosting` block carries an exact `datePosted` (ISO).
 *
 * Rate limits: the guest endpoint answers 429 after a handful of rapid hits.
 * Every page request is throttled (default 2500 ms + jitter) and 429/5xx are
 * retried with backoff; three consecutive 429 pages stop the scan. Partial
 * results are still emitted. An li_at cookie raises the ceiling when guest
 * access degrades: pass it via --cookie or the LINKEDIN_COOKIE environment
 * variable (raw Cookie header, used verbatim, never printed).
 *
 * Usage (standalone):
 *   node scripts/parsers/linkedin-jobs.mjs --keywords "backend engineer" --location "Rome, Italy"
 *   node scripts/parsers/linkedin-jobs.mjs --keywords "rust" --posted-window 1w --pages 2
 *   node scripts/parsers/linkedin-jobs.mjs --url "{careers_url}"     # portals.yml expansion
 *
 * Usage (portals.yml, user layer — see docs/local-parser-cookbook.md):
 *   - name: LinkedIn — Backend Italy
 *     careers_url: https://www.linkedin.com/jobs/search?keywords=backend&location=Italy
 *     scan_method: local_parser
 *     parser:
 *       command: node
 *       script: scripts/parsers/linkedin-jobs.mjs
 *       args: ["--url", "{careers_url}", "--pages", "2"]
 *       format: jobs-json-v1
 *     enabled: true
 *
 * Exit codes: 0 with jobs (even partial), 1 on hard failure with zero jobs,
 * 2 on bad usage.
 */

import { isMainModule } from '../../lib/is-main-module.mjs';

const GUEST_SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const GUEST_DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const PAGE_SIZE = 25; // the guest fragment returns 25 cards per `start` step
const HARD_PAGE_CAP = 40; // sanity ceiling: 40 pages ≈ 1000 jobs

const USAGE = `Usage:
  node scripts/parsers/linkedin-jobs.mjs [options]

Query (either form; --url wins when both are given):
  --url <url>              full LinkedIn guest search URL (supports the
                           {careers_url} portals.yml expansion)
  --keywords <text>        free-text keywords (param keywords)
  --location <text>        location text (param location)
  --geo <id>               LinkedIn geoId (param geoId, more precise than
                           --location)

Filters (query params passed through to LinkedIn):
  --posted-window <1d|1w|1m>   f_TPR posted-age window (r86400/r604800/r2592000)
  --workplace <list>           f_WT: onsite, remote, hybrid (comma-combinable)
  --experience <list>          f_E: internship, entry, associate, mid, senior,
                               director (comma-combinable)
  --easy-apply                 f_AL=true

Paging and volume:
  --pages <n>              how many 25-card pages to scan (default 1, cap 40)
  --start <n>              first offset (default 0)
  --limit <n>              stop after n jobs overall
  --max-age-days <n>       drop postings older than n days (a posting with no
                           known date always passes, like the scan filters)

Fetch behaviour:
  --details                one guest detail request per job for the exact
                           JSON-LD datePosted (slower, rate-limit friendly)
  --throttle-ms <n>        base delay between requests, +0-1000 ms jitter
                           (default 2500)
  --cookie <header>        raw Cookie header (li_at raises the rate ceiling);
                           LINKEDIN_COOKIE environment variable also works
  --ua <string>            override the default Chrome User-Agent

Output:
  --pretty                 indented JSON (stdout stays the jobs-json-v1
                           contract either way; --pretty is for eyeballing)
  --verbose                per-job stderr progress lines

  -h, --help               this usage block`;

const USAGE_EXIT = 2;

// ---------- CLI parsing ----------

function parseArgs(argv) {
  const opts = {
    url: '', keywords: '', location: '', geo: '',
    postedWindow: '', workplace: [], experience: [], easyApply: false,
    pages: 1, start: 0, limit: 0, maxAgeDays: 0,
    details: false, throttleMs: 2500, cookie: process.env.LINKEDIN_COOKIE || '',
    ua: DEFAULT_UA, pretty: false, verbose: false,
  };
  const take = (i, flag) => {
    if (i + 1 >= argv.length) {
      console.error(`linkedin-jobs: ${flag} needs a value`);
      process.exit(USAGE_EXIT);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--url': opts.url = take(i++, a); break;
      case '--keywords': opts.keywords = take(i++, a); break;
      case '--location': opts.location = take(i++, a); break;
      case '--geo': opts.geo = take(i++, a); break;
      case '--posted-window': opts.postedWindow = take(i++, a); break;
      case '--workplace': opts.workplace = splitList(take(i++, a), WORKPLACE_ALIASES); break;
      case '--experience': opts.experience = splitList(take(i++, a), EXPERIENCE_ALIASES); break;
      case '--easy-apply': opts.easyApply = true; break;
      case '--pages': opts.pages = intOf(take(i++, a), '--pages'); break;
      case '--start': opts.start = intOf(take(i++, a), '--start'); break;
      case '--limit': opts.limit = intOf(take(i++, a), '--limit'); break;
      case '--max-age-days': opts.maxAgeDays = intOf(take(i++, a), '--max-age-days'); break;
      case '--details': opts.details = true; break;
      case '--throttle-ms': opts.throttleMs = intOf(take(i++, a), '--throttle-ms'); break;
      case '--cookie': opts.cookie = take(i++, a); break;
      case '--ua': opts.ua = take(i++, a); break;
      case '--pretty': opts.pretty = true; break;
      case '--verbose': opts.verbose = true; break;
      case '-h': case '--help':
        console.log(USAGE);
        process.exit(0);
      default:
        if (a.startsWith('--')) {
          console.error(`linkedin-jobs: unknown flag ${a}`);
          console.error(USAGE);
          process.exit(USAGE_EXIT);
        }
        console.error(`linkedin-jobs: unexpected positional argument ${a}`);
        process.exit(USAGE_EXIT);
    }
  }
  return opts;
}

const WORKPLACE_ALIASES = { onsite: '1', 'on-site': '1', remote: '2', hybrid: '3' };
const EXPERIENCE_ALIASES = {
  internship: '1', entry: '2', associate: '3', mid: '4', senior: '5', director: '6',
};
const POSTED_WINDOW_ALIASES = { '1d': 'r86400', '1w': 'r604800', '1m': 'r2592000' };

function splitList(value, aliases) {
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => {
      const mapped = aliases[s];
      if (mapped === undefined) {
        console.error(`linkedin-jobs: unknown list value "${s}" (want: ${Object.keys(aliases).join(', ')})`);
        process.exit(USAGE_EXIT);
      }
      return mapped;
    });
}

function intOf(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    console.error(`linkedin-jobs: ${flag} wants a non-negative integer, got "${value}"`);
    process.exit(USAGE_EXIT);
  }
  return n;
}

// ---------- URL building ----------

/**
 * Resolve the search URL: --url wins (portals.yml {careers_url} expansion may
 * already carry any LinkedIn params); otherwise build from flags. A bare
 * /jobs/search URL is rewritten to its guest fragment endpoint so paging
 * stays plain-HTML.
 */
export function buildSearchUrl(opts) {
  const base = opts.url || GUEST_SEARCH_URL;
  const u = new URL(base);
  if (opts.url && !/\/jobs(-guest)?\/(api\/seeMoreJobPostings\/)?search/.test(u.pathname)) {
    throw new Error(`--url is not a LinkedIn jobs search URL: ${base}`);
  }
  u.pathname = '/jobs-guest/jobs/api/seeMoreJobPostings/search';
  if (opts.url) {
    // flags stay additive on top of --url, so {careers_url} + --pages works
    if (opts.keywords && !u.searchParams.get('keywords')) u.searchParams.set('keywords', opts.keywords);
    if (opts.location && !u.searchParams.get('location')) u.searchParams.set('location', opts.location);
    if (opts.geo && !u.searchParams.get('geoId')) u.searchParams.set('geoId', opts.geo);
  } else {
    if (opts.keywords) u.searchParams.set('keywords', opts.keywords);
    if (opts.location) u.searchParams.set('location', opts.location);
    if (opts.geo) u.searchParams.set('geoId', opts.geo);
  }
  if (opts.postedWindow) {
    const tpr = POSTED_WINDOW_ALIASES[opts.postedWindow.toLowerCase()];
    if (!tpr) {
      throw new Error(`--posted-window wants 1d, 1w or 1m, got "${opts.postedWindow}"`);
    }
    u.searchParams.set('f_TPR', tpr);
  }
  if (opts.workplace.length) u.searchParams.set('f_WT', opts.workplace.join(','));
  if (opts.experience.length) u.searchParams.set('f_E', opts.experience.join(','));
  if (opts.easyApply) u.searchParams.set('f_AL', 'true');
  return u;
}

function withStart(searchUrl, start) {
  const u = new URL(searchUrl.href);
  u.searchParams.set('start', String(start));
  return u;
}

// ---------- HTML parsing (regex, zero deps) ----------

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function clean(s) {
  return decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse one guest search fragment into job rows. Fields come from the card
 * markup; `postedAt` from the card's `datetime` attribute when present,
 * else from the relative "x days ago" label, else undefined (the scanner
 * passes rows without a date through untouched).
 */
export function parseSearchFragment(html, { now = Date.now() } = {}) {
  const jobs = [];
  // The fragment is a flat <ul> of <li> cards; split on card boundaries so a
  // field from one card can never bleed into the next.
  const chunks = html.split(/<li\b/).slice(1);
  for (const chunk of chunks) {
    const href = chunk.match(/href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"]+)"/);
    const urn = chunk.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);
    if (!href && !urn) continue;
    // The href may be slug-prefixed (/jobs/view/title-123) or bare
    // (/jobs/view/123); the data-entity-urn, when present, is authoritative.
    const id = urn?.[1] ?? jobIdFromHref(href?.[1]);
    if (!id) continue;

    const title = clean(chunk.match(/base-search-card__title[^>]*>\s*([^<]+)</)?.[1]);
    const company = clean(
      chunk.match(/base-search-card__subtitle[^>]*>\s*(?:<a[^>]*>\s*)?([^<]+)</)?.[1],
    );
    const location = clean(chunk.match(/job-search-card__location[^>]*>\s*([^<]+)</)?.[1]);
    const datetime = chunk.match(/job-search-card__(?:listdate|new__listdate)[^>]*datetime="([^"]+)"/)?.[1];
    const relLabel = clean(chunk.match(/job-search-card__listdate[^>]*>([^<]+)</)?.[1]
      ?? chunk.match(/job-search-card__(?:listdate|new__listdate)[^>]*>[^<]*<[^>]*>\s*([^<]+)</)?.[1]);

    const postedAt = datetime
      ? toIsoDate(datetime, now)
      : relLabel
        ? toIsoDate(relativeToIso(relLabel, now), now)
        : undefined;

    jobs.push({
      title,
      url: href ? clean(href[1]) : `https://www.linkedin.com/jobs/view/${id}`,
      ...(company ? { company } : {}),
      ...(location ? { location } : {}),
      ...(postedAt ? { postedAt } : {}),
      jobId: id,
    });
  }
  return jobs;
}

/**
 * Pull the numeric posting id out of a /jobs/view URL, slug-prefixed or bare.
 * Returns undefined when the URL is neither form.
 */
export function jobIdFromHref(href) {
  if (!href) return undefined;
  return /\/jobs\/view\/(?:[^/?#]*-)?(\d+)(?:[?#]|$)/.exec(href)?.[1];
}

function toIsoDate(value, now) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  return new Date(Math.min(t, now)).toISOString().slice(0, 10);
}

/**
 * "2 days ago" / "3 hours ago" / "just now" / "30 minutes ago" / "2 weeks
 * ago" / "1 month ago" → an ISO date string. Unrecognised labels return null.
 */
export function relativeToIso(label, now = Date.now()) {
  const m = clean(label).match(/^(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago$/i);
  if (!m) {
    if (/^just\s+now$/i.test(clean(label))) return new Date(now).toISOString();
    return null;
  }
  const n = Number(m[1]);
  const unitMs = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()];
  return new Date(now - n * unitMs).toISOString();
}

/**
 * Pull the JSON-LD `JobPosting` block off a guest detail page: exact
 * `datePosted`, plus a sometimes-better company name.
 */
export function parseDetailJsonLd(html) {
  const m = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let ld;
  try {
    ld = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const blocks = Array.isArray(ld) ? ld : [ld];
  const posting = blocks.find((b) => b && (b['@type'] === 'JobPosting' || b['@graph']?.some?.((g) => g['@type'] === 'JobPosting')));
  const p = posting?.['@type'] === 'JobPosting' ? posting : posting?.['@graph']?.find((g) => g['@type'] === 'JobPosting');
  if (!p) return null;
  const org = typeof p.hiringOrganization === 'object' ? p.hiringOrganization?.name : p.hiringOrganization;
  return {
    ...(p.datePosted ? { datePosted: p.datePosted } : {}),
    ...(org ? { company: clean(org) } : {}),
    ...(p.title ? { title: clean(p.title) } : {}),
  };
}

// ---------- fetching ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(baseMs) {
  return baseMs + Math.floor(Math.random() * 1000);
}

async function fetchText(url, opts, label, maxRetries = 3) {
  const headers = {
    'User-Agent': opts.ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  let delay = Math.max(1500, opts.throttleMs);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, { headers, redirect: 'follow' });
    if (resp.ok) {
      const body = await resp.text();
      await sleep(jitter(opts.throttleMs));
      return body;
    }
    // 429 is LinkedIn's "slow down": back off and retry, both within a page
    // (attempt loop) and across pages (consecutive429 in the caller).
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt === maxRetries) {
        const err = new Error(`${label}: HTTP ${resp.status} after ${maxRetries + 1} attempts`);
        err.status = resp.status;
        throw err;
      }
      console.error(`linkedin-jobs: ${label}: HTTP ${resp.status}, backing off ${Math.round(delay)}ms`);
      await sleep(delay);
      delay = Math.round(delay * 1.5);
      continue;
    }
    const err = new Error(`${label}: HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  throw new Error(`${label}: unreachable`);
}

// ---------- scan ----------

/**
 * Run the full scan. Returns rows in the jobs-json-v1 shape (already
 * age-filtered and limited). Network failures on later pages degrade to
 * partial results with a stderr warning; a first-page failure throws.
 */
export async function scanLinkedInJobs(opts, { now = Date.now() } = {}) {
  const searchUrl = buildSearchUrl(opts);
  const pages = Math.min(Math.max(1, opts.pages), HARD_PAGE_CAP);
  const jobs = [];
  let consecutive429 = 0;

  for (let page = 0; page < pages; page++) {
    const start = opts.start + page * PAGE_SIZE;
    const pageUrl = withStart(searchUrl, start);
    let html;
    try {
      html = await fetchText(pageUrl, opts, `page ${page + 1} (start=${start})`);
      consecutive429 = 0;
    } catch (err) {
      if (err.status === 429) consecutive429++;
      if (jobs.length === 0) throw err;
      console.error(`linkedin-jobs: stopping after page ${page + 1}: ${err.message} (keeping ${jobs.length} jobs)`);
      break;
    }

    const rows = parseSearchFragment(html, { now });
    if (rows.length === 0) {
      console.error(`linkedin-jobs: page ${page + 1} returned no cards (end of results or wall)`);
      break;
    }
    for (const row of rows) {
      if (opts.maxAgeDays > 0 && row.postedAt) {
        const ageDays = Math.floor((now - Date.parse(row.postedAt)) / 864e5);
        if (ageDays > opts.maxAgeDays) continue;
      }
      if (opts.verbose) {
        console.error(`linkedin-jobs: + ${row.title}${row.company ? ` @ ${row.company}` : ''} (${row.postedAt ?? 'no date'})`);
      }
      jobs.push(row);
      if (opts.limit > 0 && jobs.length >= opts.limit) return jobs;
    }
  }
  return jobs;
}

/**
 * --details pass: one guest detail request per job to replace the card's
 * coarse posting date (and sometimes company) with the JSON-LD exact values.
 * Failures are non-fatal: the row keeps whatever the card had.
 */
export async function enrichWithDetails(jobs, opts) {
  for (const job of jobs) {
    try {
      const html = await fetchText(`${GUEST_DETAIL_URL}/${job.jobId}`, opts, `detail ${job.jobId}`);
      const ld = parseDetailJsonLd(html);
      if (!ld) continue;
      if (ld.datePosted) {
        const t = Date.parse(ld.datePosted);
        if (Number.isFinite(t)) job.postedAt = new Date(t).toISOString().slice(0, 10);
      }
      if (ld.company && !job.company) job.company = ld.company;
      if (ld.title && !job.title) job.title = ld.title;
    } catch (err) {
      console.error(`linkedin-jobs: detail ${job.jobId}: ${err.message} (keeping card data)`);
    }
  }
  return jobs;
}

// ---------- CLI tail ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url && !opts.keywords && !opts.location && !opts.geo) {
    console.error('linkedin-jobs: give --keywords/--location/--geo or --url');
    console.error(USAGE);
    process.exit(USAGE_EXIT);
  }

  const searchUrl = buildSearchUrl(opts);
  console.error(`linkedin-jobs: scanning ${searchUrl.searchParams.get('keywords') || searchUrl.searchParams.get('geoId') || '(url)'}`
    + ` pages=${Math.min(opts.pages, HARD_PAGE_CAP)} throttle=${opts.throttleMs}ms${opts.cookie ? ' cookie=on' : ' cookie=off'}`);

  const jobs = await scanLinkedInJobs(opts);
  const enriched = opts.details ? await enrichWithDetails(jobs, opts) : jobs;

  console.error(`linkedin-jobs: ${enriched.length} jobs`);
  process.stdout.write(JSON.stringify(enriched, null, opts.pretty ? 2 : 0) + '\n');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`linkedin-jobs: fatal: ${err.message}`);
    process.exit(1);
  });
}
