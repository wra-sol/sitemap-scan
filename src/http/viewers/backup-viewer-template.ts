export const BACKUP_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backup Viewer - Website Backup Monitor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; height: 100vh; display: flex; flex-direction: column; }
    .header { background: white; padding: 15px 20px; border-bottom: 1px solid #e5e5e5; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    .header h1 { font-size: 20px; margin-bottom: 10px; color: #1f2937; }
    .header-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .auth-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 20px; background: #111827; color: white; }
    .auth-bar input { flex: 1 1 280px; min-width: 220px; background: #1f2937; color: white; border-color: #374151; }
    .auth-status { color: #cbd5e1; font-size: 13px; }
    .nav-links { margin-left: auto; display: flex; gap: 10px; }
    .nav-links a { color: #0066cc; text-decoration: none; font-size: 14px; padding: 6px 12px; border-radius: 4px; }
    .nav-links a:hover { background: #f0f7ff; }
    select, button, input[type="text"] { padding: 8px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; font-size: 14px; }
    select:hover, button:hover { border-color: #9ca3af; }
    select:focus, button:focus, input:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 3px rgba(0,102,204,0.1); }
    button.active { background: #0066cc; color: white; border-color: #0066cc; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .main-content { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 380px; background: white; border-right: 1px solid #e5e5e5; display: flex; flex-direction: column; }
    .sidebar-header { padding: 15px; border-bottom: 1px solid #e5e5e5; }
    .sidebar-header h2 { font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 10px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .search-box { flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
    .search-box:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 3px rgba(0,102,204,0.1); }
    .sort-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .sort-row label { font-size: 12px; color: #6b7280; white-space: nowrap; }
    .sort-row select { padding: 6px 10px; font-size: 13px; flex: 1; }
    .url-stats { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #6b7280; }
    .url-count { font-weight: 500; }
    .url-list { flex: 1; overflow-y: auto; padding: 10px; }
    .url-item { padding: 12px; margin-bottom: 8px; border-radius: 8px; border: 1px solid #e5e7eb; cursor: pointer; transition: all 0.15s; }
    .url-item:hover { border-color: #d1d5db; background: #f9fafb; }
    .url-item.selected { background: #eff6ff; border-color: #3b82f6; }
    .url-item .url-path { font-size: 13px; font-weight: 500; color: #1f2937; word-break: break-all; margin-bottom: 6px; }
    .url-item .url-meta { display: flex; gap: 8px; flex-wrap: wrap; }
    .url-item .meta-badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #f3f4f6; color: #6b7280; }
    .url-item .meta-badge.status-ok { background: #dcfce7; color: #166534; }
    .url-item .meta-badge.status-error { background: #fee2e2; color: #991b1b; }
    .pagination { display: flex; gap: 8px; justify-content: center; align-items: center; padding: 12px; border-top: 1px solid #e5e5e5; background: #fafafa; }
    .pagination button { padding: 6px 12px; font-size: 13px; }
    .pagination .page-info { font-size: 12px; color: #6b7280; }
    .content-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .content-header { padding: 15px 20px; background: white; border-bottom: 1px solid #e5e5e5; display: flex; align-items: center; gap: 15px; flex-wrap: wrap; }
    .content-header .url-display { flex: 1; font-size: 14px; color: #374151; word-break: break-all; min-width: 200px; }
    .view-toggle { display: flex; gap: 5px; }
    .view-toggle button { padding: 6px 12px; font-size: 13px; }
    .date-picker { display: flex; align-items: center; gap: 8px; }
    .date-picker label { font-size: 13px; color: #6b7280; }
    .date-picker select { padding: 6px 10px; font-size: 13px; }
    .content-body { flex: 1; overflow: hidden; position: relative; background: #fafafa; }
    .preview-frame { width: 100%; height: 100%; border: none; background: white; }
    .source-view { width: 100%; height: 100%; overflow: auto; padding: 20px; font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Consolas', monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; background: #1e1e1e; color: #d4d4d4; display: none; }
    .source-view.active { display: block; }
    .preview-frame.hidden { display: none; }
    .metadata-bar { padding: 10px 20px; background: white; border-top: 1px solid #e5e5e5; display: flex; gap: 20px; flex-wrap: wrap; font-size: 12px; color: #6b7280; }
    .metadata-item { display: flex; align-items: center; gap: 5px; }
    .metadata-item strong { color: #374151; }
    .empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: #9ca3af; font-size: 14px; flex-direction: column; gap: 10px; }
    .empty-state svg { width: 48px; height: 48px; stroke: #d1d5db; }
    .loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #6b7280; font-size: 14px; }
    .loading-inline { text-align: center; padding: 20px; color: #6b7280; }
    .error-banner { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 12px 15px; margin: 10px; border-radius: 6px; font-size: 13px; }
    @media (max-width: 768px) {
      .main-content { flex-direction: column; }
      .sidebar { width: 100%; max-height: 50vh; }
      .content-header { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Backup Viewer</h1>
    <div class="header-controls">
      <select id="siteSelect">
        <option value="">Select a site...</option>
      </select>
      <div class="nav-links">
        <a href="/app">Operator Console</a>
        <a href="/diff/viewer">Diff Viewer</a>
      </div>
    </div>
  </div>
  <div class="auth-bar">
    <strong>Admin API Token</strong>
    <input id="tokenInput" type="password" placeholder="Paste ADMIN_API_TOKEN for secured API requests" />
    <button id="saveTokenBtn">Save Token</button>
    <button id="clearTokenBtn">Clear</button>
    <span id="authStatus" class="auth-status"></span>
  </div>
  
  <div class="main-content">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2>Backed Up URLs</h2>
        <div class="search-row">
          <input type="text" class="search-box" id="searchBox" placeholder="Search URLs...">
          <button id="searchBtn">Search</button>
        </div>
        <div class="sort-row">
          <label>Sort by:</label>
          <select id="sortSelect">
            <option value="url">URL (A-Z)</option>
            <option value="url-desc">URL (Z-A)</option>
            <option value="date-desc">Last Updated (Newest)</option>
            <option value="date">Last Updated (Oldest)</option>
            <option value="size-desc">Size (Largest)</option>
            <option value="size">Size (Smallest)</option>
            <option value="status">Status</option>
          </select>
        </div>
        <div class="url-stats">
          <span class="url-count" id="urlCount">Select a site to view URLs</span>
          <span id="showingCount"></span>
        </div>
      </div>
      <div class="url-list" id="urlList">
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <span>Select a site to view backed up pages</span>
        </div>
      </div>
      <div class="pagination" id="pagination" style="display: none;">
        <button id="prevBtn" disabled>Previous</button>
        <span class="page-info" id="pageInfo">Page 1</span>
        <button id="nextBtn">Next</button>
      </div>
    </div>
    
    <div class="content-area">
      <div class="content-header" id="contentHeader" style="display: none;">
        <div class="url-display" id="urlDisplay">No URL selected</div>
        <div class="view-toggle">
          <button id="viewRendered" class="active">Rendered</button>
          <button id="viewSource">Source</button>
        </div>
        <div class="date-picker">
          <label for="dateSelect">Version:</label>
          <select id="dateSelect">
            <option value="">Select date...</option>
          </select>
        </div>
      </div>
      
      <div class="content-body" id="contentBody">
        <div class="empty-state" id="emptyState">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.64 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.64 0-8.573-3.007-9.963-7.178z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>Select a URL to view its backup</span>
        </div>
        <div class="loading" id="loading" style="display: none;">Loading...</div>
        <iframe class="preview-frame hidden" id="previewFrame" sandbox="allow-same-origin"></iframe>
        <pre class="source-view" id="sourceView"></pre>
      </div>
      
      <div class="metadata-bar" id="metadataBar" style="display: none;">
        <div class="metadata-item"><strong>Status:</strong> <span id="metaStatus">-</span></div>
        <div class="metadata-item"><strong>Size:</strong> <span id="metaSize">-</span></div>
        <div class="metadata-item"><strong>Content-Type:</strong> <span id="metaContentType">-</span></div>
        <div class="metadata-item"><strong>Timestamp:</strong> <span id="metaTimestamp">-</span></div>
      </div>
    </div>
  </div>
  
  <script>
    const baseUrl = window.location.origin;
    const PAGE_SIZE = 100;
    const tokenStorageKey = 'backupMonitorAdminToken';
    let adminToken = localStorage.getItem(tokenStorageKey) || '';
    
    let currentUrls = [];
    let totalUrls = 0;
    let currentCursor = '0';
    let nextCursor = null;
    let cursorHistory = ['0'];
    let currentPage = 1;
    let selectedUrl = null;
    let selectedUrlHash = null;
    let currentView = 'rendered';
    let backupHistory = [];
    let searchTimeout = null;
    const tokenInput = document.getElementById('tokenInput');
    tokenInput.value = adminToken;

    function isLocalhost() {
      return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
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

    function getAuthHeaders() {
      if (!adminToken) return {};
      return { Authorization: 'Bearer ' + adminToken };
    }

    async function fetchJson(path) {
      const response = await fetch(baseUrl + path, {
        headers: getAuthHeaders()
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

    // Initialize event listeners
    document.getElementById('siteSelect').addEventListener('change', () => { resetPagination(); loadUrls(); });
    document.getElementById('searchBox').addEventListener('input', debounceSearch);
    document.getElementById('searchBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') { resetPagination(); loadUrls(); } });
    document.getElementById('searchBtn').addEventListener('click', () => { resetPagination(); loadUrls(); });
    document.getElementById('sortSelect').addEventListener('change', () => { resetPagination(); loadUrls(); });
    document.getElementById('dateSelect').addEventListener('change', loadBackup);
    document.getElementById('viewRendered').addEventListener('click', () => setView('rendered'));
    document.getElementById('viewSource').addEventListener('click', () => setView('source'));
    document.getElementById('prevBtn').addEventListener('click', loadPrevPage);
    document.getElementById('nextBtn').addEventListener('click', loadNextPage);
    document.getElementById('saveTokenBtn').addEventListener('click', () => {
      adminToken = tokenInput.value.trim();
      if (adminToken) {
        localStorage.setItem(tokenStorageKey, adminToken);
      }
      updateAuthStatus();
      loadSites();
      if (document.getElementById('siteSelect').value) {
        loadUrls();
      }
    });
    document.getElementById('clearTokenBtn').addEventListener('click', () => {
      adminToken = '';
      tokenInput.value = '';
      localStorage.removeItem(tokenStorageKey);
      updateAuthStatus();
    });

    // Load sites on page load
    loadSites();

    // Check URL params for direct link
    const params = new URLSearchParams(window.location.search);
    if (params.get('siteId')) {
      setTimeout(() => {
        document.getElementById('siteSelect').value = params.get('siteId');
        loadUrls().then(() => {
          if (params.get('urlHash')) {
            const urlItem = currentUrls.find(u => u.urlHash === params.get('urlHash'));
            if (urlItem) {
              selectUrl(urlItem);
            }
          }
        });
      }, 300);
    }

    function debounceSearch() {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => { resetPagination(); loadUrls(); }, 300);
    }

    function resetPagination() {
      currentCursor = '0';
      nextCursor = null;
      cursorHistory = ['0'];
      currentPage = 1;
    }

    function getSortParams() {
      const sortValue = document.getElementById('sortSelect').value;
      const [sort, orderSuffix] = sortValue.includes('-desc') ? [sortValue.replace('-desc', ''), 'desc'] : [sortValue, 'asc'];
      return { sort, order: orderSuffix };
    }

    async function loadSites() {
      try {
        const sites = await fetchJson('/api/sites');
        const select = document.getElementById('siteSelect');
        select.innerHTML = '<option value="">Select a site...</option>';
        for (const site of sites) {
          const option = document.createElement('option');
          option.value = site.id;
          option.textContent = site.name;
          select.appendChild(option);
        }
      } catch (error) {
        showError('Failed to load sites: ' + error.message);
      }
    }

    async function loadUrls() {
      const siteId = document.getElementById('siteSelect').value;
      if (!siteId) {
        currentUrls = [];
        totalUrls = 0;
        renderUrlList([]);
        document.getElementById('urlCount').textContent = 'Select a site to view URLs';
        document.getElementById('showingCount').textContent = '';
        document.getElementById('pagination').style.display = 'none';
        return;
      }

      updateUrlParams();
      document.getElementById('urlList').innerHTML = '<div class="loading-inline">Loading URLs...</div>';
      
      try {
        const search = document.getElementById('searchBox').value;
        const { sort, order } = getSortParams();
        
        let apiUrl = baseUrl + '/api/sites/' + siteId + '/urls?limit=' + PAGE_SIZE;
        apiUrl += '&cursor=' + currentCursor;
        apiUrl += '&sort=' + sort;
        apiUrl += '&order=' + order;
        if (search) apiUrl += '&search=' + encodeURIComponent(search);
        
        const data = await fetchJson(apiUrl.replace(baseUrl, ''));
        currentUrls = data.urls;
        totalUrls = data.total;
        nextCursor = data.nextCursor;
        
        document.getElementById('urlCount').textContent = totalUrls.toLocaleString() + ' total URL' + (totalUrls !== 1 ? 's' : '');
        
        const startNum = parseInt(currentCursor) + 1;
        const endNum = Math.min(parseInt(currentCursor) + currentUrls.length, totalUrls);
        document.getElementById('showingCount').textContent = 'Showing ' + startNum + '-' + endNum;
        
        renderUrlList(currentUrls);
        updatePagination();
      } catch (error) {
        showError('Failed to load URLs: ' + error.message);
        document.getElementById('urlCount').textContent = 'Error loading URLs';
        document.getElementById('urlList').innerHTML = '<div class="empty-state"><span>Failed to load URLs</span></div>';
      }
    }

    function updatePagination() {
      const pagination = document.getElementById('pagination');
      const prevBtn = document.getElementById('prevBtn');
      const nextBtn = document.getElementById('nextBtn');
      const pageInfo = document.getElementById('pageInfo');
      
      if (totalUrls <= PAGE_SIZE) {
        pagination.style.display = 'none';
        return;
      }
      
      pagination.style.display = 'flex';
      prevBtn.disabled = currentPage === 1;
      nextBtn.disabled = !nextCursor;
      
      const totalPages = Math.ceil(totalUrls / PAGE_SIZE);
      pageInfo.textContent = 'Page ' + currentPage + ' of ' + totalPages;
    }

    function loadPrevPage() {
      if (currentPage <= 1) return;
      currentPage--;
      cursorHistory.pop();
      currentCursor = cursorHistory[cursorHistory.length - 1] || '0';
      loadUrls();
    }

    function loadNextPage() {
      if (!nextCursor) return;
      currentPage++;
      cursorHistory.push(nextCursor);
      currentCursor = nextCursor;
      loadUrls();
    }

    function renderUrlList(urls) {
      const container = document.getElementById('urlList');
      
      if (urls.length === 0) {
        container.innerHTML = '<div class="empty-state"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg><span>No URLs found</span></div>';
        return;
      }

      container.innerHTML = urls.map(u => {
        const statusClass = u.latestStatus >= 200 && u.latestStatus < 400 ? 'status-ok' : 'status-error';
        const isSelected = selectedUrlHash === u.urlHash ? 'selected' : '';
        return '<div class="url-item ' + isSelected + '" data-hash="' + u.urlHash + '" data-url="' + escapeHtml(u.url) + '">' +
          '<div class="url-path">' + escapeHtml(getDisplayUrl(u.url)) + '</div>' +
          '<div class="url-meta">' +
            '<span class="meta-badge ' + statusClass + '">' + u.latestStatus + '</span>' +
            '<span class="meta-badge">' + formatBytes(u.latestSize) + '</span>' +
            '<span class="meta-badge">' + u.latestDate + '</span>' +
          '</div>' +
        '</div>';
      }).join('');

      // Add click handlers
      container.querySelectorAll('.url-item').forEach(item => {
        item.addEventListener('click', () => {
          const urlData = urls.find(u => u.urlHash === item.dataset.hash);
          if (urlData) selectUrl(urlData);
        });
      });
    }

    async function selectUrl(urlData) {
      selectedUrl = urlData.url;
      selectedUrlHash = urlData.urlHash;
      
      // Update UI selection
      document.querySelectorAll('.url-item').forEach(el => el.classList.remove('selected'));
      const selectedEl = document.querySelector('.url-item[data-hash="' + urlData.urlHash + '"]');
      if (selectedEl) selectedEl.classList.add('selected');

      // Show content area
      document.getElementById('contentHeader').style.display = 'flex';
      document.getElementById('metadataBar').style.display = 'flex';
      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('urlDisplay').textContent = urlData.url;

      updateUrlParams();

      // Load backup history for this URL
      await loadBackupHistory(urlData.urlHash);
    }

    async function loadBackupHistory(urlHash) {
      const siteId = document.getElementById('siteSelect').value;
      showLoading(true);

      try {
        backupHistory = await fetchJson('/api/sites/' + siteId + '/backup/' + urlHash + '/history');

        const dateSelect = document.getElementById('dateSelect');
        dateSelect.innerHTML = backupHistory.map((h, i) => {
          const label = h.date + (i === 0 ? ' (latest)' : '');
          return '<option value="' + h.date + '">' + label + '</option>';
        }).join('');

        // Load the latest backup
        if (backupHistory.length > 0) {
          await loadBackup();
        }
      } catch (error) {
        showError('Failed to load backup history: ' + error.message);
      } finally {
        showLoading(false);
      }
    }

    async function loadBackup() {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      if (!siteId || !date || !selectedUrlHash) return;

      showLoading(true);

      try {
        // Update metadata from history
        const historyItem = backupHistory.find(h => h.date === date);
        if (historyItem) {
          document.getElementById('metaStatus').textContent = historyItem.status;
          document.getElementById('metaSize').textContent = formatBytes(historyItem.size);
          document.getElementById('metaContentType').textContent = historyItem.contentType;
          document.getElementById('metaTimestamp').textContent = new Date(historyItem.timestamp).toLocaleString();
        }

        if (currentView === 'rendered') {
          await loadRenderedPreview(siteId, date, selectedUrlHash);
        } else {
          await loadSourceView(siteId, date, selectedUrlHash);
        }
      } catch (error) {
        showError('Failed to load backup: ' + error.message);
      } finally {
        showLoading(false);
      }
    }

    async function loadRenderedPreview(siteId, date, urlHash) {
      const previewUrl = '/api/sites/' + siteId + '/preview/' + date + '/' + urlHash;
      const response = await fetch(baseUrl + previewUrl, {
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error('Failed to load preview');
      document.getElementById('previewFrame').srcdoc = await response.text();
      document.getElementById('previewFrame').classList.remove('hidden');
      document.getElementById('sourceView').classList.remove('active');
    }

    async function loadSourceView(siteId, date, urlHash) {
      try {
        const response = await fetch(baseUrl + '/api/sites/' + siteId + '/backup/' + date + '/' + urlHash + '/source', {
          headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to load source');
        const source = await response.text();
        document.getElementById('sourceView').textContent = source;
        document.getElementById('sourceView').classList.add('active');
        document.getElementById('previewFrame').classList.add('hidden');
      } catch (error) {
        showError('Failed to load source: ' + error.message);
      }
    }

    function setView(view) {
      currentView = view;
      document.getElementById('viewRendered').classList.toggle('active', view === 'rendered');
      document.getElementById('viewSource').classList.toggle('active', view === 'source');
      
      if (selectedUrlHash) {
        loadBackup();
      }
    }

    function showLoading(show) {
      document.getElementById('loading').style.display = show ? 'block' : 'none';
    }

    function showError(message) {
      const container = document.getElementById('urlList');
      const existing = container.querySelector('.error-banner');
      if (existing) existing.remove();
      
      const errorEl = document.createElement('div');
      errorEl.className = 'error-banner';
      errorEl.textContent = message;
      container.insertBefore(errorEl, container.firstChild);
      
      setTimeout(() => errorEl.remove(), 5000);
    }

    function updateUrlParams() {
      const siteId = document.getElementById('siteSelect').value;
      const params = new URLSearchParams();
      if (siteId) params.set('siteId', siteId);
      if (selectedUrlHash) params.set('urlHash', selectedUrlHash);
      const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState({}, '', newUrl);
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    function getDisplayUrl(url) {
      try {
        const u = new URL(url);
        return u.pathname + u.search;
      } catch {
        return url;
      }
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    updateAuthStatus();
  </script>
</body>
</html>
`;
