export function serveOperatorConsole(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Operator Console - Website Backup Monitor</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; }
    .page { max-width: 1600px; margin: 0 auto; padding: 24px; }
    .hero, .panel { background: rgba(15, 23, 42, 0.86); border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 16px; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.28); }
    .hero { padding: 24px; margin-bottom: 18px; }
    h1, h2, h3 { margin: 0; }
    .subtitle { margin-top: 8px; color: #94a3b8; font-size: 14px; }
    .auth-bar, .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 16px 18px; margin-bottom: 18px; }
    .auth-bar { background: #111827; border-radius: 14px; }
    input, textarea, select, button { font: inherit; }
    input, textarea, select { width: 100%; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.22); background: rgba(15, 23, 42, 0.88); color: #e2e8f0; padding: 10px 12px; }
    textarea { min-height: 360px; resize: vertical; }
    button { border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.22); background: #1e293b; color: #e2e8f0; padding: 10px 14px; cursor: pointer; }
    button.primary { background: #2563eb; border-color: #2563eb; }
    button.warn { background: #b91c1c; border-color: #b91c1c; }
    button.ghost { background: transparent; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .token-input { flex: 1 1 320px; }
    .status { color: #cbd5e1; font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 18px; }
    .stack { display: flex; flex-direction: column; gap: 18px; }
    .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 18px 18px 0; }
    .panel-body { padding: 18px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .metric { padding: 14px; border-radius: 12px; background: rgba(30, 41, 59, 0.85); border: 1px solid rgba(148, 163, 184, 0.12); }
    .metric .label { color: #94a3b8; font-size: 12px; }
    .metric .value { margin-top: 6px; font-size: 24px; font-weight: 700; }
    .site-list, .run-list { display: flex; flex-direction: column; gap: 10px; max-height: 440px; overflow: auto; }
    .site-card, .run-card { padding: 14px; border-radius: 12px; background: rgba(15, 23, 42, 0.78); border: 1px solid rgba(148, 163, 184, 0.12); }
    .site-card.selected { border-color: #60a5fa; background: rgba(30, 41, 59, 0.95); }
    .site-top, .run-top { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .site-name, .run-title { font-weight: 700; }
    .muted { color: #94a3b8; font-size: 12px; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .badge { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge.ok { background: rgba(34, 197, 94, 0.16); color: #86efac; }
    .badge.warn { background: rgba(245, 158, 11, 0.15); color: #fcd34d; }
    .badge.bad { background: rgba(239, 68, 68, 0.14); color: #fca5a5; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    .editor-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .inline-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .iframe-shell { border: 1px solid rgba(148, 163, 184, 0.12); border-radius: 14px; overflow: hidden; background: #020617; min-height: 720px; }
    iframe { width: 100%; min-height: 720px; border: 0; background: white; }
    .flash { display: none; margin-bottom: 18px; padding: 12px 14px; border-radius: 12px; font-size: 14px; }
    .flash.error { background: rgba(127, 29, 29, 0.9); color: #fecaca; border: 1px solid rgba(248, 113, 113, 0.35); }
    .flash.success { background: rgba(20, 83, 45, 0.9); color: #bbf7d0; border: 1px solid rgba(74, 222, 128, 0.35); }
    .small { font-size: 12px; }
    @media (max-width: 1200px) {
      .grid { grid-template-columns: 1fr; }
      .inline-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <h1>Operator Console</h1>
      <div class="subtitle">Manage monitored sites, inspect recent runs, trigger backups, and open the backup or diff explorers without leaving one console.</div>
    </section>

    <div class="auth-bar">
      <strong>Admin API Token</strong>
      <input id="tokenInput" class="token-input" type="password" placeholder="Paste ADMIN_API_TOKEN for secured deployments" />
      <button id="saveTokenBtn" class="primary">Save Token</button>
      <button id="clearTokenBtn" class="ghost">Clear</button>
      <span id="authStatus" class="status"></span>
    </div>

    <div id="flash" class="flash"></div>

    <div class="metrics" id="topMetrics">
      <div class="metric"><div class="label">Configured Sites</div><div class="value" id="metricSites">0</div></div>
      <div class="metric"><div class="label">Healthy Sites</div><div class="value" id="metricHealthy">0</div></div>
      <div class="metric"><div class="label">Runs In View</div><div class="value" id="metricRuns">0</div></div>
      <div class="metric"><div class="label">Changed URLs</div><div class="value" id="metricChanges">0</div></div>
    </div>

    <div class="grid" style="margin-top:18px;">
      <div class="stack">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Sites</h2>
              <div class="muted">Overview, health, progress, and latest run status.</div>
            </div>
            <div class="actions">
              <button id="refreshBtn">Refresh</button>
              <button id="newSiteBtn" class="primary">New Site</button>
            </div>
          </div>
          <div class="panel-body">
            <div id="siteList" class="site-list"></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Recent Runs</h2>
              <div class="muted">Latest manual and scheduled execution records.</div>
            </div>
          </div>
          <div class="panel-body">
            <div id="runList" class="run-list"></div>
          </div>
        </section>
      </div>

      <div class="stack">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Site Editor</h2>
              <div class="muted">Load an existing site, edit JSON safely, then save or delete it.</div>
            </div>
          </div>
          <div class="panel-body editor-grid">
            <div class="inline-grid">
              <div>
                <label class="muted" for="selectedSiteId">Selected Site</label>
                <input id="selectedSiteId" readonly />
              </div>
              <div>
                <label class="muted" for="explorerMode">Explorer Mode</label>
                <select id="explorerMode">
                  <option value="backup">Backup Explorer</option>
                  <option value="diff">Diff Explorer</option>
                </select>
              </div>
            </div>
            <textarea id="siteEditor" spellcheck="false"></textarea>
            <div class="actions">
              <button id="loadSiteBtn">Reload Selected</button>
              <button id="saveSiteBtn" class="primary">Save Site</button>
              <button id="deleteSiteBtn" class="warn">Delete Site</button>
              <button id="testSlackBtn">Test Slack</button>
              <button id="triggerBackupBtn">Trigger Backup</button>
              <button id="resetBackupBtn">Reset Progress</button>
              <button id="openExplorerBtn">Open Explorer</button>
            </div>
            <div class="muted small" id="editorHint">The editor accepts the same JSON shape as the API. Sensitive webhook values are omitted when loading existing sites.</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Explorer</h2>
              <div class="muted">Embedded backup and diff tools for the selected site.</div>
            </div>
          </div>
          <div class="panel-body">
            <div class="iframe-shell">
              <iframe id="explorerFrame" src="/backup/viewer"></iframe>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <script>
    const tokenStorageKey = 'backupMonitorAdminToken';
    const baseUrl = window.location.origin;
    const params = new URLSearchParams(window.location.search);
    let adminToken = localStorage.getItem(tokenStorageKey) || '';
    let selectedSiteId = '';
    let overview = [];
    let recentRuns = [];

    const tokenInput = document.getElementById('tokenInput');
    tokenInput.value = adminToken;

    function isLocalhost() {
      return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    }

    function getAuthHeaders() {
      if (!adminToken) return {};
      return { Authorization: 'Bearer ' + adminToken };
    }

    function updateAuthStatus(message) {
      const node = document.getElementById('authStatus');
      if (message) {
        node.textContent = message;
        return;
      }

      if (adminToken) {
        node.textContent = 'Token saved in this browser.';
      } else if (isLocalhost()) {
        node.textContent = 'Local development detected; token is optional.';
      } else {
        node.textContent = 'Token required for secured deployments.';
      }
    }

    function showFlash(message, kind) {
      const node = document.getElementById('flash');
      node.className = 'flash ' + kind;
      node.textContent = message;
      node.style.display = 'block';
      clearTimeout(showFlash.timer);
      showFlash.timer = setTimeout(function() {
        node.style.display = 'none';
      }, 5000);
    }

    async function fetchJson(path, options) {
      const response = await fetch(baseUrl + path, Object.assign({
        headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders())
      }, options || {}));

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

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return response.json();
      }

      return response.text();
    }

    function formatDuration(ms) {
      if (!ms) return '0s';
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + 's';
    }

    function formatRunBadge(run) {
      switch (run.status) {
        case 'success': return '<span class="badge ok">Success</span>';
        case 'partial': return '<span class="badge warn">Partial</span>';
        case 'failed': return '<span class="badge bad">Failed</span>';
        case 'running': return '<span class="badge warn">Running</span>';
        case 'noop': return '<span class="badge">No-op</span>';
        default: return '<span class="badge">' + escapeHtml(run.status) + '</span>';
      }
    }

    function renderMetrics() {
      document.getElementById('metricSites').textContent = String(overview.length);
      document.getElementById('metricHealthy').textContent = String(overview.filter(function(site) { return site.health && site.health.healthy; }).length);
      document.getElementById('metricRuns').textContent = String(recentRuns.length);
      document.getElementById('metricChanges').textContent = String(recentRuns.reduce(function(sum, run) { return sum + (run.changedUrlCount || 0); }, 0));
    }

    function renderSites() {
      const container = document.getElementById('siteList');
      if (overview.length === 0) {
        container.innerHTML = '<div class="site-card"><div class="muted">No sites configured yet.</div></div>';
        return;
      }

      container.innerHTML = overview.map(function(site) {
        const latestRun = site.latestRun;
        const healthBadge = site.health && site.health.healthy
          ? '<span class="badge ok">Healthy</span>'
          : '<span class="badge bad">Needs attention</span>';
        const latestRunBadge = latestRun ? formatRunBadge(latestRun) : '<span class="badge">No runs</span>';
        const progressBadge = site.progress && site.progress.hasMore
          ? '<span class="badge warn">' + escapeHtml(String(site.progress.percentComplete || 0)) + '% queued</span>'
          : '';

        return (
          '<button type="button" class="site-card ' + (site.id === selectedSiteId ? 'selected' : '') + '" data-site-id="' + escapeHtml(site.id) + '">' +
            '<div class="site-top">' +
              '<div>' +
                '<div class="site-name">' + escapeHtml(site.name) + '</div>' +
                '<div class="muted">' + escapeHtml(site.baseUrl) + '</div>' +
              '</div>' +
              '<div class="muted">' + escapeHtml(site.schedule) + '</div>' +
            '</div>' +
            '<div class="badge-row">' +
              healthBadge +
              latestRunBadge +
              progressBadge +
              '<span class="badge">' + escapeHtml(String(site.metrics.totalBackups || 0)) + ' backups</span>' +
              '<span class="badge">' + escapeHtml(String(site.metrics.failedBackups || 0)) + ' failures</span>' +
            '</div>' +
            '<div class="muted" style="margin-top:10px;">' + escapeHtml(site.latestSummary || 'No recent activity recorded.') + '</div>' +
          '</button>'
        );
      }).join('');

      container.querySelectorAll('.site-card').forEach(function(node) {
        node.addEventListener('click', function() {
          selectSite(node.getAttribute('data-site-id') || '');
        });
      });
    }

    function renderRuns() {
      const container = document.getElementById('runList');
      if (recentRuns.length === 0) {
        container.innerHTML = '<div class="run-card"><div class="muted">No recent runs recorded.</div></div>';
        return;
      }

      container.innerHTML = recentRuns.map(function(run) {
        const notification = run.notification && run.notification.attempted
          ? (run.notification.delivered ? 'Slack delivered' : (run.notification.throttled ? 'Slack throttled' : 'Slack failed'))
          : 'No Slack notification';

        return (
          '<div class="run-card">' +
            '<div class="run-top">' +
              '<div>' +
                '<div class="run-title">' + escapeHtml(run.siteName) + '</div>' +
                '<div class="muted">' + escapeHtml(new Date(run.startedAt).toLocaleString()) + ' • ' + escapeHtml(run.trigger) + '</div>' +
              '</div>' +
              '<div>' + formatRunBadge(run) + '</div>' +
            '</div>' +
            '<div class="badge-row">' +
              '<span class="badge">' + escapeHtml(String(run.changedUrlCount || 0)) + ' changed</span>' +
              '<span class="badge">' + escapeHtml(String(run.processedUrls || 0)) + ' processed</span>' +
              '<span class="badge">' + escapeHtml(formatDuration(run.executionTimeMs || 0)) + '</span>' +
            '</div>' +
            '<div class="muted" style="margin-top:10px;">' + escapeHtml(run.summary || '') + '</div>' +
            '<div class="muted" style="margin-top:6px;">' + escapeHtml(notification) + '</div>' +
          '</div>'
        );
      }).join('');
    }

    function selectSite(siteId) {
      selectedSiteId = siteId;
      document.getElementById('selectedSiteId').value = siteId;
      renderSites();
      loadSelectedSite();
      syncExplorer();
      updateUrlParams();
    }

    async function loadOverview() {
      overview = await fetchJson('/api/sites/overview');
      renderSites();
      renderMetrics();

      if (!selectedSiteId && overview.length > 0) {
        const requestedSiteId = params.get('siteId');
        selectSite(requestedSiteId && overview.some(function(site) { return site.id === requestedSiteId; }) ? requestedSiteId : overview[0].id);
      }
    }

    async function loadRecentRuns() {
      recentRuns = await fetchJson('/api/runs?limit=20');
      renderRuns();
      renderMetrics();
    }

    async function loadSelectedSite() {
      if (!selectedSiteId) {
        document.getElementById('siteEditor').value = JSON.stringify({
          id: '',
          name: '',
          baseUrl: 'https://example.com',
          sitemapUrl: 'https://example.com/sitemap.xml',
          retentionDays: 7,
          schedule: '0 2 * * *',
          fetchOptions: { timeout: 10000, retries: 3, concurrency: 5 },
          changeThreshold: { minChangeSize: 0, ignorePatterns: [] }
        }, null, 2);
        return;
      }

      const site = await fetchJson('/api/sites?siteId=' + encodeURIComponent(selectedSiteId) + '&includeSecrets=1');
      document.getElementById('siteEditor').value = JSON.stringify(site, null, 2);
    }

    function syncExplorer() {
      const mode = document.getElementById('explorerMode').value;
      const frame = document.getElementById('explorerFrame');
      const nextUrl = mode === 'diff'
        ? '/diff/viewer' + (selectedSiteId ? '?siteId=' + encodeURIComponent(selectedSiteId) : '')
        : '/backup/viewer' + (selectedSiteId ? '?siteId=' + encodeURIComponent(selectedSiteId) : '');
      frame.src = nextUrl;
    }

    async function saveSelectedSite() {
      const editorValue = document.getElementById('siteEditor').value.trim();
      if (!editorValue) {
        throw new Error('Site editor is empty.');
      }

      const payload = JSON.parse(editorValue);
      const isUpdate = Boolean(selectedSiteId);
      const path = isUpdate ? '/api/sites?siteId=' + encodeURIComponent(selectedSiteId) : '/api/sites';
      const method = isUpdate ? 'PUT' : 'POST';

      await fetchJson(path, {
        method,
        body: JSON.stringify(payload)
      });

      selectedSiteId = payload.id;
      showFlash('Site saved successfully.', 'success');
      await refreshAll();
      selectSite(payload.id);
    }

    async function deleteSelectedSite() {
      if (!selectedSiteId) {
        throw new Error('Select a site before deleting.');
      }

      await fetchJson('/api/sites?siteId=' + encodeURIComponent(selectedSiteId), { method: 'DELETE' });
      showFlash('Site deleted and related runtime data cleaned up.', 'success');
      selectedSiteId = '';
      await refreshAll();
      await loadSelectedSite();
      syncExplorer();
    }

    async function triggerSelectedSiteBackup() {
      if (!selectedSiteId) {
        throw new Error('Select a site before triggering a backup.');
      }

      const result = await fetchJson('/api/backup/trigger', {
        method: 'POST',
        body: JSON.stringify({ siteId: selectedSiteId, continueFromLast: true })
      });

      showFlash('Backup triggered. ' + (result.hasMore ? 'More batches remain pending.' : 'Run completed.'), 'success');
      await refreshAll();
    }

    async function resetSelectedSiteProgress() {
      if (!selectedSiteId) {
        throw new Error('Select a site before resetting progress.');
      }

      await fetchJson('/api/backup/reset', {
        method: 'POST',
        body: JSON.stringify({ siteId: selectedSiteId })
      });

      showFlash('Backup progress reset for the selected site.', 'success');
      await refreshAll();
    }

    async function testSlackNotification() {
      const editorValue = document.getElementById('siteEditor').value.trim();
      const payload = editorValue ? JSON.parse(editorValue) : {};
      const result = await fetchJson('/api/slack/test', {
        method: 'POST',
        body: JSON.stringify({ webhook: payload.slackWebhook })
      });

      showFlash(result.success ? 'Slack test notification sent.' : 'Slack test notification failed.', result.success ? 'success' : 'error');
    }

    async function refreshAll() {
      await Promise.all([loadOverview(), loadRecentRuns()]);
    }

    function updateUrlParams() {
      const nextParams = new URLSearchParams();
      if (selectedSiteId) nextParams.set('siteId', selectedSiteId);
      nextParams.set('tab', document.getElementById('explorerMode').value);
      const nextUrl = window.location.pathname + '?' + nextParams.toString();
      window.history.replaceState({}, '', nextUrl);
    }

    function escapeHtml(value) {
      const div = document.createElement('div');
      div.textContent = value == null ? '' : String(value);
      return div.innerHTML;
    }

    document.getElementById('saveTokenBtn').addEventListener('click', function() {
      adminToken = tokenInput.value.trim();
      if (adminToken) {
        localStorage.setItem(tokenStorageKey, adminToken);
      }
      updateAuthStatus();
      refreshAll().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('clearTokenBtn').addEventListener('click', function() {
      adminToken = '';
      tokenInput.value = '';
      localStorage.removeItem(tokenStorageKey);
      updateAuthStatus();
    });

    document.getElementById('refreshBtn').addEventListener('click', function() {
      refreshAll().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('newSiteBtn').addEventListener('click', function() {
      selectedSiteId = '';
      document.getElementById('selectedSiteId').value = '';
      loadSelectedSite();
      renderSites();
      syncExplorer();
      updateUrlParams();
    });

    document.getElementById('loadSiteBtn').addEventListener('click', function() {
      loadSelectedSite().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('saveSiteBtn').addEventListener('click', function() {
      saveSelectedSite().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('deleteSiteBtn').addEventListener('click', function() {
      deleteSelectedSite().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('triggerBackupBtn').addEventListener('click', function() {
      triggerSelectedSiteBackup().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('resetBackupBtn').addEventListener('click', function() {
      resetSelectedSiteProgress().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('testSlackBtn').addEventListener('click', function() {
      testSlackNotification().catch(function(error) {
        showFlash(error.message, 'error');
      });
    });

    document.getElementById('explorerMode').addEventListener('change', function() {
      syncExplorer();
      updateUrlParams();
    });

    document.getElementById('openExplorerBtn').addEventListener('click', syncExplorer);

    const requestedTab = params.get('tab');
    if (requestedTab === 'diff' || requestedTab === 'backup') {
      document.getElementById('explorerMode').value = requestedTab;
    }

    updateAuthStatus();
    refreshAll().catch(function(error) {
      showFlash(error.message, 'error');
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
    }
  });
}
