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

