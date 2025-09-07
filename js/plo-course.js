/* =========================
   PLO–Course logic (v2)
   Khớp với plo-course.html mới
   ========================= */

let cy;                          // cytoscape instance
let selectedEdge = null;         // cạnh đang chọn
let undoStack = [];              // hoàn tác xoá cạnh

// Dữ liệu sau khi nạp CSV
let PLO_LABELS = {};             // { "PLO1": "content...", ... }
let PLO_KEYS   = [];             // ["PLO1","PLO2",...]
let HP_INFO    = {};             // { "HP001": {label, fullname, group, credit?}, ... }
let centralityChart = null;
let irmaPie = null;

// Tạm giữ dòng CSV đã parse
let _ploRows = null, _courseRows = null;

// Màu theo group học phần (tuỳ chỉnh nếu muốn)
const groupColors = {
  'Đại cương': '#BADBFF',
  'Cơ sở ngành': '#B5E6C9',
  'Ngành': '#FFE58A',
  'Định hướng chuyên ngành': '#CE93D8',
  'Tốt nghiệp': '#EF9A9A'
};

// -------------------------- Helpers --------------------------
function parseCsvFromInput(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: res => resolve(res.data),
      error: reject
    });
  });
}

// Brand-ish màu edge theo level
function levelColor(level) {
  // I: xám; R: brand; M: accent; A: đỏ
  return {
    I: '#94A3B8',     // slate-400
    R: '#2D8FE8',     // brand-500
    M: '#FFC21E',     // accent-400
    A: '#EF4444'      // red-500
  }[level] || '#888';
}

function csvQuote(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g,'""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function normalizeKey(s) {
  if (s == null) return '';
  return String(s).normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
}

// -------------------------- Build Graph --------------------------
function buildElements() {
  const ploNodes = PLO_KEYS.map(p => ({ data: { id: p, label: p } }));
  const courseNodes = Object.keys(HP_INFO).map(cid => ({
    data: { id: cid, label: HP_INFO[cid].label || cid },
    classes: HP_INFO[cid].group
  }));
  return [...ploNodes, ...courseNodes];
}

function createCy(elements) {
  if (cy) {
     cy.destroy();
     window.cy = null;
  }
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: [
      { selector: 'node', style: {
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'color': '#0f172a', // slate-900
        'font-size': '11px',
        'background-color': ele => {
          const id = ele.id();
          if (PLO_LABELS[id]) return '#D8ECFF'; // PLO: brand-100
          if (HP_INFO[id])   return groupColors[HP_INFO[id].group] || '#EEF7FF';
          return '#e5e7eb';
        },
        'border-width': 1,
        'border-color': '#e5e7eb'
      }},
      { selector: 'edge', style: {
        'width': 3,
        'label': 'data(level)',
        'font-size': 12,
        'color': '#0f172a',
        'line-color': ele => levelColor(ele.data('level')),
        'target-arrow-shape': 'triangle',
        'target-arrow-color': ele => levelColor(ele.data('level')),
        'curve-style': 'bezier',
        'text-background-color': '#ffffff',
        'text-background-opacity': 1,
        'text-background-padding': 2
      }},
      { selector: '.node-dimmed', style: { 'opacity': 0.12 } },
      { selector: '.edge-dimmed', style: { 'opacity': 0.05 } },
      { selector: '.edge.selected', style: { 'line-color': '#ef4444', 'target-arrow-color': '#ef4444', 'width': 4 } },
    ],
    layout: {
      name: 'cose',
      animate: true,
      nodeRepulsion: 12000,
      idealEdgeLength: 120,
      edgeElasticity: 0.2,
      gravity: 1,
      numIter: 2000,
      fit: true,
      padding: 40
    }
  });

  wireCyEvents();
  refreshUIAfterGraphChange();
   window.cy = cy;
}

// -------------------------- Events --------------------------
function wireCyEvents() {
  const tooltip = document.getElementById('tooltip');

  cy.on('tap', 'edge', function(evt) {
    if (selectedEdge) selectedEdge.removeClass('selected');
    selectedEdge = evt.target;
    selectedEdge.addClass('selected');
    const sel = document.getElementById('level-select');
    if (sel) sel.value = selectedEdge.data('level') || 'I';
  });

  cy.on('tap', function(evt){
    if (evt.target === cy) {
      cy.nodes().removeClass('node-dimmed'); cy.edges().removeClass('edge-dimmed');
      if (selectedEdge) { selectedEdge.removeClass('selected'); selectedEdge = null; }
    }
  });

  cy.on('tap', 'node', function(evt){
    const sel = evt.target;
    cy.nodes().addClass('node-dimmed'); cy.edges().addClass('edge-dimmed');
    sel.removeClass('node-dimmed');
    sel.connectedEdges().forEach(edge => {
      edge.removeClass('edge-dimmed');
      edge.source().removeClass('node-dimmed');
      edge.target().removeClass('node-dimmed');
    });
  });

  cy.on('mouseover', 'node', function(evt){
    const node = evt.target;
    const id = node.id();
    if (PLO_LABELS[id]) {
      tooltip.innerHTML = `<strong>${id}</strong><br>${PLO_LABELS[id]}`;
    } else if (HP_INFO[id]) {
      const { label, fullname, group } = HP_INFO[id];
      tooltip.innerHTML =
        `<strong>${fullname || label || id}</strong><br>` +
        `Mã: ${id}${label ? ` — ${label}` : ''}<br>` +
        `Nhóm: ${group || ''}`;
    }
    tooltip.style.display = 'block';
  });
  cy.on('mouseout', 'node', () => tooltip.style.display = 'none');
  cy.on('mousemove', evt => {
    if (tooltip.style.display === 'block') {
      tooltip.style.left = (evt.originalEvent.pageX + 10) + 'px';
      tooltip.style.top  = (evt.originalEvent.pageY + 10) + 'px';
    }
  });

  // update bảng/biểu đồ khi có thay đổi
  cy.on('add remove data', () => refreshUIAfterGraphChange());
}

// -------------------------- UI Refresh --------------------------
function refreshUIAfterGraphChange() {
  populateDropdowns();
  buildMatrixHeader();
  updateSummaryTable();
  updateMatrixTable();

  // Charts / Flow (debounce ngắn)
  setTimeout(() => {
    analyzeCentrality();
    renderIrmaPieChart();
    renderFlowDiagram();
  }, 0);
}

function populateDropdowns() {
  const ploAdd = document.getElementById('plo-add');
  const hpAdd  = document.getElementById('hp-add');
  const ploFlowSelect = document.getElementById('plo-flow-select');

  if (ploAdd) ploAdd.innerHTML = '';
  if (hpAdd)  hpAdd.innerHTML  = '';

  if (ploFlowSelect) {
    const cur = ploFlowSelect.value;
    ploFlowSelect.innerHTML = '<option value="">-- Chọn một PLO --</option>';
    PLO_KEYS.forEach(p => {
      const o = document.createElement('option');
      o.value = o.textContent = p;
      if (p === cur) o.selected = true;
      ploFlowSelect.appendChild(o);
    });
  }

  PLO_KEYS.forEach(p => {
    const o = document.createElement('option');
    o.value = o.textContent = p;
    ploAdd?.appendChild(o);
  });

  Object.keys(HP_INFO).forEach(cid => {
    const o = document.createElement('option');
    const txt = `${cid} — ${HP_INFO[cid].label || HP_INFO[cid].fullname || cid}`;
    o.value = cid; o.textContent = txt;
    hpAdd?.appendChild(o);
  });
}

function buildMatrixHeader() {
  const thead = document.querySelector('#matrixTable thead');
  if (!thead) return;
  const cols = ['<th class="border p-2">Course (fullname)</th>'].concat(
    PLO_KEYS.map(p => `<th class="border p-2">${p}</th>`)
  );
  thead.innerHTML = `<tr class="text-left">${cols.join('')}</tr>`;
}

// Tổng hợp số I/R/M/A theo course
function updateSummaryTable() {
  const counts = {};  // { courseId: {I,R,M,A} }
  cy?.edges().forEach(e => {
    const cid = e.data('target'); // target = Course id
    const level = e.data('level');
    if (!counts[cid]) counts[cid] = { I:0, R:0, M:0, A:0 };
    if (['I','R','M','A'].includes(level)) counts[cid][level]++;
  });

  const tbody = document.querySelector('#summaryTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  Object.keys(HP_INFO).forEach(cid => {
    const info = HP_INFO[cid] || {};
    const full = info.fullname || info.label || cid;
    const row = counts[cid] || { I:0, R:0, M:0, A:0 };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="border p-2">${full}</td>
      <td class="border p-2 text-center">${info.credit ?? ''}</td>
      <td class="border p-2 text-center">${row.I}</td>
      <td class="border p-2 text-center">${row.R}</td>
      <td class="border p-2 text-center">${row.M}</td>
      <td class="border p-2 text-center">${row.A}</td>`;
    tbody.appendChild(tr);
  });
}

// Ma trận PLO × Course (ô = level)
function updateMatrixTable() {
  const matrix = {}; // { courseId: { PLO: level } }
  cy?.edges().forEach(e => {
    const plo = e.data('source');   // PLO
    const cid = e.data('target');   // Course id
    const lv  = e.data('level');
    if (!matrix[cid]) matrix[cid] = {};
    matrix[cid][plo] = lv;
  });

  const tbody = document.querySelector('#matrixTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  Object.keys(HP_INFO).forEach(cid => {
    const info = HP_INFO[cid] || {};
    const full = info.fullname || info.label || cid;
    const rowMap = matrix[cid] || {};
    const tds = PLO_KEYS.map(p => `<td class="border p-2 text-center">${rowMap[p] || ''}</td>`).join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="border p-2">${full}</td>${tds}`;
    tbody.appendChild(tr);
  });
}

// -------------------------- Build from CSV Inputs --------------------------
async function bootFromCsvInputs() {
  const fPlo = document.getElementById('ploCsvInput')?.files?.[0];
  const fCourse = document.getElementById('courseCsvInput')?.files?.[0];
  if (!fPlo || !fCourse) { alert('Hãy chọn đủ PLO.csv và COURSE.csv'); return; }

  _ploRows = await parseCsvFromInput(fPlo);
  _courseRows = await parseCsvFromInput(fCourse);

  // PLO
  PLO_LABELS = {}; PLO_KEYS = [];
  _ploRows.forEach(r => {
    const label = (r.label || r.LABEL || '').trim();
    const content = (r.content || r.CONTENT || '').trim();
    if (label) { PLO_LABELS[label] = content; PLO_KEYS.push(label); }
  });

  // COURSE
  HP_INFO = {};
  _courseRows.forEach(r => {
    const id = (r.id || r.ID || '').trim();
    if (!id) return;
    HP_INFO[id] = {
      label:    (r.label || r.LABEL || '').trim(),
      fullname: (r.fullname || r.FULLNAME || '').trim(),
      group:    (r.group || r.GROUP || '').trim(),
      credit:   (r.credit || r.CREDIT || '').toString().trim() || undefined
    };
  });

  // Create graph (nodes only, chưa có edges)
  createCy(buildElements());
  document.getElementById('buildStatus').textContent = 'Đã dựng đồ thị từ CSV.';
}

// -------------------------- Connection Ops --------------------------
function addConnection() {
  if (!cy) return;
  const plo = document.getElementById('plo-add').value; // PLO label
  const cid = document.getElementById('hp-add').value;  // Course id
  const lvl = (document.getElementById('level-add').value || 'I').toUpperCase();
  if (!plo || !cid) { alert('Chọn PLO và Course trước.'); return; }

  if (!PLO_LABELS[plo]) { alert('PLO không tồn tại.'); return; }
  if (!HP_INFO[cid])    { alert('Course không tồn tại.'); return; }

  const id = `e_${plo}_${cid}`;
  if (cy.getElementById(id).length) { alert('Kết nối đã tồn tại.'); return; }
  cy.add({ data: { id, source: plo, target: cid, level: lvl, label: lvl }});
  cy.layout({ name: 'cose', animate: true }).run();
}

function updateSelectedEdgeLevel() {
  if (!selectedEdge) { alert('Chưa chọn cạnh nào.'); return; }
  const lv = (document.getElementById('level-select').value || 'I').toUpperCase();
  selectedEdge.data('level', lv);
  selectedEdge.data('label', lv);
}

function deleteSelectedEdge() {
  if (!selectedEdge) { alert('Chưa chọn cạnh nào.'); return; }
  undoStack.push(selectedEdge.json());
  selectedEdge.remove();
  selectedEdge = null;
}

function undoDelete() {
  const last = undoStack.pop();
  if (!last) { alert('Không có thao tác xoá gần đây.'); return; }
  cy.add(last);
  cy.layout({ name: 'cose', animate: true }).run();
}

// -------------------------- Import/Export connections (CSV) --------------------------
function exportConnectionsCSV() {
  if (!cy) return;
  const rows = cy.edges().map(e => ({
    plo:    e.data('source'),   // PLO label
    course: e.data('target'),   // Course id
    level:  e.data('level') || ''
  }));
  const heads = ['plo','course','level'];
  const csv = '\ufeff' + [
    heads.join(','),
    ...rows.map(r => heads.map(h => csvQuote(r[h])).join(','))
  ].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'plo_course_connections.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importConnectionsCSV(file) {
  const data = await new Promise((resolve, reject) => {
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: res => resolve(res.data), error: reject });
  });

  // Xoá edges cũ
  cy.edges().remove();

  // Chuẩn bị map fullname->id (để chấp nhận CSV dùng fullname)
  const fullnameToId = {};
  Object.keys(HP_INFO).forEach(cid => {
    const full = HP_INFO[cid]?.fullname || '';
    if (full) fullnameToId[normalizeKey(full)] = cid;
  });

  data.forEach(r => {
    const plo = (r.plo || r.PLO || r.plo_label || r.PLO_LABEL || '').trim();
    // Ưu tiên id: course/course_id/id
    let cid = (r.course || r.course_id || r.id || '').trim();
    // nếu không có id, thử fullname
    if (!cid) {
      const fullname = (r.fullname || r.course_name || r['Tên Học phần'] || '').trim();
      const key = normalizeKey(fullname);
      if (key && fullnameToId[key]) cid = fullnameToId[key];
    }
    const lv  = (r.level || r.LEVEL || '').trim().toUpperCase() || 'I';

    if (!plo || !cid) return;
    if (!PLO_LABELS[plo] || !HP_INFO[cid]) return;

    const id = `e_${plo}_${cid}`;
    if (!cy.getElementById(id).length) {
      cy.add({ data: { id, source: plo, target: cid, level: lv, label: lv }});
    }
  });

  cy.layout({ name: 'cose', animate: true }).run();
}

// -------------------------- Centrality (compute + chart) --------------------------
function analyzeCentrality() {
  if (!cy) return;

  const nodeIds = cy.nodes().map(n => n.id());
  const adj = {};
  nodeIds.forEach(id => adj[id] = new Set());
  cy.edges().forEach(e => {
    const s = e.data('source');
    const t = e.data('target');
    adj[s]?.add(t);
    adj[t]?.add(s);
  });

  // Degree
  const degree = {};
  nodeIds.forEach(id => degree[id] = adj[id].size);

  // Betweenness (Brandes)
  const betweenness = {};
  nodeIds.forEach(v => betweenness[v] = 0);

  nodeIds.forEach(s => {
    const S = [];
    const P = {};
    const sigma = {};
    const dist = {};
    nodeIds.forEach(v => { P[v] = []; sigma[v] = 0; dist[v] = -1; });
    sigma[s] = 1; dist[s] = 0;
    const Q = [s];

    while (Q.length) {
      const v = Q.shift();
      S.push(v);
      adj[v].forEach(w => {
        if (dist[w] < 0) { dist[w] = dist[v] + 1; Q.push(w); }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; P[w].push(v); }
      });
    }

    const delta = {};
    nodeIds.forEach(v => delta[v] = 0);
    while (S.length) {
      const w = S.pop();
      P[w].forEach(v => { delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]); });
      if (w !== s) betweenness[w] += delta[w];
    }
  });

  // Normalize betweenness
  const n = nodeIds.length;
  const denom = (n - 1) * (n - 2) / 2;
  const normBet = {};
  nodeIds.forEach(v => { normBet[v] = denom > 0 ? betweenness[v] / denom : 0; });

  // Closeness (harmonic)
  const closeness = {};
  nodeIds.forEach(v => {
    const dist = {};
    nodeIds.forEach(u => dist[u] = -1);
    const Q = [v]; dist[v] = 0;
    while (Q.length) {
      const x = Q.shift();
      adj[x].forEach(y => { if (dist[y] < 0) { dist[y] = dist[x] + 1; Q.push(y); } });
    }
    let sum = 0;
    nodeIds.forEach(u => { if (u !== v && dist[u] > 0) sum += 1 / dist[u]; });
    closeness[v] = sum;
  });

  // Eigenvector (power iteration)
  const eigen = {};
  nodeIds.forEach(v => eigen[v] = 1);
  let delta = 1, iter = 0;
  while (delta > 1e-6 && iter < 200) {
    const next = {};
    let norm = 0;
    nodeIds.forEach(v => {
      let s = 0; adj[v].forEach(w => { s += eigen[w]; });
      next[v] = s; norm += s * s;
    });
    norm = Math.sqrt(norm) || 1;
    delta = 0;
    nodeIds.forEach(v => {
      next[v] = next[v] / norm;
      delta = Math.max(delta, Math.abs(next[v] - eigen[v]));
      eigen[v] = next[v];
    });
    iter++;
  }

  // Chuẩn bị dữ liệu cho chart
  const result = nodeIds.map(id => ({
    id,
    // Hiển thị label ngắn cho chart để không quá dài
    label: cy.getElementById(id).data('label') || id,
    degree: degree[id] || 0,
    betweenness: normBet[id] || 0,
    closeness: closeness[id] || 0,
    eigenvector: eigen[id] || 0
  }));

  window.centralityData = result;
  renderCentralityChart();
}

function renderCentralityChart() {
  const data = window.centralityData || [];
  const sel = document.getElementById('centrality-select');
  if (!sel) return;
  const metric = sel.value || 'degree';

  const canvas = document.getElementById('centrality-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (centralityChart) centralityChart.destroy();

  const labels = data.map(d => d.label);
  const buildDS = (key, label) => ({
    label,
    data: data.map(d => d[key]),
    borderWidth: 1
  });

  let datasets = [];
  if (metric === 'all') {
    datasets = [
      buildDS('degree','degree'),
      buildDS('betweenness','betweenness'),
      buildDS('closeness','closeness'),
      buildDS('eigenvector','eigenvector'),
    ];
  } else {
    datasets = [buildDS(metric, metric)];
  }

  // Gọi hàm đặt min-width để có scrollbar ngang (đã khai báo trong HTML)
  if (typeof window.resizeCentralityCanvas === 'function') {
    window.resizeCentralityCanvas(labels.length);
  }

  centralityChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' }, title: { display: false } },
      scales: {
        x: { ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 } },
        y: { beginAtZero: true }
      }
    }
  });
}

// -------------------------- IRMA Pie --------------------------
function renderIrmaPieChart() {
  const counts = { I:0, R:0, M:0, A:0 };
  cy?.edges().forEach(e => {
    const lv = (e.data('level') || '').toUpperCase();
    if (counts[lv] !== undefined) counts[lv]++;
  });

  const ctx = document.getElementById('irma-pie')?.getContext('2d');
  if (!ctx) return;
  if (irmaPie) irmaPie.destroy();

  irmaPie = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: ['I','R','M','A'],
      datasets: [{ data: [counts.I, counts.R, counts.M, counts.A] }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

// -------------------------- Flow theo PLO --------------------------
function renderFlowDiagram() {
  const plo = document.getElementById('plo-flow-select')?.value || '';
  const container = document.getElementById('flow-diagram');
  if (!container) return;
  container.innerHTML = '';
  if (!plo) return;

  const stages = { I: [], R: [], M: [], A: [] };
  cy?.edges().forEach(e => {
    if (e.data('source') === plo) {
      const cid = e.data('target');
      const lv  = e.data('level');
      const full = HP_INFO[cid]?.fullname || HP_INFO[cid]?.label || cid;
      if (stages[lv]) stages[lv].push(full);
    }
  });

  const titles = { I: 'Giới thiệu (I)', R: 'Phát triển (R)', M: 'Hỗ trợ mạnh (M)', A: 'Đánh giá (A)' };
  const wrap = document.createElement('div');
  wrap.className = 'grid md:grid-cols-4 gap-3';
  ['I','R','M','A'].forEach(lv => {
    const col = document.createElement('div');
    col.className = 'rounded-xl border p-3 bg-gray-50';
    col.innerHTML = `<div class="font-semibold mb-1">${titles[lv]}</div>` +
      (stages[lv].length ? stages[lv].map(x => `<div>• ${x}</div>`).join('') : '<i>Không có</i>');
    wrap.appendChild(col);
  });
  container.appendChild(wrap);
}

// -------------------------- Wire DOM --------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Build graph từ CSV
  document.getElementById('btnBuild')?.addEventListener('click', bootFromCsvInputs);

  // Thêm / sửa / xoá kết nối
  document.getElementById('btnAdd')?.addEventListener('click', addConnection);
  document.getElementById('btnUpdateLevel')?.addEventListener('click', updateSelectedEdgeLevel);
  document.getElementById('btnDelete')?.addEventListener('click', deleteSelectedEdge);
  document.getElementById('btnUndo')?.addEventListener('click', undoDelete);

  // Xuất / Nhập CSV kết nối
  document.getElementById('btnExportConnCSV')?.addEventListener('click', exportConnectionsCSV);
  document.getElementById('connCsvInput')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (!cy) { alert('Hãy dựng đồ thị từ CSV trước.'); e.target.value=''; return; }
    importConnectionsCSV(f)
      .catch(err => alert('Không đọc được CSV kết nối: ' + err))
      .finally(() => { e.target.value=''; });
  });

  // Centrality metric selector
  document.getElementById('centrality-select')?.addEventListener('change', renderCentralityChart);

  // Flow selector
  document.getElementById('plo-flow-select')?.addEventListener('change', renderFlowDiagram);

  // Các nút tiện ích đồ thị (nếu có)
  document.getElementById('btnFit')?.addEventListener('click', ()=> { if (window.cy) window.cy.fit(); });
  document.getElementById('btnScreenshot')?.addEventListener('click', ()=> {
    if (window.cy){
      const png64 = window.cy.png({bg:'white', full:true, scale:2});
      const a = document.createElement('a'); a.href = png64; a.download = 'PLO-Course-graph.png'; a.click();
    }
  });
});
