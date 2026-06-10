export const DIFF_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diff Viewer - Website Backup Monitor</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #111827; }
    .container { max-width: 1600px; margin: 0 auto; padding: 20px; }
    .panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .header { padding: 20px; margin-bottom: 16px; }
    .header h1 { margin: 0 0 8px; font-size: 28px; }
    .subtle { color: #6b7280; font-size: 14px; }
    .auth-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 16px 20px; margin-bottom: 16px; background: #111827; color: white; border-radius: 12px; }
    .auth-bar input { flex: 1 1 280px; min-width: 220px; padding: 10px 12px; border-radius: 8px; border: 1px solid #374151; background: #1f2937; color: white; }
    .auth-bar button, .controls button, .controls select, .controls label, .preview-btn, .inline-btn { border-radius: 8px; font-size: 14px; }
    .auth-bar button, .controls button, .preview-btn, .inline-btn { border: 1px solid #d1d5db; background: #fff; color: #111827; padding: 10px 14px; cursor: pointer; }
    .auth-bar button.primary, .controls button.active { background: #2563eb; color: #fff; border-color: #2563eb; }
    .auth-bar button.secondary { background: transparent; color: white; border-color: #4b5563; }
    .controls { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 16px 20px; margin-bottom: 16px; }
    .controls-left, .controls-right { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .controls select { padding: 10px 12px; border: 1px solid #d1d5db; background: #fff; min-width: 180px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .summary-card { padding: 16px; }
    .summary-card .value { font-size: 28px; font-weight: 700; color: #2563eb; }
    .summary-card .label { margin-top: 6px; font-size: 13px; color: #6b7280; }
    .layout { display: grid; grid-template-columns: 320px 1fr; gap: 16px; }
    .sidebar { padding: 16px; }
    .sidebar h2, .content h2 { margin: 0 0 14px; font-size: 18px; }
    .url-list { display: flex; flex-direction: column; gap: 10px; max-height: 75vh; overflow: auto; }
    .url-item { padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; cursor: pointer; background: #fff; }
    .url-item:hover { border-color: #93c5fd; background: #f8fbff; }
    .url-item.selected { border-color: #2563eb; background: #eff6ff; }
    .url-item-title { font-size: 13px; font-weight: 600; line-height: 1.5; word-break: break-word; }
    .url-item-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge-content { background: #dbeafe; color: #1d4ed8; }
    .badge-style { background: #ffedd5; color: #c2410c; }
    .badge-structure { background: #dcfce7; color: #15803d; }
    .content { display: flex; flex-direction: column; gap: 16px; }
    .content-panel { padding: 18px; }
    .content-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
    .content-header h2 { margin-bottom: 4px; }
    .muted { color: #6b7280; font-size: 13px; }
    .empty-state, .loading { padding: 36px; text-align: center; color: #6b7280; }
    .error { display: none; margin-bottom: 16px; padding: 14px 16px; border-radius: 12px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .change-list { display: flex; flex-direction: column; gap: 12px; }
    .change-card { padding: 14px; border: 1px solid #e5e7eb; border-left: 4px solid transparent; border-radius: 10px; background: #fafafa; }
    .change-card.content { border-left-color: #2563eb; }
    .change-card.style { border-left-color: #f97316; }
    .change-card.structure { border-left-color: #22c55e; }
    .change-card-header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .change-element { font-weight: 700; font-size: 14px; }
    .change-kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 999px; padding: 3px 8px; }
    .change-kind.added { background: #dcfce7; color: #166534; }
    .change-kind.removed { background: #fee2e2; color: #991b1b; }
    .change-kind.modified { background: #fef3c7; color: #92400e; }
    .before-after { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .diff-block { border-radius: 8px; overflow: hidden; border: 1px solid #e5e7eb; }
    .diff-block-label { padding: 8px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .diff-block-label.before { background: #fef2f2; color: #991b1b; }
    .diff-block-label.after { background: #f0fdf4; color: #166534; }
    .diff-block-value { padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .diff-block-value.before { background: #fff7f7; color: #7f1d1d; }
    .diff-block-value.after { background: #f7fff9; color: #14532d; }
    .source-controls { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
    .source-controls label { display: inline-flex; align-items: center; gap: 8px; color: #374151; }
    .source-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .source-pane { border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: #fff; }
    .source-pane-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
    .source-pane-title { font-weight: 700; font-size: 13px; }
    .source-note { font-size: 12px; color: #6b7280; }
    .source-lines { max-height: 70vh; overflow: auto; background: #0f172a; color: #e5e7eb; }
    .source-row { display: grid; grid-template-columns: 52px 1fr; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .source-row.same { opacity: 0.78; }
    .source-row.added { background: rgba(34,197,94,0.18); }
    .source-row.removed { background: rgba(239,68,68,0.18); }
    .source-row.modified { background: rgba(245,158,11,0.18); }
    .line-number { padding: 8px 10px; text-align: right; color: #93c5fd; background: rgba(255,255,255,0.04); border-right: 1px solid rgba(255,255,255,0.06); user-select: none; }
    .line-content { padding: 8px 12px; white-space: pre-wrap; word-break: break-word; }
    .inline-diff-added { background: rgba(34,197,94,0.3); color: #dcfce7; border-radius: 4px; padding: 1px 0; }
    .inline-diff-removed { background: rgba(239,68,68,0.32); color: #fecaca; border-radius: 4px; padding: 1px 0; }
    .truncation-note { margin-top: 10px; font-size: 12px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; }
    .preview-btn, .inline-btn { padding: 8px 10px; font-size: 12px; }
    .preview-btn { background: #4f46e5; color: white; border-color: #4f46e5; }
    .inline-btn { background: #fff; }
    .preview-modal { display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.82); z-index: 1000; }
    .preview-modal.active { display: flex; flex-direction: column; }
    .preview-header { background: #111827; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .preview-header h3 { margin: 0; font-size: 14px; }
    .preview-tabs { display: flex; gap: 8px; }
    .preview-tab { background: transparent; border: 1px solid #4b5563; color: #9ca3af; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
    .preview-tab.active { background: #2563eb; border-color: #2563eb; color: white; }
    .preview-close { background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
    .preview-content { flex: 1; background: white; }
    .preview-content iframe { width: 100%; height: 100%; border: none; }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .url-list { max-height: none; }
      .source-grid, .before-after { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="panel header">
      <h1 id="pageTitle">Diff Viewer</h1>
      <div id="pageInfo" class="subtle">Pick a site and backup date to inspect the exact before/after changes.</div>
    </div>

    <div class="auth-bar" id="authBar">
      <strong>Admin API Token</strong>
      <input id="tokenInput" type="password" placeholder="Paste ADMIN_API_TOKEN for API requests" />
      <button id="saveTokenBtn" class="primary">Save Token</button>
      <button id="clearTokenBtn" class="secondary">Clear</button>
      <span id="authStatus" class="subtle" style="color:#d1d5db;"></span>
    </div>

    <div id="error" class="error"></div>

    <div class="panel controls">
      <div class="controls-left">
        <select id="siteSelect"><option value="">Select Site...</option></select>
        <select id="dateSelect"><option value="">Select Date...</option></select>
      </div>
      <div class="controls-right">
        <button id="viewAll" class="active">All</button>
        <button id="viewContent">Content</button>
        <button id="viewStyle">Style</button>
        <button id="viewStructure">Structure</button>
      </div>
    </div>

    <div class="summary" id="summary" style="display:none;">
      <div class="panel summary-card"><div class="value" id="totalChanges">0</div><div class="label">Total Changes</div></div>
      <div class="panel summary-card"><div class="value" id="contentChanges">0</div><div class="label">Content Changes</div></div>
      <div class="panel summary-card"><div class="value" id="styleChanges">0</div><div class="label">Style Changes</div></div>
      <div class="panel summary-card"><div class="value" id="structureChanges">0</div><div class="label">Structure Changes</div></div>
    </div>

    <div class="layout">
      <aside class="panel sidebar">
        <h2>Changed URLs</h2>
        <div id="urlList" class="url-list">
          <div class="empty-state">Select a site and date to list changed pages.</div>
        </div>
      </aside>

      <main class="content">
        <section class="panel content-panel" id="changesPanel">
          <div class="content-header">
            <div>
              <h2>Detected Changes</h2>
              <div id="changeMeta" class="muted">Select a changed URL to inspect the classified differences.</div>
            </div>
            <div>
              <button id="openPreviewBtn" class="inline-btn" style="display:none;">Open Visual Preview</button>
            </div>
          </div>
          <div id="changesContent" class="change-list">
            <div class="empty-state">No URL selected.</div>
          </div>
        </section>

        <section class="panel content-panel" id="sourcePanel">
          <div class="content-header">
            <div>
              <h2>Source Diff</h2>
              <div id="sourceMeta" class="muted">Line-level HTML comparison between the previous and current backup.</div>
            </div>
          </div>
          <div class="source-controls">
            <label><input type="checkbox" id="changedOnlyToggle" checked /> Show only changed lines</label>
            <div id="sourceStats" class="muted"></div>
          </div>
          <div class="source-grid">
            <div class="source-pane">
              <div class="source-pane-header">
                <span class="source-pane-title">Previous</span>
                <span class="source-note" id="previousDateLabel">-</span>
              </div>
              <div class="source-lines" id="previousSource"><div class="empty-state">No source loaded.</div></div>
            </div>
            <div class="source-pane">
              <div class="source-pane-header">
                <span class="source-pane-title">Current</span>
                <span class="source-note" id="currentDateLabel">-</span>
              </div>
              <div class="source-lines" id="currentSource"><div class="empty-state">No source loaded.</div></div>
            </div>
          </div>
          <div id="sourceTruncation" class="truncation-note" style="display:none;"></div>
        </section>
      </main>
    </div>

    <div id="loading" class="loading" style="display:none;">Loading...</div>
  </div>

  <div class="preview-modal" id="previewModal">
    <div class="preview-header">
      <h3 id="previewTitle">Preview</h3>
      <div class="preview-tabs">
        <button class="preview-tab" id="previewPrevBtn">Previous Version</button>
        <button class="preview-tab active" id="previewCurrBtn">Current Version</button>
      </div>
      <button class="preview-close" id="previewClose">Close</button>
    </div>
    <div class="preview-content">
      <iframe id="previewFrame" sandbox="allow-same-origin"></iframe>
    </div>
  </div>

  <script>
    const baseUrl = window.location.origin;
    const tokenStorageKey = 'backupMonitorAdminToken';
    const params = new URLSearchParams(window.location.search);
    let adminToken = localStorage.getItem(tokenStorageKey) || '';
    let currentDiff = null;
    let currentUrlDiff = null;
    let currentView = 'all';
    let currentPreviewHash = null;
    let currentPreviewUrl = null;
    let previewVersion = 'current';

    const tokenInput = document.getElementById('tokenInput');
    const authStatus = document.getElementById('authStatus');
    tokenInput.value = adminToken;

    function isLocalhost() {
      return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    }

    function updateAuthStatus(message) {
      if (message) {
        authStatus.textContent = message;
        return;
      }
      if (adminToken) {
        authStatus.textContent = 'Token saved for this browser session.';
      } else if (isLocalhost()) {
        authStatus.textContent = 'Local dev detected; token is optional.';
      } else {
        authStatus.textContent = 'Required for secured API requests.';
      }
    }

    function getAuthHeaders() {
      if (!adminToken) return {};
      return { Authorization: 'Bearer ' + adminToken };
    }

    async function fetchJson(path) {
      const response = await fetch(baseUrl + path, {
        headers: getAuthHeaders(),
        signal: AbortSignal.timeout(30000)
      });

      if (response.status === 401 || response.status === 503) {
        let message = 'API authentication is required.';
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
        } catch {}
        updateAuthStatus(message);
        throw new Error(message);
      }

      if (!response.ok) {
        let message = 'Request failed.';
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
        } catch {}
        throw new Error(message);
      }

      return response.json();
    }

    function setView(view) {
      currentView = view;
      document.querySelectorAll('#viewAll, #viewContent, #viewStyle, #viewStructure').forEach(function(btn) {
        btn.classList.remove('active');
      });
      document.getElementById('view' + view.charAt(0).toUpperCase() + view.slice(1)).classList.add('active');
      if (currentUrlDiff) renderUrlDiff(currentUrlDiff);
    }

    async function loadSites() {
      try {
        const sites = await fetchJson('/api/sites');
        const select = document.getElementById('siteSelect');
        select.innerHTML = '<option value="">Select Site...</option>';
        for (const site of sites) {
          const option = document.createElement('option');
          option.value = site.id;
          option.textContent = site.name;
          select.appendChild(option);
        }

        if (params.get('siteId')) {
          select.value = params.get('siteId');
          await loadDates();
        }
      } catch (error) {
        showError('Failed to load sites: ' + error.message);
      }
    }

    async function loadDates() {
      const siteId = document.getElementById('siteSelect').value;
      const select = document.getElementById('dateSelect');
      select.innerHTML = '<option value="">Select Date...</option>';
      currentDiff = null;
      currentUrlDiff = null;
      resetContentPanels('Select a date to view changes.');
      if (!siteId) {
        updateUrlParams();
        return;
      }

      try {
        const dates = await fetchJson('/api/sites/dates?siteId=' + encodeURIComponent(siteId));
        for (const date of dates) {
          const option = document.createElement('option');
          option.value = date;
          option.textContent = date;
          select.appendChild(option);
        }

        if (params.get('date')) {
          select.value = params.get('date');
          await loadDiff();
        }
      } catch (error) {
        showError('Failed to load dates: ' + error.message);
      } finally {
        updateUrlParams();
      }
    }

    async function loadDiff() {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      if (!siteId || !date) return;

      showLoading(true);
      try {
        currentDiff = await fetchJson('/api/sites/' + encodeURIComponent(siteId) + '/diff/' + encodeURIComponent(date));
        renderSummary();
        renderUrlList();

        if (currentDiff.urls.length > 0) {
          const requestedHash = params.get('urlHash');
          const initialHash = requestedHash && currentDiff.urls.some(function(item) { return item.urlHash === requestedHash; })
            ? requestedHash
            : currentDiff.urls[0].urlHash;
          await selectUrl(initialHash);
        } else {
          resetContentPanels('No changed URLs were detected for this backup date.');
        }

        document.getElementById('summary').style.display = 'grid';
      } catch (error) {
        showError('Failed to load diff: ' + error.message);
      } finally {
        updateUrlParams();
        showLoading(false);
      }
    }

    async function selectUrl(urlHash) {
      if (!currentDiff) return;
      showLoading(true);
      try {
        const siteId = document.getElementById('siteSelect').value;
        const date = document.getElementById('dateSelect').value;
        currentUrlDiff = await fetchJson('/api/sites/' + encodeURIComponent(siteId) + '/diff/' + encodeURIComponent(date) + '/url/' + encodeURIComponent(urlHash));
        highlightSelectedUrl(urlHash);
        renderUrlDiff(currentUrlDiff);
      } catch (error) {
        showError('Failed to load URL diff: ' + error.message);
      } finally {
        updateUrlParams(urlHash);
        showLoading(false);
      }
    }

    function highlightSelectedUrl(urlHash) {
      document.querySelectorAll('.url-item').forEach(function(node) {
        node.classList.toggle('selected', node.getAttribute('data-hash') === urlHash);
      });
    }

    function renderUrlList() {
      const container = document.getElementById('urlList');
      if (!currentDiff || currentDiff.urls.length === 0) {
        container.innerHTML = '<div class="empty-state">No changed URLs found.</div>';
        return;
      }

      container.innerHTML = '';
      for (const urlData of currentDiff.urls) {
        const item = document.createElement('div');
        item.className = 'url-item';
        item.setAttribute('data-hash', urlData.urlHash);
        item.innerHTML =
          '<div class="url-item-title">' + escapeHtml(urlData.url) + '</div>' +
          '<div class="url-item-actions">' +
            '<div class="badge-row">' +
              (urlData.contentChanges > 0 ? '<span class="badge badge-content">' + urlData.contentChanges + ' content</span>' : '') +
              (urlData.styleChanges > 0 ? '<span class="badge badge-style">' + urlData.styleChanges + ' style</span>' : '') +
              (urlData.structureChanges > 0 ? '<span class="badge badge-structure">' + urlData.structureChanges + ' structure</span>' : '') +
            '</div>' +
            '<button class="preview-btn" type="button">Preview</button>' +
          '</div>';

        item.addEventListener('click', function(event) {
          if (event.target && event.target.classList.contains('preview-btn')) return;
          selectUrl(urlData.urlHash);
        });

        item.querySelector('.preview-btn').addEventListener('click', function(event) {
          event.stopPropagation();
          openPreview(urlData.urlHash, urlData.url);
        });

        container.appendChild(item);
      }
    }

    function renderSummary() {
      if (!currentDiff) return;
      const totals = currentDiff.urls.reduce(function(acc, item) {
        acc.content += item.contentChanges;
        acc.style += item.styleChanges;
        acc.structure += item.structureChanges;
        return acc;
      }, { content: 0, style: 0, structure: 0 });

      document.getElementById('totalChanges').textContent = String(totals.content + totals.style + totals.structure);
      document.getElementById('contentChanges').textContent = String(totals.content);
      document.getElementById('styleChanges').textContent = String(totals.style);
      document.getElementById('structureChanges').textContent = String(totals.structure);
    }

    function renderUrlDiff(urlDiff) {
      document.getElementById('pageTitle').textContent = 'Changes for ' + urlDiff.url;
      document.getElementById('pageInfo').textContent = 'Comparing ' + urlDiff.previousDate + ' to ' + urlDiff.currentDate;
      document.getElementById('changeMeta').textContent = 'Detected structured changes for ' + urlDiff.url;
      document.getElementById('sourceMeta').textContent = 'Line-level HTML diff for ' + urlDiff.url;
      document.getElementById('previousDateLabel').textContent = urlDiff.previousDate;
      document.getElementById('currentDateLabel').textContent = urlDiff.currentDate;
      document.getElementById('openPreviewBtn').style.display = 'inline-flex';
      renderChanges(urlDiff);
      renderSourceDiff(urlDiff);
    }

    function getFilteredChanges(classification) {
      if (currentView === 'all') return classification;
      return {
        content: currentView === 'content' ? classification.content : [],
        style: currentView === 'style' ? classification.style : [],
        structure: currentView === 'structure' ? classification.structure : []
      };
    }

    function renderChanges(urlDiff) {
      const classification = getFilteredChanges(urlDiff.classification);
      const changes = []
        .concat(classification.content.map(function(change) { return Object.assign({ category: 'content' }, change); }))
        .concat(classification.style.map(function(change) { return Object.assign({ category: 'style' }, change); }))
        .concat(classification.structure.map(function(change) { return Object.assign({ category: 'structure' }, change); }));

      const container = document.getElementById('changesContent');
      if (changes.length === 0) {
        container.innerHTML = '<div class="empty-state">No ' + escapeHtml(currentView) + ' changes found for this URL.</div>';
        return;
      }

      container.innerHTML = changes.map(function(change) {
        const beforeBlock = change.before
          ? '<div class="diff-block"><div class="diff-block-label before">Before</div><div class="diff-block-value before">' + escapeHtml(change.before) + '</div></div>'
          : '';
        const afterBlock = change.after
          ? '<div class="diff-block"><div class="diff-block-label after">After</div><div class="diff-block-value after">' + escapeHtml(change.after) + '</div></div>'
          : '';

        return (
          '<div class="change-card ' + change.category + '">' +
            '<div class="change-card-header">' +
              '<span class="change-element">' + escapeHtml(change.element || change.category) + '</span>' +
              '<span class="change-kind ' + escapeHtml(change.change || 'modified') + '">' + escapeHtml(change.change || 'modified') + '</span>' +
              (change.attribute ? '<span class="muted">attribute: ' + escapeHtml(change.attribute) + '</span>' : '') +
            '</div>' +
            ((beforeBlock || afterBlock) ? '<div class="before-after">' + beforeBlock + afterBlock + '</div>' : '') +
            (change.context ? '<div class="muted" style="margin-top:10px;">' + escapeHtml(change.context) + '</div>' : '') +
          '</div>'
        );
      }).join('');
    }

    function normalizeHtmlForDiff(content) {
      if (!content) return '';
      return content
        .replace(/></g, '>\\n<')
        .replace(/\\s+$/gm, '')
        .trim();
    }

    function prepareSourceLines(content) {
      const normalized = normalizeHtmlForDiff(content);
      const allLines = normalized ? normalized.split('\\n') : [];
      const maxLines = 600;
      return {
        lines: allLines.slice(0, maxLines),
        truncated: allLines.length > maxLines,
        totalLines: allLines.length
      };
    }

    function buildOperations(leftLines, rightLines) {
      const leftLength = leftLines.length;
      const rightLength = rightLines.length;
      const dp = Array.from({ length: leftLength + 1 }, function() {
        return Array(rightLength + 1).fill(0);
      });

      for (let i = leftLength - 1; i >= 0; i--) {
        for (let j = rightLength - 1; j >= 0; j--) {
          if (leftLines[i] === rightLines[j]) {
            dp[i][j] = dp[i + 1][j + 1] + 1;
          } else {
            dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }

      const operations = [];
      let i = 0;
      let j = 0;
      while (i < leftLength && j < rightLength) {
        if (leftLines[i] === rightLines[j]) {
          operations.push({ type: 'same', left: leftLines[i], right: rightLines[j] });
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          operations.push({ type: 'removed', left: leftLines[i], right: '' });
          i++;
        } else {
          operations.push({ type: 'added', left: '', right: rightLines[j] });
          j++;
        }
      }

      while (i < leftLength) {
        operations.push({ type: 'removed', left: leftLines[i], right: '' });
        i++;
      }
      while (j < rightLength) {
        operations.push({ type: 'added', left: '', right: rightLines[j] });
        j++;
      }

      const rows = [];
      let leftNumber = 1;
      let rightNumber = 1;
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        const nextOperation = operations[index + 1];

        if (operation.type === 'removed' && nextOperation && nextOperation.type === 'added') {
          rows.push({
            type: 'modified',
            leftNumber: leftNumber++,
            rightNumber: rightNumber++,
            left: operation.left,
            right: nextOperation.right
          });
          index++;
          continue;
        }

        if (operation.type === 'added' && nextOperation && nextOperation.type === 'removed') {
          rows.push({
            type: 'modified',
            leftNumber: leftNumber++,
            rightNumber: rightNumber++,
            left: nextOperation.left,
            right: operation.right
          });
          index++;
          continue;
        }

        if (operation.type === 'same') {
          rows.push({
            type: 'same',
            leftNumber: leftNumber++,
            rightNumber: rightNumber++,
            left: operation.left,
            right: operation.right
          });
        } else if (operation.type === 'removed') {
          rows.push({
            type: 'removed',
            leftNumber: leftNumber++,
            rightNumber: '',
            left: operation.left,
            right: ''
          });
        } else {
          rows.push({
            type: 'added',
            leftNumber: '',
            rightNumber: rightNumber++,
            left: '',
            right: operation.right
          });
        }
      }

      return rows;
    }

    function tokenizeForInlineDiff(text) {
      if (!text) return [];
      const matches = text.match(/\\s+|[^\\s]+/g);
      return matches ? matches : [];
    }

    function buildInlineDiffSegments(leftText, rightText) {
      const leftTokens = tokenizeForInlineDiff(leftText);
      const rightTokens = tokenizeForInlineDiff(rightText);
      const leftLength = leftTokens.length;
      const rightLength = rightTokens.length;
      const dp = Array.from({ length: leftLength + 1 }, function() {
        return Array(rightLength + 1).fill(0);
      });

      for (let i = leftLength - 1; i >= 0; i--) {
        for (let j = rightLength - 1; j >= 0; j--) {
          if (leftTokens[i] === rightTokens[j]) {
            dp[i][j] = dp[i + 1][j + 1] + 1;
          } else {
            dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }

      const leftSegments = [];
      const rightSegments = [];
      let i = 0;
      let j = 0;

      while (i < leftLength && j < rightLength) {
        if (leftTokens[i] === rightTokens[j]) {
          leftSegments.push({ text: leftTokens[i], type: 'same' });
          rightSegments.push({ text: rightTokens[j], type: 'same' });
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          leftSegments.push({ text: leftTokens[i], type: 'removed' });
          i++;
        } else {
          rightSegments.push({ text: rightTokens[j], type: 'added' });
          j++;
        }
      }

      while (i < leftLength) {
        leftSegments.push({ text: leftTokens[i], type: 'removed' });
        i++;
      }

      while (j < rightLength) {
        rightSegments.push({ text: rightTokens[j], type: 'added' });
        j++;
      }

      return { leftSegments: mergeAdjacentSegments(leftSegments), rightSegments: mergeAdjacentSegments(rightSegments) };
    }

    function mergeAdjacentSegments(segments) {
      const merged = [];
      for (const segment of segments) {
        const previous = merged[merged.length - 1];
        if (previous && previous.type === segment.type) {
          previous.text += segment.text;
        } else {
          merged.push({ text: segment.text, type: segment.type });
        }
      }
      return merged;
    }

    function renderInlineDiffSegments(segments, changedType) {
      return segments.map(function(segment) {
        if (segment.type === 'same') {
          return escapeHtml(segment.text);
        }

        const className = changedType === 'added' ? 'inline-diff-added' : 'inline-diff-removed';
        return '<span class="' + className + '">' + escapeHtml(segment.text) + '</span>';
      }).join('');
    }

    function renderSourceLine(row, side) {
      const lineNumber = side === 'left' ? (row.leftNumber || '') : (row.rightNumber || '');
      const lineText = side === 'left' ? (row.left || '') : (row.right || '');

      let lineHtml = escapeHtml(lineText);
      if (row.type === 'modified') {
        const inlineDiff = buildInlineDiffSegments(row.left || '', row.right || '');
        lineHtml = side === 'left'
          ? renderInlineDiffSegments(inlineDiff.leftSegments, 'removed')
          : renderInlineDiffSegments(inlineDiff.rightSegments, 'added');
      }

      return (
        '<div class="source-row ' + row.type + '">' +
          '<div class="line-number">' + lineNumber + '</div>' +
          '<div class="line-content">' + lineHtml + '</div>' +
        '</div>'
      );
    }

    function renderSourceDiff(urlDiff) {
      const previousPrepared = prepareSourceLines(urlDiff.source ? urlDiff.source.previous : '');
      const currentPrepared = prepareSourceLines(urlDiff.source ? urlDiff.source.current : '');
      const rows = buildOperations(previousPrepared.lines, currentPrepared.lines);
      const changedOnly = document.getElementById('changedOnlyToggle').checked;
      const visibleRows = changedOnly
        ? rows.filter(function(row) { return row.type !== 'same'; })
        : rows;

      const previousContainer = document.getElementById('previousSource');
      const currentContainer = document.getElementById('currentSource');

      if (visibleRows.length === 0) {
        previousContainer.innerHTML = '<div class="empty-state">No visible source changes.</div>';
        currentContainer.innerHTML = '<div class="empty-state">No visible source changes.</div>';
      } else {
        previousContainer.innerHTML = visibleRows.map(function(row) {
          return renderSourceLine(row, 'left');
        }).join('');

        currentContainer.innerHTML = visibleRows.map(function(row) {
          return renderSourceLine(row, 'right');
        }).join('');
      }

      const changedRows = rows.filter(function(row) { return row.type !== 'same'; }).length;
      document.getElementById('sourceStats').textContent =
        changedRows + ' changed line pair' + (changedRows === 1 ? '' : 's') +
        ' shown out of ' + rows.length + ' total line pair' + (rows.length === 1 ? '' : 's');

      const truncation = document.getElementById('sourceTruncation');
      if (previousPrepared.truncated || currentPrepared.truncated) {
        truncation.style.display = 'block';
        truncation.textContent =
          'Large document detected. The source diff is limited to the first 600 formatted lines per version (' +
          previousPrepared.totalLines + ' previous, ' + currentPrepared.totalLines + ' current).';
      } else {
        truncation.style.display = 'none';
        truncation.textContent = '';
      }
    }

    function resetContentPanels(message) {
      document.getElementById('changesContent').innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
      document.getElementById('previousSource').innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
      document.getElementById('currentSource').innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
      document.getElementById('openPreviewBtn').style.display = 'none';
      document.getElementById('sourceStats').textContent = '';
      document.getElementById('sourceTruncation').style.display = 'none';
    }

    function showLoading(show) {
      document.getElementById('loading').style.display = show ? 'block' : 'none';
    }

    function showError(message) {
      const errorNode = document.getElementById('error');
      errorNode.textContent = message;
      errorNode.style.display = 'block';
      clearTimeout(showError.timer);
      showError.timer = setTimeout(function() {
        errorNode.style.display = 'none';
      }, 6000);
    }

    function escapeHtml(value) {
      const div = document.createElement('div');
      div.textContent = value == null ? '' : String(value);
      return div.innerHTML;
    }

    function updateUrlParams(urlHash) {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      const nextParams = new URLSearchParams();
      if (siteId) nextParams.set('siteId', siteId);
      if (date) nextParams.set('date', date);
      if (urlHash) nextParams.set('urlHash', urlHash);
      const nextUrl = window.location.pathname + (nextParams.toString() ? '?' + nextParams.toString() : '');
      window.history.replaceState({}, '', nextUrl);
    }

    document.getElementById('saveTokenBtn').addEventListener('click', function() {
      adminToken = tokenInput.value.trim();
      if (adminToken) {
        localStorage.setItem(tokenStorageKey, adminToken);
        updateAuthStatus();
        loadSites();
      }
    });

    document.getElementById('clearTokenBtn').addEventListener('click', function() {
      adminToken = '';
      tokenInput.value = '';
      localStorage.removeItem(tokenStorageKey);
      updateAuthStatus();
    });

    document.getElementById('viewAll').addEventListener('click', function() { setView('all'); });
    document.getElementById('viewContent').addEventListener('click', function() { setView('content'); });
    document.getElementById('viewStyle').addEventListener('click', function() { setView('style'); });
    document.getElementById('viewStructure').addEventListener('click', function() { setView('structure'); });
    document.getElementById('siteSelect').addEventListener('change', loadDates);
    document.getElementById('dateSelect').addEventListener('change', loadDiff);
    document.getElementById('changedOnlyToggle').addEventListener('change', function() {
      if (currentUrlDiff) renderSourceDiff(currentUrlDiff);
    });
    document.getElementById('openPreviewBtn').addEventListener('click', function() {
      if (currentUrlDiff) openPreview(currentUrlDiff.urlHash, currentUrlDiff.url);
    });

    document.getElementById('previewClose').addEventListener('click', closePreview);
    document.getElementById('previewPrevBtn').addEventListener('click', function() { switchPreviewVersion('previous'); });
    document.getElementById('previewCurrBtn').addEventListener('click', function() { switchPreviewVersion('current'); });
    document.getElementById('previewModal').addEventListener('click', function(event) {
      if (event.target.id === 'previewModal') closePreview();
    });

    function openPreview(urlHash, url) {
      currentPreviewHash = urlHash;
      currentPreviewUrl = url;
      previewVersion = 'current';
      document.getElementById('previewTitle').textContent = url;
      document.getElementById('previewPrevBtn').classList.remove('active');
      document.getElementById('previewCurrBtn').classList.add('active');
      document.getElementById('previewModal').classList.add('active');
      loadPreview();
    }

    function closePreview() {
      document.getElementById('previewModal').classList.remove('active');
      document.getElementById('previewFrame').src = 'about:blank';
    }

    function switchPreviewVersion(version) {
      previewVersion = version;
      document.getElementById('previewPrevBtn').classList.toggle('active', version === 'previous');
      document.getElementById('previewCurrBtn').classList.toggle('active', version === 'current');
      loadPreview();
    }

    function loadPreview() {
      if (!currentPreviewHash || !currentUrlDiff) return;
      const siteId = document.getElementById('siteSelect').value;
      let previewDate = currentUrlDiff.currentDate;
      if (previewVersion === 'previous') {
        previewDate = currentUrlDiff.previousDate;
      }

      const previewUrl = baseUrl + '/api/sites/' + encodeURIComponent(siteId) + '/preview/' + encodeURIComponent(previewDate) + '/' + encodeURIComponent(currentPreviewHash);
      fetch(previewUrl, {
        headers: getAuthHeaders(),
        signal: AbortSignal.timeout(60000)
      })
        .then(function(response) {
          if (!response.ok) {
            throw new Error('Failed to load preview');
          }
          return response.text();
        })
        .then(function(html) {
          document.getElementById('previewFrame').srcdoc = html;
        })
        .catch(function(error) {
          document.getElementById('previewFrame').srcdoc =
            '<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#991b1b;background:#fff7f7;"><p>' +
            escapeHtml(error.message) +
            '</p></body></html>';
        });
    }

    updateAuthStatus();
    resetContentPanels('Select a site and date to view changes.');
    loadSites();
  </script>
</body>
</html>
`;
