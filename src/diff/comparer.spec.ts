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
});

describe('ContentComparer.classifyChanges', () => {
  it('returns a generic fallback change when hash differs but no semantic changes are detected', async () => {
    const prev = '<html><body><p>Hello world</p></body></html>';
    const curr = '<html><body><p>Hello world</p></body></html>';
    // Ensure hashes differ by appending an ignored comment that normalization strips,
    // but the raw HTML strings are identical so detectTextContentChanges finds nothing.
    // Actually identical strings yield identical hashes. We need hash to differ without
    // triggering semantic detectors. Using a custom ignore pattern is hard here.
    // Instead we can directly call classifyChanges with different hashes.
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

