import { NormalizedContent } from '../types/backup';
import { FRAMEWORK_PATTERNS } from '../types/diff';
import { minify } from 'html-minifier-terser';

export class ContentNormalizer {
  private static readonly DEFAULT_PATTERNS = [
    {
      name: 'timestamps',
      pattern: /\b\d{4}-\d{2}-\d{2}\b/g,
      replacement: '[DATE]'
    },
    {
      name: 'times',
      pattern: /\b\d{2}:\d{2}:\d{2}\b/g,
      replacement: '[TIME]'
    },
    {
      name: 'unix_timestamps',
      pattern: /\b\d{10,13}\b/g,
      replacement: '[TIMESTAMP]'
    },
    {
      name: 'csrf_tokens',
      pattern: /csrf["\s]*[:=]["\s]*["']?[^"'\s]{8,}["']?/gi,
      replacement: 'csrf:"[CSRF_TOKEN]"'
    },
    {
      name: 'request_ids',
      pattern: /_requestid["\s]*[:=]["\s]*["']?[^"'\s]{8,}["']?/gi,
      replacement: '_requestid:"[REQUEST_ID]"'
    },
    {
      name: 'nonce',
      pattern: /nonce="[^"]*"/gi,
      replacement: 'nonce="[NONCE]"'
    },
    {
      name: 'data_testids',
      pattern: /data-testid="[^"]*"/g,
      replacement: ''
    },
    {
      name: 'data_cy',
      pattern: /data-cy="[^"]*"/g,
      replacement: ''
    },
    {
      name: 'session_ids',
      pattern: /session["\s]*[:=]["\s]*["']?[^"'\s]{16,}["']?/gi,
      replacement: 'session:"[SESSION]"'
    },
    {
      name: 'uuids',
      pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      replacement: '[UUID]'
    },
    {
      name: 'version_numbers',
      pattern: /\bv?\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?\b/g,
      replacement: '[VERSION]'
    },
    {
      name: 'build_numbers',
      pattern: /build["\s]*[:=]["\s]*["']?\d+["']?/gi,
      replacement: 'build:"[BUILD]"'
    }
  ];

  static async normalizeHTML(
    html: string,
    customPatterns?: Array<{ pattern: RegExp; replacement: string }>
  ): Promise<NormalizedContent> {
    const original = html;
    let normalized = html;

    try {
      normalized = await minify(normalized, {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        removeScriptTypeAttributes: true,
        removeStyleLinkTypeAttributes: true,
        useShortDoctype: true,
        removeEmptyAttributes: true,
        sortAttributes: true,
        sortClassName: false,
        removeAttributeQuotes: false,
        removeOptionalTags: false,
        removeEmptyElements: false,
        preserveLineBreaks: false,
        maxLineLength: undefined,
        continueOnParseError: true
      });
    } catch (error) {
      console.error('HTML minification failed, using original:', error);
      normalized = original;
    }

    normalized = this.applyDynamicPatterns(normalized);

    if (customPatterns) {
      normalized = this.applyCustomPatterns(normalized, customPatterns);
    }

    normalized = this.cleanupWhitespace(normalized);

    const hash = await this.calculateHash(normalized);
    const extractionDate = new Date().toISOString();

    return {
      original,
      normalized,
      hash,
      extractionDate
    };
  }

  static async normalizeJSON(json: string): Promise<NormalizedContent> {
    const original = json;
    let normalized = json;

    try {
      const parsed = JSON.parse(json);
      this.normalizeJSONObject(parsed);
      normalized = JSON.stringify(parsed, Object.keys(parsed).sort());
    } catch (error) {
      console.error('JSON parsing failed, treating as text:', error);
      const textResult = await this.normalizeText(json);
      normalized = textResult.normalized;
    }

    const hash = await this.calculateHash(normalized);
    const extractionDate = new Date().toISOString();

    return {
      original,
      normalized,
      hash,
      extractionDate
    };
  }

  static async normalizeText(text: string): Promise<NormalizedContent> {
    const original = text;
    let normalized = text;

    normalized = this.applyDynamicPatterns(normalized);
    normalized = this.cleanupWhitespace(normalized);

    const hash = await this.calculateHash(normalized);
    const extractionDate = new Date().toISOString();

    return {
      original,
      normalized,
      hash,
      extractionDate
    };
  }

  private static applyDynamicPatterns(content: string): string {
    let normalized = content;

    for (const patternObj of this.DEFAULT_PATTERNS) {
      try {
        normalized = normalized.replace(patternObj.pattern, patternObj.replacement);
      } catch (error) {
        console.error(`Failed to apply pattern ${patternObj.name}:`, error);
      }
    }

    return normalized;
  }

  private static applyCustomPatterns(
    content: string,
    patterns: Array<{ pattern: RegExp; replacement: string }>
  ): string {
    let normalized = content;

    for (const { pattern, replacement } of patterns) {
      try {
        normalized = normalized.replace(pattern, replacement);
      } catch (error) {
        console.error('Failed to apply custom pattern:', error);
      }
    }

    return normalized;
  }

  private static normalizeJSONObject(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(this.normalizeJSONObject.bind(this));
    }

    if (obj !== null && typeof obj === 'object') {
      const normalized: any = {};
      
      for (const [key, value] of Object.entries(obj)) {
        if (typeof key === 'string' && this.isDynamicKey(key)) {
          continue;
        }

        if (typeof value === 'string' && this.isDynamicValue(value)) {
          normalized[key] = '[DYNAMIC_VALUE]';
        } else if (typeof value === 'object' && value !== null) {
          normalized[key] = this.normalizeJSONObject(value);
        } else {
          normalized[key] = value;
        }
      }

      return normalized;
    }

    return obj;
  }

  private static isDynamicKey(key: string): boolean {
    const dynamicPatterns = [
      /csrf/i,
      /token/i,
      /nonce/i,
      /session/i,
      /timestamp/i,
      /request_id/i,
      /requestid/i,
      /build/i,
      /version/i,
      /_id$/i,
      /uuid/i
    ];

    return dynamicPatterns.some(pattern => pattern.test(key));
  }

  private static isDynamicValue(value: string): boolean {
    const dynamicPatterns = [
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      /^\d{10,13}$/,
      /^[a-zA-Z0-9]{20,}$/,
      /^[a-f0-9]{32}$/i,
      /^[a-f0-9]{40}$/i,
      /^[a-f0-9]{64}$/i
    ];

    return dynamicPatterns.some(pattern => pattern.test(value));
  }

  private static cleanupWhitespace(content: string): string {
    return content
      .replace(/\s+/g, ' ')
      .replace(/> </g, '><')
      .replace(/\s*([{}[\](),;:])\s*/g, '$1')
      .trim();
  }

  private static async calculateHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  static detectContentType(content: string): 'html' | 'json' | 'text' {
    const trimmed = content.trim().toLowerCase();

    if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
      return 'html';
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(content);
        return 'json';
      } catch {
        return 'text';
      }
    }

    if (trimmed.includes('<html') || trimmed.includes('<body') || trimmed.includes('<div')) {
      return 'html';
    }

    return 'text';
  }

  static async autoNormalize(content: string): Promise<NormalizedContent> {
    const contentType = this.detectContentType(content);

    switch (contentType) {
      case 'html':
        return this.normalizeHTML(content);
      case 'json':
        return this.normalizeJSON(content);
      default:
        return this.normalizeText(content);
    }
  }

  static createCustomPattern(
    name: string,
    regex: string,
    replacement: string
  ): { name: string; pattern: RegExp; replacement: string } {
    return {
      name,
      pattern: new RegExp(regex, 'gi'),
      replacement
    };
  }

  static getBuiltInPatterns(): Array<{ name: string; pattern: string; description: string }> {
    return this.DEFAULT_PATTERNS.map(p => ({
      name: p.name,
      pattern: p.pattern.source,
      description: `Replaces ${p.name} with placeholder`
    }));
  }

  static detectFramework(html: string): string[] {
    const detected: string[] = [];

    for (const [name, framework] of Object.entries(FRAMEWORK_PATTERNS)) {
      for (const pattern of framework.patterns) {
        if (html.includes(pattern.selector)) {
          detected.push(name);
          break;
        }
      }
    }

    return detected;
  }

  static async normalizeWithFramework(
    html: string,
    frameworks: string[] = []
  ): Promise<NormalizedContent> {
    const original = html;
    let normalized = html;

    try {
      normalized = await minify(normalized, {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        removeScriptTypeAttributes: true,
        removeStyleLinkTypeAttributes: true,
        useShortDoctype: true,
        removeEmptyAttributes: true,
        sortAttributes: true,
        sortClassName: false,
        removeAttributeQuotes: false,
        removeOptionalTags: false,
        removeEmptyElements: false,
        preserveLineBreaks: false,
        maxLineLength: undefined,
        continueOnParseError: true
      });
    } catch (error) {
      console.error('HTML minification failed, using original:', error);
      normalized = original;
    }

    normalized = this.applyDynamicPatterns(normalized);

    for (const framework of frameworks) {
      const frameworkPattern = FRAMEWORK_PATTERNS[framework];
      if (frameworkPattern) {
        normalized = this.applyFrameworkPatterns(normalized, frameworkPattern);
      }
    }

    normalized = this.cleanupWhitespace(normalized);

    const hash = await this.calculateHash(normalized);
    const extractionDate = new Date().toISOString();

    return {
      original,
      normalized,
      hash,
      extractionDate
    };
  }

  private static applyFrameworkPatterns(
    content: string,
    framework: typeof FRAMEWORK_PATTERNS[keyof typeof FRAMEWORK_PATTERNS]
  ): string {
    let normalized = content;

    for (const patternStr of framework.ignorePatterns) {
      try {
        const pattern = new RegExp(patternStr, 'gi');
        normalized = normalized.replace(pattern, '[FRAMEWORK_DYNAMIC]');
      } catch (error) {
        console.error(`Failed to apply framework pattern:`, error);
      }
    }

    return normalized;
  }

  static getFrameworkPatterns(frameworkName: string): typeof FRAMEWORK_PATTERNS[keyof typeof FRAMEWORK_PATTERNS] | null {
    return FRAMEWORK_PATTERNS[frameworkName] || null;
  }

  static async autoDetectAndNormalize(html: string): Promise<NormalizedContent> {
    const frameworks = this.detectFramework(html);
    console.log(`Detected frameworks: ${frameworks.join(', ') || 'none'}`);

    if (frameworks.length > 0) {
      return this.normalizeWithFramework(html, frameworks);
    }

    return this.autoNormalize(html);
  }
}