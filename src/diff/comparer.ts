import { DiffResult, DiffComparison } from '../types/backup';
import { DetailedDiff, ChangeClassification, ContentChange, StyleChange, StructureChange } from '../types/diff';
import { minify } from 'html-minifier-terser';

export class ContentComparer {
  private static readonly IGNORE_PATTERNS = [
    // ISO-ish date/time
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{2}:\d{2}:\d{2}\b/g,
    /\b\d{4}-\d{2}-\d{2}[tT ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,

    // Common numeric date formats
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, // 02/22/2026, 2-22-26
    /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g, // 2026/02/22

    // Common human-readable dates
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*\d{1,2}(?:st|nd|rd|th)?(?:,\s*)?\s*\d{4}\b/gi,
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*\d{1,2}(?:st|nd|rd|th)?(?:,\s*)?\s*\d{4}\b/gi,
    /\b\d{1,2}(?:st|nd|rd|th)?\s*(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*\d{4}\b/gi,
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b\s*(?=\[REDACTED\])/gi,

    // Relative “calculated” timestamps often used in headers/footers
    /\b(?:last\s+updated|updated|published|posted|modified|generated)\s*[:\-–—]?\s*(?:today|yesterday|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\b/gi,

    /timestamp["\s]*[:=]["\s]*["']?\d+["']?/gi,
    /csrf["\s]*[:=]["\s]*["'][^"']+["']/gi,
    /_requestid["\s]*[:=]["\s]*["'][^"']+["']/gi,
    /data-testid="[^"]*"/g,
    /data-cy="[^"]*"/g,
    /nonce="[^"]*"/g,
    /style="[^"]*"/g,
    /class="[^"]*\s+(active|selected|current)\s*[^"]*"/gi,
    /\b\d{10,13}\b/g,
  ];

  static async compareContent(
    url: string,
    previousContent: string,
    currentContent: string,
    ignorePatterns?: string[]
  ): Promise<DiffResult> {
    const previousHash = await this.calculateNormalizedHash(previousContent, ignorePatterns);
    const currentHash = await this.calculateNormalizedHash(currentContent, ignorePatterns);

    const hasChanged = previousHash !== currentHash;
    const changeSize = Math.abs(currentContent.length - previousContent.length);

    let changeType: 'content' | 'status' | 'metadata' = 'content';
    if (!hasChanged) {
      changeType = 'metadata';
    }

    return {
      url,
      hasChanged,
      previousHash,
      currentHash,
      changeSize,
      changeType
    };
  }

  static async generateDiff(
    previousContent: string,
    currentContent: string
  ): Promise<DiffComparison> {
    const normalizedPrevious = await this.normalizeContent(previousContent);
    const normalizedCurrent = await this.normalizeContent(currentContent);

    const previousLines = normalizedPrevious.split('\n');
    const currentLines = normalizedCurrent.split('\n');

    const linesAdded = this.countAddedLines(previousLines, currentLines);
    const linesRemoved = this.countRemovedLines(previousLines, currentLines);
    const charsAdded = Math.max(0, normalizedCurrent.length - normalizedPrevious.length);
    const charsRemoved = Math.max(0, normalizedPrevious.length - normalizedCurrent.length);

    return {
      url: '',
      previousContent: normalizedPrevious,
      currentContent: normalizedCurrent,
      hasChanged: normalizedPrevious !== normalizedCurrent,
      diffSummary: {
        linesAdded,
        linesRemoved,
        charsAdded,
        charsRemoved
      }
    };
  }

  static async normalizeContent(content: string, ignorePatterns?: string[]): Promise<string> {
    let normalized = content;

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
        maxLineLength: undefined
      });
    } catch (error) {
      console.error('HTML minification failed:', error);
    }

    for (const pattern of this.IGNORE_PATTERNS) {
      normalized = normalized.replace(pattern, '[REDACTED]');
    }

    if (ignorePatterns) {
      for (const patternStr of ignorePatterns) {
        try {
          const pattern = new RegExp(patternStr, 'gi');
          normalized = normalized.replace(pattern, '[CUSTOM_IGNORE]');
        } catch (error) {
          console.error(`Invalid ignore pattern: ${patternStr}`, error);
        }
      }
    }

    normalized = normalized.replace(/\s+/g, ' ');
    normalized = normalized.replace(/> </g, '><');
    normalized = normalized.trim();

    return normalized;
  }

  static async calculateNormalizedHash(content: string, ignorePatterns?: string[]): Promise<string> {
    const normalized = await this.normalizeContent(content, ignorePatterns);
    return this.calculateHash(normalized);
  }

  static async calculateHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  static isSignificantChange(
    previousContent: string,
    currentContent: string,
    minChangeSize: number = 0
  ): boolean {
    const sizeDiff = Math.abs(currentContent.length - previousContent.length);
    return sizeDiff >= minChangeSize;
  }

  static extractTextContent(html: string): string {
    // Fallback text extraction for Cloudflare Workers environment
    const textContent = html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<!--[^>]*-->/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return textContent;
  }

  static generateSimpleDiff(text1: string, text2: string): string {
    const lines1 = text1.split('\n');
    const lines2 = text2.split('\n');
    const maxLines = Math.max(lines1.length, lines2.length);
    
    const diff: string[] = [];
    let changesCount = 0;
    const maxChanges = 10;

    for (let i = 0; i < maxLines && changesCount < maxChanges; i++) {
      const line1 = lines1[i] || '';
      const line2 = lines2[i] || '';

      if (line1 === line2) {
        diff.push(`  ${line2}`);
      } else {
        if (line1 && !line2) {
          diff.push(`- ${line1}`);
          changesCount++;
        } else if (!line1 && line2) {
          diff.push(`+ ${line2}`);
          changesCount++;
        } else {
          diff.push(`- ${line1}`);
          diff.push(`+ ${line2}`);
          changesCount++;
        }
      }
    }

    if (changesCount >= maxChanges) {
      diff.push('... (truncated)');
    }

    return diff.slice(0, 20).join('\n');
  }

  private static countAddedLines(previousLines: string[], currentLines: string[]): number {
    const set1 = new Set(previousLines);
    const set2 = new Set(currentLines);
    
    let addedCount = 0;
    for (const line of set2) {
      if (!set1.has(line)) {
        addedCount++;
      }
    }
    
    return addedCount;
  }

  private static countRemovedLines(previousLines: string[], currentLines: string[]): number {
    const set1 = new Set(previousLines);
    const set2 = new Set(currentLines);
    
    let removedCount = 0;
    for (const line of set1) {
      if (!set2.has(line)) {
        removedCount++;
      }
    }
    
    return removedCount;
  }

  static async compareBatch(
    comparisons: Array<{
      url: string;
      previousContent: string;
      currentContent: string;
      ignorePatterns?: string[];
    }>
  ): Promise<DiffResult[]> {
    const results: DiffResult[] = [];
    
    for (const comparison of comparisons) {
      const result = await this.compareContent(
        comparison.url,
        comparison.previousContent,
        comparison.currentContent,
        comparison.ignorePatterns
      );
      results.push(result);
    }
    
    return results;
  }

  static summarizeChanges(diffResults: DiffResult[]): {
    totalUrls: number;
    changedUrls: number;
    totalChanges: number;
    averageChangeSize: number;
    largestChange: { url: string; size: number } | null;
  } {
    const changedResults = diffResults.filter(result => result.hasChanged);
    const totalChanges = changedResults.reduce((sum, result) => sum + result.changeSize, 0);
    const averageChangeSize = changedResults.length > 0 ? totalChanges / changedResults.length : 0;
    
    let largestChange: { url: string; size: number } | null = null;
    for (const result of changedResults) {
      if (!largestChange || result.changeSize > largestChange.size) {
        largestChange = { url: result.url, size: result.changeSize };
      }
    }
    
    return {
      totalUrls: diffResults.length,
      changedUrls: changedResults.length,
      totalChanges,
      averageChangeSize,
      largestChange
    };
  }

  static async classifyChanges(
    url: string,
    previousContent: string,
    currentContent: string,
    previousHash: string,
    currentHash: string,
    date: string
  ): Promise<DetailedDiff> {
    const startTime = Date.now();
    const classification: ChangeClassification = {
      content: [],
      style: [],
      structure: []
    };

    // Use a more robust approach: extract specific content from HTML
    classification.content = this.detectTextContentChanges(previousContent, currentContent);
    classification.style = this.detectCSSChanges(previousContent, currentContent);
    classification.structure = this.detectTagChanges(previousContent, currentContent);

    const totalChanges = classification.content.length + classification.style.length + classification.structure.length;
    const highestPriority = this.calculateHighestPriority(classification);

    return {
      url,
      date,
      previousHash,
      currentHash,
      classification,
      summary: {
        totalChanges,
        contentChanges: classification.content.length,
        styleChanges: classification.style.length,
        structureChanges: classification.structure.length,
        highestPriority
      },
      metadata: {
        generatedAt: new Date().toISOString(),
        generationTime: Date.now() - startTime,
        isPartial: false
      }
    };
  }

  private static detectTextContentChanges(prev: string, curr: string): ContentChange[] {
    const changes: ContentChange[] = [];
    
    // Extract and compare specific important elements
    const importantTags = ['title', 'h1', 'h2', 'h3', 'p', 'meta[name="description"]', 'meta[name="twitter:description"]'];
    
    // Title comparison
    const prevTitle = this.extractTagContent(prev, 'title');
    const currTitle = this.extractTagContent(curr, 'title');
    if (prevTitle !== currTitle) {
      changes.push({
        type: 'content',
        priority: 5,
        element: 'title',
        position: { line: 1, column: 1 },
        change: prevTitle && currTitle ? 'modified' : (currTitle ? 'added' : 'removed'),
        before: prevTitle,
        after: currTitle,
        context: 'Page title'
      });
    }

    // H1 comparison
    const prevH1s = this.extractAllTagContents(prev, 'h1');
    const currH1s = this.extractAllTagContents(curr, 'h1');
    for (const h1 of prevH1s) {
      if (!currH1s.includes(h1)) {
        changes.push({
          type: 'content',
          priority: 4,
          element: 'h1',
          position: { line: 1, column: 1 },
          change: 'removed',
          before: h1,
          context: 'Main heading'
        });
      }
    }
    for (const h1 of currH1s) {
      if (!prevH1s.includes(h1)) {
        changes.push({
          type: 'content',
          priority: 4,
          element: 'h1',
          position: { line: 1, column: 1 },
          change: 'added',
          after: h1,
          context: 'Main heading'
        });
      }
    }

    // Meta description comparison
    const prevDesc = this.extractMetaContent(prev, 'description');
    const currDesc = this.extractMetaContent(curr, 'description');
    if (prevDesc !== currDesc) {
      changes.push({
        type: 'content',
        priority: 4,
        element: 'meta',
        position: { line: 1, column: 1 },
        change: prevDesc && currDesc ? 'modified' : (currDesc ? 'added' : 'removed'),
        before: prevDesc,
        after: currDesc,
        context: 'Meta description'
      });
    }

    // Twitter description comparison
    const prevTwitter = this.extractMetaContent(prev, 'twitter:description');
    const currTwitter = this.extractMetaContent(curr, 'twitter:description');
    if (prevTwitter !== currTwitter) {
      changes.push({
        type: 'content',
        priority: 3,
        element: 'meta',
        position: { line: 1, column: 1 },
        change: prevTwitter && currTwitter ? 'modified' : (currTwitter ? 'added' : 'removed'),
        before: prevTwitter,
        after: currTwitter,
        context: 'Twitter description'
      });
    }

    // Compare visible text content
    const prevText = this.extractTextContent(prev);
    const currText = this.extractTextContent(curr);
    if (prevText !== currText) {
      // Find specific text differences
      const prevWords = new Set(prevText.split(/\s+/).filter(w => w.length > 3));
      const currWords = new Set(currText.split(/\s+/).filter(w => w.length > 3));
      
      let addedWords = 0;
      let removedWords = 0;
      
      for (const word of currWords) {
        if (!prevWords.has(word)) addedWords++;
      }
      for (const word of prevWords) {
        if (!currWords.has(word)) removedWords++;
      }

      if (addedWords > 0 || removedWords > 0) {
        // Find the actual words that changed
        const addedWordsList: string[] = [];
        const removedWordsList: string[] = [];
        
        for (const word of currWords) {
          if (!prevWords.has(word)) addedWordsList.push(word);
        }
        for (const word of prevWords) {
          if (!currWords.has(word)) removedWordsList.push(word);
        }
        
        // Show up to 20 actual changed words
        const maxWords = 20;
        const addedDisplay = addedWordsList.slice(0, maxWords).join(', ') + (addedWordsList.length > maxWords ? '...' : '');
        const removedDisplay = removedWordsList.slice(0, maxWords).join(', ') + (removedWordsList.length > maxWords ? '...' : '');
        
        changes.push({
          type: 'content',
          priority: 3,
          element: 'body',
          position: { line: 1, column: 1 },
          change: 'modified',
          before: removedWordsList.length > 0 ? `Removed: ${removedDisplay}` : '(no words removed)',
          after: addedWordsList.length > 0 ? `Added: ${addedDisplay}` : '(no words added)',
          context: `Body text: ${addedWords} words added, ${removedWords} words removed`
        });
      }
    }

    return changes;
  }

  private static detectCSSChanges(prev: string, curr: string): StyleChange[] {
    const changes: StyleChange[] = [];
    
    // Extract style blocks
    const prevStyles = this.extractStyleBlocks(prev);
    const currStyles = this.extractStyleBlocks(curr);
    
    if (prevStyles.length !== currStyles.length) {
      changes.push({
        type: 'style',
        priority: 2,
        element: 'style',
        attribute: 'count',
        change: currStyles.length > prevStyles.length ? 'added' : 'removed',
        before: `${prevStyles.length} style blocks`,
        after: `${currStyles.length} style blocks`
      });
    }

    // Compare inline styles count
    const prevInlineCount = (prev.match(/style="/g) || []).length;
    const currInlineCount = (curr.match(/style="/g) || []).length;
    
    if (prevInlineCount !== currInlineCount) {
      changes.push({
        type: 'style',
        priority: 1,
        element: 'inline',
        attribute: 'style',
        change: 'modified',
        before: `${prevInlineCount} inline styles`,
        after: `${currInlineCount} inline styles`
      });
    }

    return changes;
  }

  private static detectTagChanges(prev: string, curr: string): StructureChange[] {
    const changes: StructureChange[] = [];
    
    // Count important structural elements
    const structuralTags = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form', 'iframe', 'script'];
    
    for (const tag of structuralTags) {
      const prevCount = (prev.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
      const currCount = (curr.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
      
      if (prevCount !== currCount) {
        changes.push({
          type: 'structure',
          priority: 2,
          element: tag,
          change: currCount > prevCount ? 'added' : 'removed'
        });
      }
    }

    // Check for link changes
    const prevLinks = (prev.match(/<a\s+[^>]*href="[^"]*"/gi) || []).length;
    const currLinks = (curr.match(/<a\s+[^>]*href="[^"]*"/gi) || []).length;
    
    if (prevLinks !== currLinks) {
      changes.push({
        type: 'structure',
        priority: 2,
        element: 'a',
        change: currLinks > prevLinks ? 'added' : 'removed'
      });
    }

    return changes;
  }

  private static extractTagContent(html: string, tag: string): string {
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
    const match = html.match(regex);
    return match ? match[1].trim() : '';
  }

  private static extractAllTagContents(html: string, tag: string): string[] {
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'gi');
    const matches: string[] = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (match[1].trim()) {
        matches.push(match[1].trim());
      }
    }
    return matches;
  }

  private static extractMetaContent(html: string, name: string): string {
    const regex = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
    const match = html.match(regex);
    if (match) return match[1];
    
    // Try alternate attribute order
    const altRegex = new RegExp(`<meta\\s+content="([^"]*)"\\s+name="${name}"`, 'i');
    const altMatch = html.match(altRegex);
    return altMatch ? altMatch[1] : '';
  }

  private static extractStyleBlocks(html: string): string[] {
    const regex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    const blocks: string[] = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
      blocks.push(match[1]);
    }
    return blocks;
  }

  private static parseHTML(html: string): HTMLElement[] {
    const elements: HTMLElement[] = [];
    const regex = /<([a-z][a-z0-9]*)([^>]*)>(.*?)<\/\1>|<([a-z][a-z0-9]*)([^>]*)\/?>/gis;
    let match;
    let position = 0;

    while ((match = regex.exec(html)) !== null) {
      const tag = match[1] || match[4];
      const attrs = match[2] || match[5];
      const content = match[3] || '';
      
      const lineBreaks = html.substring(0, match.index).split('\n');
      const line = lineBreaks.length;
      const column = lineBreaks[lineBreaks.length - 1].length + 1;

      elements.push({
        tag,
        attributes: this.parseAttributes(attrs || ''),
        content: content.trim(),
        position: { line, column }
      });

      position = match.index + match[0].length;
    }

    return elements;
  }

  private static parseAttributes(attrString: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const regex = /([a-z-]+)="([^"]*)"/gi;
    let match;

    while ((match = regex.exec(attrString)) !== null) {
      attributes[match[1]] = match[2];
    }

    return attributes;
  }

  private static detectContentChanges(prev: HTMLElement[], curr: HTMLElement[]): ContentChange[] {
    const changes: ContentChange[] = [];
    const contentElements = this.getContentElements(prev, curr);

    for (const change of this.compareContentElements(contentElements.prev, contentElements.curr)) {
      changes.push({
        type: 'content',
        priority: 3,
        ...change
      });
    }

    return changes;
  }

  private static detectStyleChanges(prev: HTMLElement[], curr: HTMLElement[]): StyleChange[] {
    const changes: StyleChange[] = [];
    const styleElements = this.getStyleElements(prev, curr);

    for (const change of this.compareStyleElements(styleElements.prev, styleElements.curr)) {
      changes.push({
        type: 'style',
        priority: 1,
        ...change
      });
    }

    return changes;
  }

  private static detectStructureChanges(prev: HTMLElement[], curr: HTMLElement[]): StructureChange[] {
    const changes: StructureChange[] = [];

    const prevTags = new Map(prev.map(el => [el.tag, prev.filter(e => e.tag === el.tag)]));
    const currTags = new Map(curr.map(el => [el.tag, curr.filter(e => e.tag === el.tag)]));

    for (const [tag] of prevTags) {
      const prevCount = prevTags.get(tag)?.length || 0;
      const currCount = currTags.get(tag)?.length || 0;

      if (prevCount !== currCount) {
        if (currCount > prevCount) {
          changes.push({
            type: 'structure',
            priority: 2,
            change: 'added',
            element: tag
          });
        } else if (currCount < prevCount) {
          changes.push({
            type: 'structure',
            priority: 2,
            change: 'removed',
            element: tag
          });
        }
      }
    }

    return changes;
  }

  private static getContentElements(prev: HTMLElement[], curr: HTMLElement[]): { prev: HTMLElement[]; curr: HTMLElement[] } {
    const contentTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'a', 'li', 'td'];
    return {
      prev: prev.filter(el => contentTags.includes(el.tag) && el.content.length > 0),
      curr: curr.filter(el => contentTags.includes(el.tag) && el.content.length > 0)
    };
  }

  private static getStyleElements(prev: HTMLElement[], curr: HTMLElement[]): { prev: HTMLElement[]; curr: HTMLElement[] } {
    return {
      prev: prev.filter(el => el.attributes.style || el.attributes.class),
      curr: curr.filter(el => el.attributes.style || el.attributes.class)
    };
  }

  private static compareContentElements(prev: HTMLElement[], curr: HTMLElement[]): Array<{
    element: string;
    position: { line: number; column: number };
    change: 'added' | 'removed' | 'modified';
    before?: string;
    after?: string;
    context?: string;
  }> {
    const changes: Array<{
      element: string;
      position: { line: number; column: number };
      change: 'added' | 'removed' | 'modified';
      before?: string;
      after?: string;
      context?: string;
    }> = [];

    const prevMap = new Map(prev.map(el => [el.content, el]));
    const currMap = new Map(curr.map(el => [el.content, el]));

    for (const [content, el] of prevMap) {
      if (!currMap.has(content)) {
        changes.push({
          element: el.tag,
          position: el.position,
          change: 'removed',
          before: content,
          context: this.getContext(content, prev)
        });
      }
    }

    for (const [content, el] of currMap) {
      if (!prevMap.has(content)) {
        changes.push({
          element: el.tag,
          position: el.position,
          change: 'added',
          after: content,
          context: this.getContext(content, curr)
        });
      }
    }

    return changes;
  }

  private static compareStyleElements(prev: HTMLElement[], curr: HTMLElement[]): Array<{
    element: string;
    attribute: string;
    change: 'added' | 'removed' | 'modified';
    before?: string;
    after?: string;
    position?: { line: number; column: number };
  }> {
    const changes: Array<{
      element: string;
      attribute: string;
      change: 'added' | 'removed' | 'modified';
      before?: string;
      after?: string;
      position?: { line: number; column: number };
    }> = [];

    const styleAttrs = ['style', 'class', 'id'];

    for (const attr of styleAttrs) {
      for (const el of prev) {
        if (el.attributes[attr]) {
          const currEl = curr.find(c => c.tag === el.tag && c.position.line === el.position.line);
          if (currEl && !currEl.attributes[attr]) {
            changes.push({
              element: el.tag,
              attribute: attr,
              change: 'removed',
              before: el.attributes[attr],
              position: el.position
            });
          }
        }
      }

      for (const el of curr) {
        if (el.attributes[attr]) {
          const prevEl = prev.find(p => p.tag === el.tag && p.position.line === el.position.line);
          if (prevEl && !prevEl.attributes[attr]) {
            changes.push({
              element: el.tag,
              attribute: attr,
              change: 'added',
              after: el.attributes[attr],
              position: el.position
            });
          } else if (prevEl && prevEl.attributes[attr] !== el.attributes[attr]) {
            changes.push({
              element: el.tag,
              attribute: attr,
              change: 'modified',
              before: prevEl.attributes[attr],
              after: el.attributes[attr],
              position: el.position
            });
          }
        }
      }
    }

    return changes;
  }

  private static getContext(content: string, elements: HTMLElement[]): string {
    const index = elements.findIndex(el => el.content === content);
    if (index === -1) return '';

    const contextElements: string[] = [];

    if (index > 0) {
      contextElements.push(elements[index - 1].content.substring(0, 50));
    }
    contextElements.push(content.substring(0, 50));
    if (index < elements.length - 1) {
      contextElements.push(elements[index + 1].content.substring(0, 50));
    }

    return contextElements.join(' ... ');
  }

  private static calculateHighestPriority(classification: ChangeClassification): number {
    let highest = 0;

    for (const change of classification.content) {
      if (change.priority > highest) highest = change.priority;
    }
    for (const change of classification.style) {
      if (change.priority > highest) highest = change.priority;
    }
    for (const change of classification.structure) {
      if (change.priority > highest) highest = change.priority;
    }

    return highest;
  }
}

interface HTMLElement {
  tag: string;
  attributes: Record<string, string>;
  content: string;
  position: { line: number; column: number };
}