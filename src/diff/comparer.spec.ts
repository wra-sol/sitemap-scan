import { describe, it, expect } from 'vitest';
import { ContentComparer } from './comparer';

describe('ContentComparer.calculateNormalizedHash', () => {
  it('ignores common human-readable calculated dates in body', async () => {
    const html1 = `
      <html>
        <body>
          <header>Sunday Feb 22, 2026</header>
          <main>
            <p>News content here.</p>
            <p>Last updated: 2 days ago</p>
          </main>
        </body>
      </html>
    `;

    const html2 = `
      <html>
        <body>
          <header>Monday Feb 23, 2026</header>
          <main>
            <p>News content here.</p>
            <p>Last updated: 3 days ago</p>
          </main>
        </body>
      </html>
    `;

    const n1 = await ContentComparer.normalizeContent(html1);
    const n2 = await ContentComparer.normalizeContent(html2);
    expect(n1).toBe(n2);
  });

  it('ignores common numeric date formats', async () => {
    const html1 = `<html><body><p>Report generated on 02/22/2026</p></body></html>`;
    const html2 = `<html><body><p>Report generated on 2/23/2026</p></body></html>`;

    const h1 = await ContentComparer.calculateNormalizedHash(html1);
    const h2 = await ContentComparer.calculateNormalizedHash(html2);
    expect(h1).toBe(h2);
  });

  it('removes HTML comments and collapses whitespace', async () => {
    const html = `<!-- comment --><div>  Hello  </div>`;
    const normalized = await ContentComparer.normalizeContent(html);
    expect(normalized).not.toContain('<!--');
    expect(normalized).toContain('<div> Hello </div>');
  });

  it('sorts attributes and removes redundant ones', async () => {
    const html1 = `<script type="text/javascript" src="app.js" async></script>`;
    const html2 = `<script async src="app.js"></script>`;
    const n1 = await ContentComparer.normalizeContent(html1);
    const n2 = await ContentComparer.normalizeContent(html2);
    expect(n1).toBe(n2);
  });

  it('uses short doctype', async () => {
    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0//EN"><html></html>`;
    const normalized = await ContentComparer.normalizeContent(html);
    expect(normalized).toContain('<!DOCTYPE html>');
    expect(normalized).not.toContain('PUBLIC');
  });
});

describe('ContentComparer.compareContent', () => {
  it('detects unchanged content', async () => {
    const result = await ContentComparer.compareContent('https://example.com', '<p>Hello</p>', '<p>Hello</p>');
    expect(result.hasChanged).toBe(false);
    expect(result.changeSize).toBe(0);
  });

  it('detects changed content', async () => {
    const result = await ContentComparer.compareContent('https://example.com', '<p>Hello</p>', '<p>World</p>');
    expect(result.hasChanged).toBe(true);
    expect(result.changeSize).toBeGreaterThan(0);
  });
});

describe('ContentComparer.generateDiff', () => {
  it('returns line counts for added and removed content', async () => {
    const diff = await ContentComparer.generateDiff('<p>Hello</p>\n<p>World</p>', '<p>Hello</p>\n<p>Earth</p>');
    expect(diff.hasChanged).toBe(true);
    expect(diff.diffSummary.linesAdded).toBeGreaterThanOrEqual(0);
    expect(diff.diffSummary.linesRemoved).toBeGreaterThanOrEqual(0);
  });
});

describe('ContentComparer.calculateChangeMagnitude', () => {
  it('returns zero for identical content', async () => {
    const magnitude = await ContentComparer.calculateChangeMagnitude('<p>Hello</p>', '<p>Hello</p>');
    expect(magnitude.changedChars).toBe(0);
    expect(magnitude.addedChars).toBe(0);
    expect(magnitude.removedChars).toBe(0);
  });

  it('measures added characters', async () => {
    const magnitude = await ContentComparer.calculateChangeMagnitude('<p>Hi</p>', '<p>Hello</p>');
    expect(magnitude.changedChars).toBeGreaterThan(0);
    expect(magnitude.addedChars).toBeGreaterThan(0);
  });
});

describe('ContentComparer.compareBatch', () => {
  it('compares multiple URLs in batch', async () => {
    const results = await ContentComparer.compareBatch([
      { url: 'https://a.com', previousContent: '<p>A</p>', currentContent: '<p>A</p>' },
      { url: 'https://b.com', previousContent: '<p>B</p>', currentContent: '<p>C</p>' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].hasChanged).toBe(false);
    expect(results[1].hasChanged).toBe(true);
  });
});

describe('ContentComparer.summarizeChanges', () => {
  it('calculates totals correctly', () => {
    const summary = ContentComparer.summarizeChanges([
      { url: 'https://a.com', hasChanged: true, previousHash: 'a', currentHash: 'b', changeSize: 10, changeType: 'content' },
      { url: 'https://b.com', hasChanged: false, previousHash: 'c', currentHash: 'c', changeSize: 0, changeType: 'metadata' },
      { url: 'https://c.com', hasChanged: true, previousHash: 'd', currentHash: 'e', changeSize: 5, changeType: 'content' },
    ]);
    expect(summary.totalUrls).toBe(3);
    expect(summary.changedUrls).toBe(2);
    expect(summary.totalChanges).toBe(15);
    expect(summary.averageChangeSize).toBe(7.5);
    expect(summary.largestChange).toEqual({ url: 'https://a.com', size: 10 });
  });
});

describe('ContentComparer.classifyChanges', () => {
  it('returns a generic fallback change when hash differs but no semantic changes are detected', async () => {
    const prev = '<html><body><p>Hello world</p></body></html>';
    const curr = '<html><body><p>Hello world</p></body></html>';
    const diff = await ContentComparer.classifyChanges(
      'https://example.com/page',
      prev,
      curr,
      'hash-a',
      'hash-b',
      '2026-05-23'
    );

    expect(diff.summary.totalChanges).toBe(1);
    expect(diff.classification.content.length).toBe(1);
    expect(diff.classification.content[0].element).toBe('html');
    expect(diff.classification.content[0].context).toBe('HTML changed (no semantic differences detected)');
    expect(diff.classification.style.length).toBe(0);
    expect(diff.classification.structure.length).toBe(0);
  });

  it('returns zero changes when hashes are identical', async () => {
    const prev = '<html><body><p>Hello world</p></body></html>';
    const curr = '<html><body><p>Hello world</p></body></html>';
    const diff = await ContentComparer.classifyChanges(
      'https://example.com/page',
      prev,
      curr,
      'same-hash',
      'same-hash',
      '2026-05-23'
    );

    expect(diff.summary.totalChanges).toBe(0);
    expect(diff.classification.content.length).toBe(0);
    expect(diff.classification.style.length).toBe(0);
    expect(diff.classification.structure.length).toBe(0);
  });
});
