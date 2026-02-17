import { XMLParser } from 'fast-xml-parser';
import { UrlEntry, SitemapParseResult } from '../types/backup';

export class SitemapParser {
  static async parseSitemap(sitemapUrl: string): Promise<SitemapParseResult> {
    try {
      const response = await fetch(sitemapUrl, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'MultiSiteBackup/1.0 (Cloudflare Worker)',
          'Accept': 'application/xml,text/xml,*/*;q=0.9'
        }
      });

      if (!response.ok) {
        return {
          urls: [],
          error: `Sitemap fetch failed: ${response.status} ${response.statusText}`
        };
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('xml')) {
        return {
          urls: [],
          error: `Invalid content type: ${contentType}`
        };
      }

      const xmlText = await response.text();
      
      if (!xmlText.trim().startsWith('<?xml') && !xmlText.trim().startsWith('<urlset') && !xmlText.trim().startsWith('<sitemapindex')) {
        return {
          urls: [],
          error: 'Invalid XML format'
        };
      }

      const lastModified = response.headers.get('last-modified');

      if (xmlText.includes('<sitemapindex')) {
        return await this.parseSitemapIndex(xmlText, sitemapUrl);
      } else {
        return this.parseUrlSet(xmlText);
      }

    } catch (error) {
      return {
        urls: [],
        error: `Sitemap parsing error: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private static parseUrlSet(xmlText: string): SitemapParseResult {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '_text'
      });

      const result = parser.parse(xmlText);
      
      if (!result.urlset || !result.urlset.url) {
        return {
          urls: [],
          error: 'No URLs found in sitemap'
        };
      }

      const urlEntries = Array.isArray(result.urlset.url) 
        ? result.urlset.url 
        : [result.urlset.url];

      const urls: UrlEntry[] = urlEntries
        .filter((entry: any) => entry.loc)
        .map((entry: any) => ({
          loc: entry.loc.trim(),
          lastmod: entry.lastmod,
          changefreq: entry.changefreq,
          priority: entry.priority ? parseFloat(entry.priority) : undefined
        }));

      return {
        urls,
        lastModified: undefined
      };

    } catch (error) {
      return {
        urls: [],
        error: `URL set parsing error: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private static async parseSitemapIndex(xmlText: string, baseUrl: string): Promise<SitemapParseResult> {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '_text'
      });

      const result = parser.parse(xmlText);
      
      if (!result.sitemapindex || !result.sitemapindex.sitemap) {
        return {
          urls: [],
          error: 'No sitemaps found in sitemap index'
        };
      }

      const sitemapEntries = Array.isArray(result.sitemapindex.sitemap) 
        ? result.sitemapindex.sitemap 
        : [result.sitemapindex.sitemap];

      const allUrls: UrlEntry[] = [];
      const errors: string[] = [];

      for (const sitemapEntry of sitemapEntries) {
        if (sitemapEntry.loc) {
          try {
            const subSitemapResult = await this.parseSitemap(sitemapEntry.loc);
            if (subSitemapResult.error) {
              errors.push(`Failed to parse ${sitemapEntry.loc}: ${subSitemapResult.error}`);
            } else {
              allUrls.push(...subSitemapResult.urls);
            }
          } catch (error) {
            errors.push(`Error processing ${sitemapEntry.loc}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      if (errors.length > 0 && allUrls.length === 0) {
        return {
          urls: [],
          error: `All sub-sitemaps failed: ${errors.join('; ')}`
        };
      }

      return {
        urls: allUrls,
        error: errors.length > 0 ? `Partial success: ${errors.join('; ')}` : undefined
      };

    } catch (error) {
      return {
        urls: [],
        error: `Sitemap index parsing error: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  static async getAllUrlsFromSitemaps(sitemapUrl: string, maxDepth: number = 3): Promise<string[]> {
    if (maxDepth <= 0) {
      return [];
    }

    const result = await this.parseSitemap(sitemapUrl);
    
    if (result.error) {
      throw new Error(result.error);
    }

    const urls: string[] = [];
    
    for (const entry of result.urls) {
      if (entry.loc.includes('sitemap') && entry.loc.endsWith('.xml')) {
        try {
          const subUrls = await this.getAllUrlsFromSitemaps(entry.loc, maxDepth - 1);
          urls.push(...subUrls);
        } catch (error) {
          console.error(`Failed to process sub-sitemap ${entry.loc}:`, error instanceof Error ? error.message : String(error));
        }
      } else {
        urls.push(entry.loc);
      }
    }

    return [...new Set(urls)];
  }

  static filterUrlsByPattern(urls: string[], patterns: string[]): string[] {
    if (patterns.length === 0) {
      return urls;
    }

    return urls.filter(url => {
      return patterns.some(pattern => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(url);
      });
    });
  }

  static normalizeUrls(urls: string[], baseUrl?: string): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const url of urls) {
      try {
        const urlObj = new URL(url, baseUrl);
        
        urlObj.hash = '';
        
        const params = new URLSearchParams(urlObj.search);
        const sortedParams = new URLSearchParams();
        const keys = Array.from(params.keys()).sort();
        for (const key of keys) {
          sortedParams.set(key, params.get(key) || '');
        }
        urlObj.search = sortedParams.toString();
        
        urlObj.protocol = urlObj.protocol.toLowerCase();
        urlObj.hostname = urlObj.hostname.toLowerCase();
        
        const normalizedUrl = urlObj.toString();
        
        if (!seen.has(normalizedUrl)) {
          seen.add(normalizedUrl);
          normalized.push(normalizedUrl);
        }
      } catch (error) {
        console.error(`Failed to normalize URL ${url}:`, error);
      }
    }

    return normalized;
  }

  static validateUrls(urls: string[]): { valid: string[]; invalid: string[] } {
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const url of urls) {
      try {
        const urlObj = new URL(url);
        if (['http:', 'https:'].includes(urlObj.protocol)) {
          valid.push(url);
        } else {
          invalid.push(url);
        }
      } catch {
        invalid.push(url);
      }
    }

    return { valid, invalid };
  }
}