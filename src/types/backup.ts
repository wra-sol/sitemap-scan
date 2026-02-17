export interface UrlEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapParseResult {
  urls: UrlEntry[];
  lastModified?: string;
  error?: string;
}

export interface FetchOptions {
  timeout: number;
  retries: number;
  headers?: Record<string, string>;
  followRedirects: boolean;
  maxRedirects: number;
}

export interface FetchResult {
  content: string;
  status: number;
  headers: Record<string, string>;
  url: string;
  finalUrl: string;
  redirectCount: number;
  fetchTime: number;
}

export interface ContentHash {
  url: string;
  hash: string;
  normalizedHash: string;
  size: number;
  timestamp: string;
}

export interface DiffComparison {
  url: string;
  previousContent?: string;
  currentContent: string;
  hasChanged: boolean;
  diffSummary: {
    linesAdded: number;
    linesRemoved: number;
    charsAdded: number;
    charsRemoved: number;
  };
}

export interface StorageKey {
  siteId: string;
  date: string;
  urlHash: string;
}

export interface NormalizedContent {
  original: string;
  normalized: string;
  hash: string;
  extractionDate: string;
}

export interface DiffResult {
  url: string;
  hasChanged: boolean;
  previousHash?: string;
  currentHash?: string;
  changeSize: number;
  changeType: 'content' | 'status' | 'metadata';
}