/**
 * Recursively scan a sitemap and POST links updated today (UTC) to an endpoint.
 * Runtime: Bun (ESM). Strict TypeScript.
 */

import { parseStringPromise } from "xml2js";
import fs from "node:fs";
import path from "node:path";

// Read from env if available (Bun loads .env automatically)
const SITEMAP_URL: string | undefined = Bun.env["SITEMAP_URL"];
const POST_ENDPOINT: string | undefined = Bun.env["POST_ENDPOINT"];
const CACHE_FILE: string = path.join(import.meta.dir, "last_sitemap.json");

/** Minimal shape of an xml2js-parsed sitemap response */
type Xml2JsValue<T> = T | undefined;

interface ParsedSitemapUrl {
  loc: [string];
  lastmod?: [string];
}

interface ParsedSitemapIndexEntry {
  loc: [string];
}

interface ParsedSitemapXml {
  urlset?: {
    url?: ParsedSitemapUrl[];
  };
  sitemapindex?: {
    sitemap?: ParsedSitemapIndexEntry[];
  };
}

export interface SitemapUrlEntry {
  loc: string;
  lastmod: string | null;
}

export interface FetchedUrlEntry extends SitemapUrlEntry {
  html: string | null;
}

function createAbortSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  // Ensure timer is cleared when signal is used
  controller.signal.addEventListener("abort", () => clearTimeout(id));
  return controller.signal;
}

async function fetchXML(url: string): Promise<ParsedSitemapXml> {
  const res = await fetch(url, { signal: createAbortSignal(15_000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const data = await res.text();
  const parsed = (await parseStringPromise(data)) as ParsedSitemapXml;
  return parsed;
}

async function getUrlsFromSitemap(url: string): Promise<SitemapUrlEntry[]> {
  const xml = await fetchXML(url);
  let urls: SitemapUrlEntry[] = [];

  const urlset = xml.urlset?.url ?? [];
  if (urlset.length > 0) {
    urls = urlset.map((u): SitemapUrlEntry => ({
      loc: u.loc[0],
      lastmod: u.lastmod ? u.lastmod[0] : null,
    }));
  } else {
    const indexEntries = xml.sitemapindex?.sitemap ?? [];
    for (const sm of indexEntries) {
      const childUrls = await getUrlsFromSitemap(sm.loc[0]);
      urls = urls.concat(childUrls);
    }
  }

  return urls;
}

function filterUpdatedToday(urls: ReadonlyArray<SitemapUrlEntry>): SitemapUrlEntry[] {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  return urls.filter((u) => Boolean(u.lastmod) && u.lastmod!.slice(0, 10) === today);
}

function diffUpdatedUrls(
  previousUrls: ReadonlyArray<SitemapUrlEntry>,
  latestUrls: ReadonlyArray<SitemapUrlEntry>
): SitemapUrlEntry[] {
  const previousLocToLastmod = new Map<string, string | null>(
    previousUrls.map((u) => [u.loc, u.lastmod])
  );
  return latestUrls.filter((u) => previousLocToLastmod.get(u.loc) !== u.lastmod);
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { signal: createAbortSignal(15_000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch page ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function fetchHtmlForUrls(
  urls: ReadonlyArray<SitemapUrlEntry>,
  concurrency: number = Number(Bun.env["FETCH_CONCURRENCY"] ?? 5)
): Promise<FetchedUrlEntry[]> {
  const queue = [...urls];
  const results: FetchedUrlEntry[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      try {
        const html = await fetchHtml(next.loc);
        results.push({ ...next, html });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to fetch HTML for ${next.loc}:`, message);
        results.push({ ...next, html: null });
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function sendToEndpoint(urls: ReadonlyArray<FetchedUrlEntry>): Promise<void> {
  try {
    if (!POST_ENDPOINT) {
      console.log("POST_ENDPOINT not set. Skipping POST step.");
      return;
    }
    const res = await fetch(POST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedUrls: urls }),
      signal: createAbortSignal(15_000),
    });

    if (!res.ok) {
      throw new Error(`Failed to POST: ${res.status} ${res.statusText}`);
    }

    console.log(`Posted ${urls.length} URLs to endpoint. Status: ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error posting to endpoint:", message);
  }
}

async function main(): Promise<void> {
  try {
    if (!SITEMAP_URL) {
      console.error("SITEMAP_URL not provided. Exiting with failure.");
      process.exitCode = 1;
      return;
    }
    console.log("Fetching sitemap...");
    const urls = await getUrlsFromSitemap(SITEMAP_URL);

    type CachedEntry = SitemapUrlEntry & { html?: string | null };
    let oldUrls: SitemapUrlEntry[] = [];
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          // Best-effort structural validation
          const valid = parsed.filter((u: any): u is CachedEntry =>
            typeof u?.loc === "string" && (typeof u?.lastmod === "string" || u?.lastmod === null)
          );
          oldUrls = valid.map((u) => ({ loc: u.loc, lastmod: u.lastmod }));
        }
      } catch {
        // If cache is corrupt, ignore it
        oldUrls = [];
      }
    }

    const updatedToday = filterUpdatedToday(urls);
    const changedToday = diffUpdatedUrls(oldUrls, updatedToday);

    let fetchedChanged: FetchedUrlEntry[] = [];
    if (changedToday.length > 0) {
      fetchedChanged = await fetchHtmlForUrls(changedToday);
      await sendToEndpoint(fetchedChanged);
    } else {
      console.log("No updates today.");
    }

    // Persist the current sitemap data, enriching entries we fetched with their HTML
    const htmlByLoc = new Map<string, string | null>(
      fetchedChanged.map((u) => [u.loc, u.html])
    );
    const toSave: FetchedUrlEntry[] = urls.map((u) => ({
      ...u,
      html: htmlByLoc.has(u.loc) ? htmlByLoc.get(u.loc)! : null,
    }));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error:", message);
    process.exitCode = 1;
  }
}

void main();


