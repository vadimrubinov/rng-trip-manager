import { Router, Request, Response } from "express";

export const photoBankAdminRouter = Router();

photoBankAdminRouter.get("/photo-bank", (req: Request, res: Response) => {
  const key = req.query.key as string;
  if (!key) return res.status(401).send("Missing ?key= parameter");

  res.setHeader("Content-Type", "text/html");
  res.send(getAdminHtml(key));
});

function getAdminHtml(apiKey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo Bank Admin</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a; --text: #e1e4ed;
    --dim: #8b8fa3; --accent: #4f8cff; --green: #34d399; --red: #f87171;
    --orange: #fbbf24; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); font-size: 14px; }
  .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
  h2 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
  .subtitle { color: var(--dim); font-size: 13px; margin-bottom: 20px; }

  /* Nav */
  .nav { display: flex; gap: 8px; margin-bottom: 20px; }
  .nav-btn { padding: 8px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); cursor: pointer; font-size: 13px; }
  .nav-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .nav-btn:hover { border-color: var(--accent); }

  /* Stats bar */
  .stats-bar { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; min-width: 120px; }
  .stat-card .label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .stat-card .value.green { color: var(--green); }
  .stat-card .value.orange { color: var(--orange); }

  /* Table */
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: var(--radius); overflow: hidden; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; background: #14161e; }
  td { font-size: 13px; }
  tr:hover td { background: rgba(79,140,255,0.05); }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-done { background: rgba(52,211,153,0.15); color: var(--green); }
  .badge-progress { background: rgba(251,191,36,0.15); color: var(--orange); }
  .badge-empty { background: rgba(139,143,163,0.15); color: var(--dim); }
  .cell-ok { color: var(--green); }
  .cell-partial { color: var(--orange); }
  .cell-zero { color: var(--dim); }

  /* Buttons */
  .btn { padding: 6px 14px; border-radius: var(--radius); border: 1px solid var(--border); cursor: pointer; font-size: 12px; font-weight: 500; background: var(--surface); color: var(--text); transition: all 0.15s; }
  .btn:hover { border-color: var(--accent); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: #3d7ae8; }
  .btn-danger { background: rgba(248,113,113,0.15); border-color: var(--red); color: var(--red); }
  .btn-danger:hover { background: rgba(248,113,113,0.25); }
  .btn-success { background: rgba(52,211,153,0.15); border-color: var(--green); color: var(--green); }
  .btn-success:hover { background: rgba(52,211,153,0.25); }
  .btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Photo grid */
  .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .photo-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; position: relative; }
  .photo-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .photo-card img { width: 100%; height: 200px; object-fit: cover; cursor: pointer; display: block; }
  .photo-card .info { padding: 10px; }
  .photo-card .desc { font-size: 12px; color: var(--dim); margin-bottom: 6px; line-height: 1.4; }
  .photo-card .meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .photo-card .actions { display: flex; gap: 6px; }
  .photo-card .checkbox { position: absolute; top: 8px; left: 8px; width: 20px; height: 20px; cursor: pointer; accent-color: var(--accent); }
  .score-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; }
  .score-high { background: rgba(52,211,153,0.2); color: var(--green); }
  .score-mid { background: rgba(251,191,36,0.2); color: var(--orange); }
  .score-low { background: rgba(248,113,113,0.2); color: var(--red); }

  /* Category badges */
  .cat-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; font-weight: 600; }
  .cat-hero { background: rgba(168,85,247,0.2); color: #c084fc; }
  .cat-band { background: rgba(59,130,246,0.2); color: #93c5fd; }
  .cat-action { background: rgba(239,68,68,0.2); color: #fca5a5; }
  .cat-scenery { background: rgba(34,197,94,0.2); color: #86efac; }
  .cat-fish { background: rgba(6,182,212,0.2); color: #67e8f9; }

  /* Toolbar */
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .toolbar select, .toolbar input { padding: 6px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 13px; }
  .toolbar select { cursor: pointer; }

  /* Coverage bar */
  .coverage-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .coverage-item { font-size: 13px; }
  .coverage-item .cov-label { color: var(--dim); font-size: 11px; }

  /* Collect screen */
  .collect-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
  .collect-panel .field { margin-bottom: 12px; }
  .collect-panel label { font-size: 12px; color: var(--dim); display: block; margin-bottom: 4px; }
  .progress-row { display: flex; gap: 20px; margin-top: 12px; flex-wrap: wrap; }
  .progress-item { font-size: 13px; }
  .progress-item .p-label { color: var(--dim); font-size: 11px; }
  .progress-item .p-value { font-size: 18px; font-weight: 600; }

  /* Lightbox */
  .lightbox { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.92); z-index: 1000; display: none; flex-direction: column; align-items: center; justify-content: center; }
  .lightbox.show { display: flex; }
  .lightbox-img-wrap { position: relative; display: flex; align-items: center; justify-content: center; }
  .lightbox img { max-width: 90vw; max-height: 75vh; object-fit: contain; display: block; border-radius: 4px; }
  .lightbox-meta { margin-top: 14px; text-align: center; max-width: 90vw; }
  .lightbox-meta .lb-desc { color: #ccc; font-size: 14px; margin-bottom: 10px; line-height: 1.5; }
  .lightbox-meta .lb-badges { display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .lightbox-meta .lb-cat { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 12px; border-radius: 20px; background: var(--accent); color: #fff; }
  .lightbox-meta .lb-size { font-size: 13px; color: var(--dim); }
  .lightbox-meta .lb-status { font-size: 12px; padding: 3px 10px; border-radius: 20px; }
  .lightbox-meta .lb-status.pending { background: #2a2a1a; color: #f0c040; border: 1px solid #f0c040; }
  .lightbox-meta .lb-status.approved { background: #1a2a1a; color: #4caf50; border: 1px solid #4caf50; }
  .lightbox-actions { display: flex; gap: 14px; margin-top: 4px; }
  .lightbox-actions .btn { min-width: 120px; font-size: 15px; padding: 10px 24px; }
  .lightbox-close { position: fixed; top: 16px; right: 20px; font-size: 28px; color: #aaa; cursor: pointer; line-height: 1; z-index: 1001; }
  .lightbox-close:hover { color: #fff; }
  .lightbox-nav { position: fixed; top: 50%; transform: translateY(-50%); font-size: 36px; color: #aaa; cursor: pointer; padding: 10px; z-index: 1001; user-select: none; }
  .lightbox-nav:hover { color: #fff; }
  .lightbox-nav.prev { left: 10px; }
  .lightbox-nav.next { right: 10px; }

  /* Loading */
  .loading { text-align: center; padding: 40px; color: var(--dim); }
  .spin { display: inline-block; width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Category dropdown */
  .cat-select { padding: 2px 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 11px; cursor: pointer; }
  .cat-select:focus { border-color: var(--accent); outline: none; }

  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="container">
  <h1>Photo Bank Admin</h1>
  <p class="subtitle">Manage photo collection, moderation, and coverage</p>

  <div class="nav">
    <button class="nav-btn active" onclick="showScreen('dashboard')">Dashboard</button>
    <button class="nav-btn" onclick="showScreen('collect')">Collect</button>
    <button class="nav-btn" onclick="showScreen('moderate')">Moderate</button>
  </div>

  <!-- DASHBOARD -->
  <div id="screen-dashboard">
    <div class="stats-bar" id="dashboard-stats"></div>
    <table>
      <thead>
        <tr><th>Region</th><th>Hero (5)</th><th>Band (5)</th><th>Action (5)</th><th>Scenery (5)</th><th>Fish (5)</th><th>Total (25)</th><th>Pending</th><th>Status</th><th>Actions</th></tr>
      </thead>
      <tbody id="dashboard-table"></tbody>
    </table>
  </div>

  <!-- COLLECT -->
  <div id="screen-collect" class="hidden">
    <div class="collect-panel">
      <h2>Collect Photos by Region</h2>
      <div class="field">
        <label>Region</label>
        <select id="collect-region"><option value="">Select region...</option></select>
      </div>
      <div class="field">
        <label>Source</label>
        <select id="collect-source">
          <option value="all">All sources</option>
          <option value="md_raw">md_raw (scraped markdown)</option>
          <option value="apify">apify (lead images)</option>
          <option value="og_image">og_image (website OG)</option>
        </select>
      </div>
      <div class="field">
        <label>Target per category (scenery = target x4)</label>
        <input type="number" id="collect-target" value="5" min="1" max="50" style="width:100px;">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-primary" id="collect-start-btn" onclick="startCollect()">Start Collect</button>
        <button class="btn btn-danger hidden" id="collect-stop-btn" onclick="stopCollect()">Stop</button>
      </div>
      <div id="collect-progress" class="hidden" style="margin-top:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <div class="spin" id="collect-spinner"></div>
          <span id="collect-status-text" style="font-weight:600;">Running...</span>
        </div>
        <div class="progress-row" id="collect-progress-data"></div>
        <div id="collect-categories" style="margin-top:12px;"></div>
        <div style="margin-top:12px;">
          <button class="btn btn-success hidden" id="collect-go-moderate" onclick="goToModerate()">Go to Moderation →</button>
        </div>
      </div>
    </div>
    <div style="margin-top:16px;">
      <h2>Recent Jobs</h2>
      <table>
        <thead><tr><th>Job ID</th><th>Region</th><th>Source</th><th>Status</th><th>Uploaded</th><th>Started</th></tr></thead>
        <tbody id="collect-jobs-table"></tbody>
      </table>
    </div>
  </div>

  <!-- MODERATE -->
  <div id="screen-moderate" class="hidden">
    <div class="toolbar">
      <select id="mod-region" onchange="loadModeration()"><option value="">Select region...</option></select>
      <select id="mod-category" onchange="loadModeration()">
        <option value="">All categories</option>
        <option value="hero">Hero</option>
        <option value="band">Band</option>
        <option value="action">Action</option>
        <option value="scenery">Scenery</option>
        <option value="fish">Fish</option>
      </select>
      <select id="mod-status" onchange="loadModeration()">
        <option value="">All status</option>
        <option value="false">Pending</option>
        <option value="true">Approved</option>
      </select>
      <label style="font-size:12px;color:var(--dim);">Min score:
        <input type="number" id="mod-min-score" value="" min="1" max="10" style="width:60px;" onchange="loadModeration()">
      </label>
      <span style="flex:1;"></span>
      <button class="btn btn-success" id="mod-bulk-approve" onclick="bulkApprove()">Approve All Remaining</button>
      <button class="btn btn-danger" id="mod-bulk-delete" onclick="bulkDeleteSelected()" disabled>Delete Selected (0)</button>
    </div>
    <div class="coverage-bar" id="mod-coverage"></div>
    <div id="mod-count" style="font-size:12px;color:var(--dim);margin-bottom:8px;"></div>
    <div class="photo-grid" id="mod-grid"></div>
    <div id="mod-load-more" style="text-align:center;margin-top:16px;" class="hidden">
      <button class="btn" onclick="loadMorePhotos()">Load More</button>
    </div>
  </div>
</div>

<!-- Lightbox -->
<div class="lightbox" id="lightbox">
  <span class="lightbox-close" onclick="closeLightbox()">✕</span>
  <span class="lightbox-nav prev" onclick="lbNav(-1)">&#8249;</span>
  <span class="lightbox-nav next" onclick="lbNav(1)">&#8250;</span>
  <div class="lightbox-img-wrap">
    <img id="lightbox-img" src="">
  </div>
  <div class="lightbox-meta">
    <div class="lb-desc" id="lb-desc"></div>
    <div class="lb-badges">
      <span class="lb-cat" id="lb-cat"></span>
      <span class="score-badge" id="lb-score"></span>
      <span class="lb-size" id="lb-size"></span>
      <span class="lb-status" id="lb-status"></span>
    </div>
    <div class="lightbox-actions" id="lb-actions"></div>
  </div>
</div>

<script>
const API_BASE = '/api/photo-bank';
const API_KEY = '${apiKey}';
const TARGET_PER_CAT = 5;
const CATEGORIES = ['hero','band','action','scenery','fish'];

let currentScreen = 'dashboard';
let regions = [];
  let allRegions = [];
let selectedPhotos = new Set();
let moderationPhotos = [];
let modOffset = 0;
let modTotal = 0;
let currentCollectJobId = null;
let collectPollTimer = null;
let currentCollectRegion = '';

// ── API helper ──
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-secret': API_KEY },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(API_BASE + path, opts);
    if (!res.ok) {
      const text = await res.text();
      console.error('API error:', method, path, res.status, text);
      return { error: text, photos: [], total: 0, regions: [] };
    }
    return await res.json();
  } catch (err) {
    console.error('API fetch failed:', method, path, err);
    return { error: err.message, photos: [], total: 0, regions: [] };
  }
}

// ── Navigation ──
function showScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.nav-btn').forEach((b,i) => {
    b.classList.toggle('active', ['dashboard','collect','moderate'][i] === name);
  });
  ['dashboard','collect','moderate'].forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('hidden', s !== name);
  });
  if (name === 'dashboard') loadDashboard();
  else if (name === 'collect') loadCollectScreen();
}

// ── Dashboard ──
async function loadDashboard() {
  const data = await api('GET', '/region-stats');
  const { regions: regs, totals } = data;
  regions = regs.map(r => r.region);

  document.getElementById('dashboard-stats').innerHTML =
    stat('Total Photos', totals.total) +
    stat('Approved', totals.approved, 'green') +
    stat('Pending', totals.pending, 'orange') +
    stat('Regions', totals.regions);

  const tbody = document.getElementById('dashboard-table');
  tbody.innerHTML = regs.map(r => {
    const total = r.hero + r.band + r.action + r.scenery + r.fish;
    const target = TARGET_PER_CAT * 5;
    let status, statusClass;
    if (total >= target) { status = 'Done ✓'; statusClass = 'badge-done'; }
    else if (total > 0) { status = 'In Progress'; statusClass = 'badge-progress'; }
    else { status = 'Empty'; statusClass = 'badge-empty'; }
    return '<tr>' +
      '<td><strong>' + esc(r.region) + '</strong></td>' +
      catCell(r.hero) + catCell(r.band) + catCell(r.action) + catCell(r.scenery) + catCell(r.fish) +
      '<td>' + total + '/' + target + '</td>' +
      '<td>' + (r.pending || 0) + '</td>' +
      '<td><span class="badge ' + statusClass + '">' + status + '</span></td>' +
      '<td><button class="btn btn-sm" onclick="startCollectForRegion(\\'' + esc(r.region) + '\\')">Collect</button> ' +
      '<button class="btn btn-sm btn-primary" onclick="moderateRegion(\\'' + esc(r.region) + '\\')">Moderate</button></td>' +
      '</tr>';
  }).join('');

  populateRegionSelects();
}

function catCell(count) {
  const cls = count >= TARGET_PER_CAT ? 'cell-ok' : count > 0 ? 'cell-partial' : 'cell-zero';
  return '<td class="' + cls + '">' + count + '/' + TARGET_PER_CAT + (count >= TARGET_PER_CAT ? ' ✓' : '') + '</td>';
}

function stat(label, value, color) {
  return '<div class="stat-card"><div class="label">' + label + '</div><div class="value' + (color ? ' ' + color : '') + '">' + value + '</div></div>';
}

function populateRegionSelects() {
  const regionList = allRegions.length > 0
    ? allRegions.map(r => ({ name: r.region, label: r.region + ' (' + r.vendors_count + ' vendors)' }))
    : regions.map(r => ({ name: r, label: r }));
  ['collect-region','mod-region'].forEach(id => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    const allLabel = id === 'mod-region' ? '<option value="">All regions</option>' : '<option value="">Select region...</option>';
    sel.innerHTML = allLabel +
      regionList.map(r => '<option value="' + esc(r.name) + '"' + (r.name === cur ? ' selected' : '') + '>' + esc(r.label) + '</option>').join('');
  });
}

function startCollectForRegion(region) {
  document.getElementById('collect-region').value = region;
  showScreen('collect');
}

function moderateRegion(region) {
  document.getElementById('mod-region').value = region;
  showScreen('moderate');
  loadModeration();
}

// ── Collect ──
async function loadCollectScreen() {
  await loadAvailableRegions();
  loadCollectJobs();
}

async function loadAvailableRegions() {
  const data = await api('GET', '/available-regions');
  if (data.regions) {
    allRegions = data.regions;
    populateRegionSelects();
  }
}

async function startCollect() {
  const region = document.getElementById('collect-region').value;
  if (!region) return alert('Select a region');
  const source = document.getElementById('collect-source').value;
  const target = parseInt(document.getElementById('collect-target').value) || 5;

  currentCollectRegion = region;
  const data = await api('POST', '/collect', { source, region, target });
  if (data.error) return alert(data.error);

  currentCollectJobId = data.jobId;
  document.getElementById('collect-start-btn').disabled = true;
  document.getElementById('collect-stop-btn').classList.remove('hidden');
  document.getElementById('collect-progress').classList.remove('hidden');
  document.getElementById('collect-spinner').classList.remove('hidden');
  document.getElementById('collect-status-text').textContent = 'Running...';
  document.getElementById('collect-go-moderate').classList.add('hidden');

  pollCollectStatus();
}

function pollCollectStatus() {
  if (collectPollTimer) clearInterval(collectPollTimer);
  collectPollTimer = setInterval(async () => {
    if (!currentCollectJobId) return;
    const job = await api('GET', '/collect-status/' + currentCollectJobId);
    if (job.error) return;

    if (job.status !== 'running') {
      clearInterval(collectPollTimer);
      collectPollTimer = null;
      document.getElementById('collect-start-btn').disabled = false;
      document.getElementById('collect-stop-btn').classList.add('hidden');
      document.getElementById('collect-spinner').classList.add('hidden');
      document.getElementById('collect-status-text').textContent =
        job.status === 'done' ? 'Done ✓' : job.status === 'stopped' ? 'Stopped' : 'Error: ' + (job.error || '');
      document.getElementById('collect-go-moderate').classList.remove('hidden');
      loadCollectJobs();
    }

    if (job.result) {
      renderCollectProgress(job.result);
    }
  }, 2000);
}

function renderCollectProgress(result) {
  // result is a single CollectResult object (v3), not an array
  const agg = {
    vendors_scanned: result.vendors_scanned || 0,
    images_found: result.images_found || 0,
    ai_rejected: result.ai_rejected || 0,
    too_small: result.too_small || 0,
    ai_passed: result.ai_passed || 0,
    uploaded: result.uploaded || 0,
    errors: result.errors || 0,
  };
  // categories come from result.progress: Record<category, {collected, target, done}>
  const cats = {};
  for (const [cat, prog] of Object.entries(result.progress || {})) {
    cats[cat] = prog.collected || 0;
  }
  document.getElementById('collect-progress-data').innerHTML =
    Object.entries(agg).map(([k, v]) =>
      '<div class="progress-item"><div class="p-label">' + k.replace(/_/g, ' ') + '</div><div class="p-value">' + v + '</div></div>'
    ).join('');
  document.getElementById('collect-categories').innerHTML = Object.keys(cats).length ?
    '<div style="font-size:12px;color:var(--dim);">Categories: ' +
    Object.entries(cats).map(([c, n]) => '<span class="cat-badge cat-' + c + '">' + c + ': ' + n + '</span>').join(' ') + '</div>' : '';
}

async function stopCollect() {
  if (!currentCollectJobId) return;
  await api('POST', '/collect-stop/' + currentCollectJobId);
}

function goToModerate() {
  if (currentCollectRegion) {
    document.getElementById('mod-region').value = currentCollectRegion;
  }
  showScreen('moderate');
  loadModeration();
}

async function loadCollectJobs() {
  const jobs = await api('GET', '/collect-jobs');
  const tbody = document.getElementById('collect-jobs-table');
  tbody.innerHTML = (jobs || []).slice(0, 10).map(j => {
    const uploaded = j.result ? j.result.uploaded || 0 : '-';
    return '<tr><td style="font-size:11px;">' + esc(j.id) + '</td><td>' + esc(j.request?.region || '') +
      '</td><td>' + esc(j.request?.source || '') + '</td><td>' + j.status +
      '</td><td>' + uploaded + '</td><td style="font-size:11px;">' + fmtTime(j.started_at) + '</td></tr>';
  }).join('');
}

// ── Moderation ──
async function loadModeration() {
  const region = document.getElementById('mod-region').value;
  modOffset = 0;
  selectedPhotos.clear();
  updateBulkDeleteBtn();

  const query = buildModQuery();
  console.log('loadModeration query:', JSON.stringify({ ...query, limit: 50, offset: 0, sort_by: 'ai_score' }));
  const data = await api('POST', '/query', { ...query, limit: 50, offset: 0, sort_by: 'ai_score' });
  console.log('loadModeration response:', JSON.stringify({ total: data.total, photosCount: (data.photos||[]).length, error: data.error }));
  moderationPhotos = data.photos || [];
  modTotal = data.total || 0;
  modOffset = moderationPhotos.length;

  renderModGrid();
  loadCoverage(region);
  updateModCount();
  document.getElementById('mod-load-more').classList.toggle('hidden', modOffset >= modTotal);
}

async function loadMorePhotos() {
  const query = buildModQuery();
  const data = await api('POST', '/query', { ...query, limit: 50, offset: modOffset, sort_by: 'ai_score' });
  moderationPhotos.push(...(data.photos || []));
  modOffset = moderationPhotos.length;
  renderModGrid();
  updateModCount();
  document.getElementById('mod-load-more').classList.toggle('hidden', modOffset >= modTotal);
}

function buildModQuery() {
  const q = {};
  const region = document.getElementById('mod-region').value;
  if (region) q.region = region;
  const cat = document.getElementById('mod-category').value;
  if (cat) q.category = cat;
  const status = document.getElementById('mod-status').value;
  if (status !== '') q.approved = status === 'true';
  const minScore = parseInt(document.getElementById('mod-min-score').value);
  if (minScore > 0) q.ai_score_min = minScore;
  return q;
}

function updateModCount() {
  const showing = moderationPhotos.length;
  const total = modTotal;
  document.getElementById('mod-count').textContent = showing + ' из ' + total;
}

function renderModGrid() {
  const grid = document.getElementById('mod-grid');
  grid.innerHTML = moderationPhotos.map((p, i) => {
    const scoreClass = (p.ai_score || 0) >= 7 ? 'score-high' : (p.ai_score || 0) >= 4 ? 'score-mid' : 'score-low';
    const catClass = 'cat-' + (p.ai_category || p.category || 'scenery');
    const isSelected = selectedPhotos.has(p.id);
    return '<div class="photo-card' + (isSelected ? ' selected' : '') + '" id="card-' + p.id + '">' +
      '<input type="checkbox" class="checkbox" ' + (isSelected ? 'checked' : '') + ' onchange="toggleSelect(\\'' + p.id + '\\')">' +
      '<img src="' + esc(p.cdn_url) + '" onclick="openLightbox(' + i + ')" loading="lazy" onerror="this.src=\\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22280%22 height=%22200%22><rect fill=%22%231a1d27%22 width=%22280%22 height=%22200%22/><text fill=%22%238b8fa3%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22>Image Error</text></svg>\\'">' +
      '<div class="info">' +
      '<div class="desc">' + esc(p.ai_description || '—') + '</div>' +
      '<div style="font-size:11px;color:var(--dim);margin-bottom:5px;">' + ((p.width && p.height) ? p.width + ' × ' + p.height + ' px' : '') + '</div>' +
      '<div class="meta">' +
      '<span class="score-badge ' + scoreClass + '">' + (p.ai_score || '?') + '</span>' +
      '<select class="cat-select" onchange="changeCategory(\\'' + p.id + '\\', this.value)">' +
      CATEGORIES.map(c => '<option value="' + c + '"' + (c === (p.category || p.ai_category) ? ' selected' : '') + '>' + c + '</option>').join('') +
      '</select>' +
      (p.approved ? '<span class="badge badge-done">Approved</span>' : '<span class="badge badge-empty">Pending</span>') +
      '</div>' +
      '<div class="actions">' +
      (!p.approved ? '<button class="btn btn-success btn-sm" onclick="approveOne(\\'' + p.id + '\\')">Approve</button>' : '') +
      '<button class="btn btn-danger btn-sm" onclick="deleteOne(\\'' + p.id + '\\', ' + i + ')">Delete</button>' +
      '</div></div></div>';
  }).join('');
}

async function loadCoverage(region) {
  const data = await api('GET', '/region-stats');
  const reg = data.regions.find(r => r.region === region);
  if (!reg) { document.getElementById('mod-coverage').innerHTML = ''; return; }
  document.getElementById('mod-coverage').innerHTML = CATEGORIES.map(c => {
    const count = reg[c] || 0;
    const ok = count >= TARGET_PER_CAT;
    return '<div class="coverage-item"><div class="cov-label">' + c + '</div><div style="font-weight:600;color:' + (ok ? 'var(--green)' : count > 0 ? 'var(--orange)' : 'var(--dim)') + ';">' + count + '/' + TARGET_PER_CAT + (ok ? ' ✓' : '') + '</div></div>';
  }).join('');
}

// ── Actions ──
function toggleSelect(id) {
  if (selectedPhotos.has(id)) { selectedPhotos.delete(id); } else { selectedPhotos.add(id); }
  const card = document.getElementById('card-' + id);
  if (card) card.classList.toggle('selected', selectedPhotos.has(id));
  updateBulkDeleteBtn();
}

function updateBulkDeleteBtn() {
  const btn = document.getElementById('mod-bulk-delete');
  btn.disabled = selectedPhotos.size === 0;
  btn.textContent = 'Delete Selected (' + selectedPhotos.size + ')';
}

async function approveOne(id) {
  await api('POST', '/approve', { id, approved_by: 'vadim' });
  const p = moderationPhotos.find(x => x.id === id);
  if (p) p.approved = true;
  renderModGrid();
  loadCoverage(document.getElementById('mod-region').value);
}

async function deleteOne(id, idx) {
  await api('POST', '/reject', { id });
  moderationPhotos.splice(idx, 1);
  modTotal--;
  selectedPhotos.delete(id);
  renderModGrid();
  updateBulkDeleteBtn();
  loadCoverage(document.getElementById('mod-region').value);
  updateModCount();
}

async function bulkApprove() {
  const region = document.getElementById('mod-region').value;
  if (!region) return;
  const pending = moderationPhotos.filter(p => !p.approved);
  if (!pending.length) return alert('No pending photos');
  if (!confirm('Approve ' + pending.length + ' pending photos?')) return;

  const ids = pending.map(p => p.id);
  await api('POST', '/bulk-approve', { ids, approved_by: 'vadim' });
  for (const p of pending) p.approved = true;
  renderModGrid();
  loadCoverage(region);
}

async function bulkDeleteSelected() {
  const ids = Array.from(selectedPhotos);
  if (!ids.length) return;
  if (!confirm('Delete ' + ids.length + ' photos? This cannot be undone.')) return;

  await api('POST', '/bulk-reject', { ids });
  moderationPhotos = moderationPhotos.filter(p => !selectedPhotos.has(p.id));
  modTotal -= ids.length;
  selectedPhotos.clear();
  renderModGrid();
  updateBulkDeleteBtn();
  loadCoverage(document.getElementById('mod-region').value);
  updateModCount();
}

async function changeCategory(id, newCat) {
  await api('POST', '/update', { id, category: newCat });
  const p = moderationPhotos.find(x => x.id === id);
  if (p) p.category = newCat;
  loadCoverage(document.getElementById('mod-region').value);
}

// ── Lightbox ──
let lbIndex = -1;

function openLightbox(idx) {
  lbIndex = idx;
  renderLightbox();
  document.getElementById('lightbox').classList.add('show');
  history.pushState({ lightbox: true }, '');
}

function renderLightbox() {
  const p = moderationPhotos[lbIndex];
  if (!p) return;
  document.getElementById('lightbox-img').src = p.cdn_url;
  document.getElementById('lb-desc').textContent = p.ai_description || '—';
  document.getElementById('lb-cat').textContent = p.category || p.ai_category || '?';
  const scoreEl = document.getElementById('lb-score');
  scoreEl.textContent = p.ai_score || '?';
  scoreEl.className = 'score-badge ' + ((p.ai_score||0)>=7?'score-high':(p.ai_score||0)>=4?'score-mid':'score-low');
  document.getElementById('lb-size').textContent = (p.width && p.height) ? p.width + ' × ' + p.height + ' px' : '';
  const statusEl = document.getElementById('lb-status');
  statusEl.textContent = p.approved ? 'Approved' : 'Pending';
  statusEl.className = 'lb-status ' + (p.approved ? 'approved' : 'pending');
  const actions = document.getElementById('lb-actions');
  actions.innerHTML =
    (!p.approved ? '<button class="btn btn-success" onclick="lbApprove()">✓ Approve</button>' : '') +
    '<button class="btn btn-danger" onclick="lbDelete()">✕ Delete</button>';
}

async function lbApprove() {
  const p = moderationPhotos[lbIndex];
  if (!p || p.approved) return;
  await api('POST', '/approve', { id: p.id, approved_by: 'vadim' });
  p.approved = true;
  renderModGrid();
  lbNav(1);
}

async function lbDelete() {
  const p = moderationPhotos[lbIndex];
  if (!p) return;
  await api('POST', '/reject', { id: p.id });
  moderationPhotos.splice(lbIndex, 1);
  renderModGrid();
  if (moderationPhotos.length === 0) { closeLightbox(); return; }
  if (lbIndex >= moderationPhotos.length) lbIndex = moderationPhotos.length - 1;
  renderLightbox();
}

function lbNav(dir) {
  // Skip to next pending when navigating after action
  let next = lbIndex + dir;
  if (next < 0) next = 0;
  if (next >= moderationPhotos.length) { closeLightbox(); return; }
  lbIndex = next;
  renderLightbox();
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('show');
  document.getElementById('lightbox-img').src = '';
}
window.addEventListener('popstate', function(e) {
  if (document.getElementById('lightbox').classList.contains('show')) {
    closeLightbox();
  }
});
document.addEventListener('keydown', e => {
  if (!document.getElementById('lightbox').classList.contains('show')) return;
  if (e.key === 'Escape') { closeLightbox(); return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { lbNav(1); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { lbNav(-1); return; }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lbApprove(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); lbDelete(); return; }
});

// ── Helpers ──
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// ── Init ──
loadDashboard();
</script>
</body>
</html>`;
}
