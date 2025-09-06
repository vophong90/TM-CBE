// js/clo-plo.js (phiên bản khớp HTML mới, không dùng LocalStorage)
// - Người dùng upload: PLO.csv, COURSE.csv, PLO–COURSE.csv, COURSE–CLO.csv, Bloom.csv
// - Xây đồ thị PLO → COURSE → CLO
// - Bộ lọc theo PLO / Course / CLO
// - GPT gợi ý & đánh giá (có fallback offline nếu không gọi được API)
// - Xuất bảng PLO–COURSE–CLO (CSV)

(function () {
  // ======= CONFIG: GPT backend (Render) =======
  const API_BASE = 'https://cm-gpt-service.onrender.com'; // đổi nếu dùng server khác
  const APP_TOKEN = ''; // điền nếu server có APP_TOKEN

  // ======= STATE =======
  let PLO = {};                // { "PLO1": "..." }
  let COURSES = {};            // { "C001": {id,label,fullname,tong,group}, ... }
  let COURSE_BY_LABEL = {};    // { "Triết học Mác-Lênin": "C001", ... }
  let EDGES_PC = [];           // [{plo, courseId, level}]
  let CLO_ITEMS = [];          // [{courseId, courseLabel, fullname, tong, clo, content}]
  let BLOOM = [];              // [{verb, level}]
  let BLOOM_BY_LEVEL = {};     // {Level:[verbs]}

  let cy = null;

  // ======= DOM =======
  // Nguồn dữ liệu
  const csvPLO = document.getElementById('csvPLO');
  const csvCOURSE = document.getElementById('csvCOURSE');
  const csvConnPloCourse = document.getElementById('csvConnPloCourse');
  const btnBuild = document.getElementById('btnBuild');
  const buildStatus = document.getElementById('buildStatus');

  const csvCourseCLO = document.getElementById('csvCourseCLO');
  const cloStatus = document.getElementById('cloStatus');

  const csvBloom = document.getElementById('csvBloom');
  const bloomStatus = document.getElementById('bloomStatus');

  // Bộ lọc
  const filterPLO = document.getElementById('filter-plo');
  const filterCourse = document.getElementById('filter-course');
  const filterCLO = document.getElementById('filter-clo');
  const btnClearFilters = document.getElementById('btnClearFilters');

  // Bảng
  const resultTable = document.getElementById('resultTable');
  const resultTableBody = resultTable?.querySelector('tbody');

  // GPT tools
  const aiPLO = document.getElementById('ai-plo');
  const aiCourse = document.getElementById('ai-course');
  const aiLevel = document.getElementById('ai-level');
  const btnAISuggest = document.getElementById('btnAISuggest');
  const aiSuggestions = document.getElementById('aiSuggestions');

  const evalPLO = document.getElementById('eval-plo');
  const evalCLO = document.getElementById('eval-clo');
  const btnAIEval = document.getElementById('btnAIEval');
  const evalResult = document.getElementById('evalResult');

  // ======= HELPERS =======
  const esc = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function __downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function csvQuote(v) {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }
  function normalizeRow(row) {
    const out = {};
    Object.keys(row).forEach(k => {
      const nk = k.replace(/^\ufeff/, '').trim().toLowerCase();
      let v = row[k];
      if (typeof v === 'string') v = v.replace(/^\ufeff/, '').trim();
      out[nk] = v;
    });
    return out;
  }
  function parseCSV(file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true, dynamicTyping: false,
        complete: res => resolve(res.data.map(normalizeRow)),
        error: reject
      });
    });
  }

  function colorForLevel(level) {
    switch ((level || '').toUpperCase()) {
      case 'I': return '#60A5FA';    // sky-400
      case 'R': return '#34D399';    // emerald-400
      case 'M': return '#FBBF24';    // amber-400
      case 'A': return '#EF4444';    // red-500
      default:  return '#94A3B8';    // slate-400
    }
  }

  // ======= BUILD FROM CSV (A. PLO / COURSE / PLO-COURSE) =======
  async function onBuildFromCsv() {
    const fP = csvPLO?.files?.[0];
    const fC = csvCOURSE?.files?.[0];
    const fE = csvConnPloCourse?.files?.[0];

    if (!fP || !fC || !fE) {
      alert('Hãy chọn đủ PLO.csv, COURSE.csv và Kết nối PLO–COURSE.csv');
      return;
    }

    const [ploRows, courseRows, edgeRows] = await Promise.all([
      parseCSV(fP), parseCSV(fC), parseCSV(fE)
    ]);

    // PLO
    PLO = {};
    ploRows.forEach(r => {
      const label = (r.label || r.plo || '').trim();
      const content = (r.content || r.desc || r.description || '').trim();
      if (label) PLO[label] = content;
    });

    // COURSE
    COURSES = {}; COURSE_BY_LABEL = {};
    courseRows.forEach(r => {
      const id = (r.id || r.code || r.label || '').trim(); // ưu tiên id
      if (!id) return;
      const label = (r.label || r.code || id).trim();
      const fullname = (r.fullname || r.name || '').trim();
      const tong = Number(r.tong ?? (Number(r.tc || 0)));
      const group = (r.group || r.nhom || '').trim();
      COURSES[id] = { id, label, fullname, tong, group };
      if (label) COURSE_BY_LABEL[label] = id;
    });

    // PLO–COURSE edges
    EDGES_PC = [];
    edgeRows.forEach(r => {
      const plo = (r.plo_label || r.plo || '').trim();
      let cid = (r.course_id || r.course || r.id || '').trim();
      const lvl = (r.level || '').trim().toUpperCase() || 'I';
      if (!plo) return;
      // Nếu course_id trống, thử map theo label
      if (!cid && r.course_label) {
        const tryId = COURSE_BY_LABEL[(r.course_label || '').trim()];
        if (tryId) cid = tryId;
      }
      if (!cid) return;
      if (!PLO[plo] || !COURSES[cid]) return;
      EDGES_PC.push({ plo, courseId: cid, level: ['I', 'R', 'M', 'A'].includes(lvl) ? lvl : 'I' });
    });

    buildStatus.textContent =
      `Đã nạp: ${Object.keys(PLO).length} PLO • ${Object.keys(COURSES).length} Course • ${EDGES_PC.length} liên kết PLO–COURSE.`;

    // Sau khi dựng A, làm mới UI
    rebuildAll();
  }

  // ======= COURSE–CLO CSV (B) =======
  async function onLoadCourseCLO(file) {
    if (!Object.keys(COURSES).length) {
      cloStatus.textContent = '⚠️ Vui lòng xây đồ thị A (PLO/COURSE/kết nối) trước để map CLO.';
      return;
    }
    const rows = await parseCSV(file);
    CLO_ITEMS = [];
    let ok = 0, miss = 0;

    rows.forEach(r => {
      const courseLabel = (r.label || '').trim();
      const fullname = (r.fullname || '').trim();
      const tong = Number(r.tong || 0);
      const clo = (r.clo || '').trim();
      const content = (r.content || '').trim();
      if (!courseLabel || !clo) return;

      const tryId = COURSES[courseLabel] ? courseLabel : (COURSE_BY_LABEL[courseLabel] || '');
      const courseId = tryId || '';
      if (!courseId) { miss++; return; }

      CLO_ITEMS.push({ courseId, courseLabel, fullname, tong, clo, content });
      ok++;
    });

    cloStatus.textContent = `Đã nạp ${ok} CLO${miss ? ` (bỏ ${miss} do không khớp course)` : ''}.`;
    rebuildAll();
  }

  // ======= Bloom verbs (C) =======
  async function onLoadBloom(file) {
    const rows = await parseCSV(file);
    BLOOM = [];
    BLOOM_BY_LEVEL = {};
    rows.forEach(r => {
      const v = (r.verb || '').trim();
      const lvl = (r.level || '').trim();
      if (!v || !lvl) return;
      BLOOM.push({ verb: v, level: lvl });
      BLOOM_BY_LEVEL[lvl] = BLOOM_BY_LEVEL[lvl] || [];
      BLOOM_BY_LEVEL[lvl].push(v);
    });
    bloomStatus.textContent = `Đã nạp Bloom verbs: ${BLOOM.length} động từ / ${Object.keys(BLOOM_BY_LEVEL).length} mức.`;
  }

  // ======= UI: filters / dropdowns =======
  function rebuildFilters() {
    function setOpts(select, arr, firstLabel) {
      if (!select) return;
      const cur = select.value;
      select.innerHTML = '';
      const first = document.createElement('option');
      first.value = ''; first.textContent = firstLabel;
      select.appendChild(first);
      arr.forEach(v => {
        const o = document.createElement('option');
        o.value = v.value; o.textContent = v.label;
        select.appendChild(o);
      });
      const exists = Array.from(select.options).some(o => o.value === cur);
      if (exists) select.value = cur;
    }

    setOpts(filterPLO,
      Object.keys(PLO).map(l => ({ value: l, label: l })),
      '— Tất cả PLO —'
    );

    const coursesList = Object.values(COURSES)
      .map(c => ({ value: c.id, label: `${c.label} — ${c.fullname || ''}`.trim() }))
      .sort((a, b) => a.label.localeCompare(b.label));
    setOpts(filterCourse, coursesList, '— Tất cả Course —');

    const cloSet = new Set(CLO_ITEMS.map(x => x.clo));
    const cloList = Array.from(cloSet).sort().map(c => ({ value: c, label: c }));
    setOpts(filterCLO, cloList, '— Tất cả CLO —');

    // AI dropdowns
    setOpts(aiPLO, Object.keys(PLO).map(l => ({ value: l, label: l })), '— chọn PLO —');
    setOpts(aiCourse, coursesList, '— chọn Course —');
    setOpts(evalPLO, Object.keys(PLO).map(l => ({ value: l, label: l })), '— chọn PLO —');
  }

  // ======= Cytoscape =======
  function buildElementsByFilters() {
    const fPLO = filterPLO?.value || '';
    const fCourse = filterCourse?.value || '';
    const fCLO = filterCLO?.value || '';

    const elements = [];
    const nodeSet = new Set();
    const edgeSet = new Set();

    const addNode = (id, data) => {
      if (nodeSet.has(id)) return;
      nodeSet.add(id);
      elements.push({ data: { id, ...data } });
    };
    const addEdge = (id, data) => {
      if (edgeSet.has(id)) return;
      edgeSet.add(id);
      elements.push({ data: { id, ...data } });
    };

    const coursesOfCLO = {};
    CLO_ITEMS.forEach(it => {
      (coursesOfCLO[it.clo] = coursesOfCLO[it.clo] || new Set()).add(it.courseId);
    });

    EDGES_PC.forEach(e => {
      if (fPLO && e.plo !== fPLO) return;
      if (fCourse && e.courseId !== fCourse) return;
      if (fCLO && !(coursesOfCLO[fCLO]?.has(e.courseId))) return;

      addNode(`PLO::${e.plo}`, {
        kind: 'PLO', label: e.plo, content: PLO[e.plo] || ''
      });

      const c = COURSES[e.courseId];
      if (!c) return;
      addNode(`COURSE::${c.id}`, {
        kind: 'COURSE', id: c.id, label: c.label || c.id,
        fullname: c.fullname || '', tong: c.tong || 0
      });

      addEdge(`E_PC::${e.plo}__${c.id}`, {
        source: `PLO::${e.plo}`, target: `COURSE::${c.id}`,
        level: e.level, kind: 'PC'
      });

      CLO_ITEMS.forEach(it => {
        if (it.courseId !== c.id) return;
        if (fCLO && it.clo !== fCLO) return;
        addNode(`CLO::${c.id}::${it.clo}`, {
          kind: 'CLO', clo: it.clo, content: it.content || ''
        });
        addEdge(`E_CC::${c.id}__${it.clo}`, {
          source: `COURSE::${c.id}`, target: `CLO::${c.id}::${it.clo}`, kind: 'CC'
        });
      });
    });

    return elements;
  }

  function createCy() {
    const container = document.getElementById('cy');
    if (!container) return;
    if (cy) cy.destroy();

    cy = cytoscape({
      container,
      elements: buildElementsByFilters(),
      style: [
        {
          selector: 'node[kind="PLO"]', style: {
            'shape': 'round-rectangle', 'background-color': '#CFE8FF',
            'border-color': '#0E7BD0', 'border-width': 1.2,
            'label': 'data(label)', 'font-size': 10, 'text-valign': 'center',
            'text-wrap': 'wrap', 'text-max-width': 140
          }
        },
        {
          selector: 'node[kind="COURSE"]', style: {
            'shape': 'round-rectangle', 'background-color': '#FFE7A8',
            'border-color': '#B7791F', 'border-width': 1.2,
            'label': 'data(label)', 'font-size': 10, 'text-valign': 'center',
            'text-wrap': 'wrap', 'text-max-width': 140
          }
        },
        {
          selector: 'node[kind="CLO"]', style: {
            'shape': 'ellipse', 'background-color': '#E5E7EB',
            'border-color': '#6B7280', 'border-width': 1,
            'label': 'data(clo)', 'font-size': 10
          }
        },
        {
          selector: 'edge[kind="PC"]', style: {
            'width': 3, 'curve-style': 'bezier',
            'line-color': ele => colorForLevel(ele.data('level')),
            'target-arrow-color': ele => colorForLevel(ele.data('level')),
            'target-arrow-shape': 'triangle'
          }
        },
        {
          selector: 'edge[kind="CC"]', style: {
            'width': 2, 'curve-style': 'bezier',
            'line-color': '#94A3B8', 'target-arrow-color': '#94A3B8', 'target-arrow-shape': 'triangle'
          }
        },
        { selector: '.dim', style: { 'opacity': 0.12 } },
        { selector: '.hl', style: { 'border-width': 2, 'background-blacken': -0.1 } }
      ],
      layout: { name: 'cose', animate: true, nodeRepulsion: 14000, idealEdgeLength: 120, padding: 30 },
      wheelSensitivity: 0.2
    });

    // Tooltip dùng #tooltip có sẵn trong HTML
    const tip = document.getElementById('tooltip');
    if (tip) {
      cy.on('mouseover', 'node', (evt) => {
        const n = evt.target;
        let html = '';
        if (n.data('kind') === 'PLO') {
          html = `<b>${esc(n.data('label'))}</b><br>${esc(n.data('content') || '')}`;
        } else if (n.data('kind') === 'COURSE') {
          html = `<b>${esc(n.data('label'))}</b> — ${esc(n.data('fullname') || '')}<br>TC: ${esc(n.data('tong') || 0)}`;
        } else {
          html = `<b>${esc(n.data('clo'))}</b><br>${esc(n.data('content') || '')}`;
        }
        tip.innerHTML = html; tip.style.display = 'block';
      });
      cy.on('mouseout', 'node', () => { tip.style.display = 'none'; });
      cy.on('mousemove', (evt) => {
        if (tip.style.display === 'block') {
          tip.style.left = (evt.originalEvent.pageX + 12) + 'px';
          tip.style.top = (evt.originalEvent.pageY + 12) + 'px';
        }
      });
    }

    // Highlight theo node
    cy.on('tap', 'node', (evt) => {
      const n = evt.target;
      cy.elements().addClass('dim');
      n.removeClass('dim');
      n.connectedEdges().removeClass('dim');
      n.connectedEdges().connectedNodes().removeClass('dim').addClass('hl');
      setTimeout(() => cy.elements('.hl').removeClass('hl'), 600);
    });
    cy.on('tap', (evt) => { if (evt.target === cy) cy.elements().removeClass('dim'); });

    // Cho phép HTML gốc gọi fit/screenshot (đã có script ở file .html)
    window.cy = cy;
  }

  // ======= TABLE =======
  function rebuildTable() {
    ensureTableToolbar();

    const fP = filterPLO?.value || '';
    const fC = filterCourse?.value || '';
    const fL = filterCLO?.value || '';

    if (!resultTableBody) return;
    resultTableBody.innerHTML = '';

    if (!EDGES_PC.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="border p-2 text-gray-500" colspan="4"><i>Hãy nạp dữ liệu A (PLO/COURSE/kết nối) rồi bấm “Xây đồ thị”.</i></td>`;
      resultTableBody.appendChild(tr);
      return;
    }

    const cloMap = {};
    CLO_ITEMS.forEach(it => {
      (cloMap[it.courseId] = cloMap[it.courseId] || []).push(it);
    });

    const rows = [];
    EDGES_PC.forEach(e => {
      if (fP && e.plo !== fP) return;
      if (fC && e.courseId !== fC) return;

      const course = COURSES[e.courseId];
      if (!course) return;

      const list = (cloMap[course.id] || []);
      const cloFiltered = fL ? list.filter(x => x.clo === fL) : list;
      if (cloFiltered.length === 0) return;

      cloFiltered.forEach(ci => {
        rows.push({
          plo: e.plo,
          ploContent: PLO[e.plo] || '',
          courseId: course.id,
          courseLabel: course.label,
          courseFull: course.fullname || '',
          level: e.level,
          clo: ci.clo,
          cloContent: ci.content || ''
        });
      });
    });

    rows.sort((a, b) =>
      a.plo.localeCompare(b.plo) ||
      a.courseLabel.localeCompare(b.courseLabel) ||
      a.clo.localeCompare(b.clo)
    );

    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="border p-2 text-gray-500" colspan="4"><i>Không có kết quả (có thể do chưa nạp COURSE–CLO.csv hoặc bộ lọc đang quá hẹp).</i></td>`;
      resultTableBody.appendChild(tr);
      return;
    }

    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="border p-2 align-top">
          <div class="font-medium">${esc(r.plo)}</div>
          <div class="text-xs text-gray-600">${esc(r.ploContent)}</div>
        </td>
        <td class="border p-2 align-top">${esc(r.courseLabel)} — ${esc(r.courseFull)}</td>
        <td class="border p-2 align-top">
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-white text-xs font-semibold"
                style="background:${colorForLevel(r.level)}">${esc(r.level || '')}</span>
        </td>
        <td class="border p-2 align-top">
          <div class="font-medium">${esc(r.clo)}</div>
          <div class="text-xs text-gray-600">${esc(r.cloContent)}</div>
        </td>
      `;
      resultTableBody.appendChild(tr);
    });
  }

  // Toolbar cho bảng (thêm nút Export CSV)
  function ensureTableToolbar(){
    if (!resultTable || resultTable.__toolbarReady) return;
    const wrapCard = resultTable.closest('.card');
    if (!wrapCard) return;
    const head = document.createElement('div');
    head.className = 'flex items-center justify-end mb-2 gap-2';
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline';
    btn.textContent = 'Xuất bảng (CSV)';
    btn.addEventListener('click', exportMatrixCsv);
    head.appendChild(btn);
    wrapCard.insertBefore(head, wrapCard.firstChild);
    resultTable.__toolbarReady = true;
  }

  // Xuất CSV: PLO, PLO_content, Course_label, Course_fullname, Level, CLO, CLO_content
  function exportMatrixCsv(){
    const fP = filterPLO?.value || '';
    const fC = filterCourse?.value || '';
    const fL = filterCLO?.value || '';

    const cloMap = {};
    CLO_ITEMS.forEach(it => {
      (cloMap[it.courseId] = cloMap[it.courseId] || []).push(it);
    });

    const headers = ['plo','plo_content','course_label','course_fullname','level','clo','clo_content'];
    const lines = [headers.join(',')];

    EDGES_PC.forEach(e=>{
      if (fP && e.plo !== fP) return;
      if (fC && e.courseId !== fC) return;
      const course = COURSES[e.courseId]; if (!course) return;

      const list = (cloMap[course.id] || []).filter(ci => !fL || ci.clo === fL);
      if (list.length === 0) return;

      list.forEach(ci=>{
        lines.push([
          csvQuote(e.plo),
          csvQuote(PLO[e.plo] || ''),
          csvQuote(course.label),
          csvQuote(course.fullname || ''),
          csvQuote(e.level || ''),
          csvQuote(ci.clo),
          csvQuote(ci.content || '')
        ].join(','));
      });
    });

    const csv = '\ufeff' + lines.join('\r\n');
    __downloadText('plo_course_clo_table.csv', csv);
  }

  // ======= GPT CALLERS (Render) =======
  async function gptCall(kind, payload) {
    const url = `${API_BASE}/api/${kind}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(APP_TOKEN ? { 'Authorization': `Bearer ${APP_TOKEN}` } : {})
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      let msg = '';
      try { msg = await res.text(); } catch { }
      throw new Error(`GPT API error: ${res.status} ${msg}`);
    }
    return await res.json();
  }

  const LEVEL2BLOOM = {
    I: ['Remember', 'Understand'],
    R: ['Apply', 'Analyze'],
    M: ['Analyze', 'Evaluate'],
    A: ['Evaluate', 'Create']
  };
  function pickVerbs(level, n = 6) {
    const levels = LEVEL2BLOOM[level] || [];
    const pool = [];
    levels.forEach(lv => (BLOOM_BY_LEVEL[lv] || []).forEach(v => pool.push({ verb: v, level: lv })));
    if (pool.length === 0) ['Describe', 'Explain', 'Apply', 'Analyze', 'Evaluate', 'Create']
      .forEach(v => pool.push({ verb: v, level: '*' }));
    const out = [];
    const used = new Set();
    for (let i = 0; i < pool.length && out.length < Math.min(n, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const key = pool[idx].verb.toLowerCase();
      if (used.has(key)) continue;
      used.add(key); out.push(pool[idx]);
    }
    return out;
  }

  // Tính CLO code tiếp theo (nếu cần)
  function nextCLOCode(courseId){
    const cur = CLO_ITEMS.filter(x => x.courseId === courseId);
    let maxN = 0;
    cur.forEach(x=>{
      const m = String(x.clo||'').match(/CLO\s*0*(\d+)/i);
      if (m) { const n = parseInt(m[1],10); if (n>maxN) maxN = n; }
    });
    return `CLO${maxN+1}`;
  }

  function addCLO(courseId, text, explicitCLO){
    if (!COURSES[courseId]) return false;
    const cloCode = explicitCLO || nextCLOCode(courseId);
    const courseLabel = COURSES[courseId].label;
    const fullname = COURSES[courseId].fullname || '';
    const tong = COURSES[courseId].tong || 0;
    CLO_ITEMS.push({ courseId, courseLabel, fullname, tong, clo: cloCode, content: text });
    rebuildAll();
    return true;
  }

  // GỢI Ý CLO
  async function suggestCLO() {
    const plo = aiPLO?.value; const courseId = aiCourse?.value; const level = aiLevel?.value || 'I';
    if (!plo || !courseId) return alert('Chọn PLO và Course trước.');
    const ploText = PLO[plo] || '';
    const course = COURSES[courseId] || {};

    aiSuggestions.innerHTML = '<li class="text-gray-500">Đang gọi GPT…</li>';
    try {
      const gpt = await gptCall('suggest', {
        plo, ploText, course, level, bloomVerbs: BLOOM, count: 6
      });

      const items = (gpt && Array.isArray(gpt.items) && gpt.items.length)
        ? gpt.items
        : pickVerbs(level, 5).map((v,i)=>`CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo yêu cầu ${plo} (${v.level}).`);

      aiSuggestions.innerHTML = '';
      items.forEach(text=>{
        const li = document.createElement('li');
        li.className = 'flex items-start justify-between gap-2';
        const span = document.createElement('span');
        span.textContent = text;
        const add = document.createElement('button');
        add.className = 'btn btn-outline';
        add.textContent = '+ Thêm';
        add.title = 'Thêm CLO này vào dữ liệu';
        add.addEventListener('click', ()=>{
          const ok = addCLO(courseId, text);
          if (!ok) alert('Không thể thêm CLO. Kiểm tra Course.');
        });
        li.appendChild(span); li.appendChild(add);
        aiSuggestions.appendChild(li);
      });
    } catch (err) {
      aiSuggestions.innerHTML = '';
      const ideas = pickVerbs(level, 5).map((v,i)=>`CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo yêu cầu ${plo} (${v.level}).`);
      ideas.forEach(text=>{
        const li = document.createElement('li'); li.textContent = text; aiSuggestions.appendChild(li);
      });
      console.warn('GPT suggest fallback:', err?.message || err);
    }
  }

  // ĐÁNH GIÁ CLO ↔ PLO
  async function evaluateCLO() {
    const plo = evalPLO?.value; const cloText = (evalCLO?.value || '').trim();
    if (!plo || !cloText) return alert('Chọn PLO và nhập CLO.');
    const ploText = PLO[plo] || '';
    if (evalResult) evalResult.textContent = 'Đang gọi GPT…';
    try {
      const gpt = await gptCall('evaluate', { plo, ploText, cloText });
      if (gpt && gpt.text) { if (evalResult) evalResult.textContent = gpt.text; return; }
      throw new Error('Empty GPT text');
    } catch (err) {
      // Fallback heuristic
      function keywords(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || []; }
      const kp = new Set(keywords(ploText));
      const kc = keywords(cloText);
      let overlap = 0; kc.forEach(w => { if (kp.has(w)) overlap++; });
      const score = Math.min(100, Math.round((overlap / Math.max(4, kp.size || 1)) * 100));
      const verdict = score >= 70 ? 'Rất phù hợp' : score >= 40 ? 'Tương đối phù hợp' : 'Chưa phù hợp';
      if (evalResult) {
        evalResult.textContent =
          `Điểm tương đồng (heuristic): ${score}/100 → ${verdict}.
Gợi ý: nhấn mạnh từ khoá PLO trong CLO, làm rõ động từ Bloom và tiêu chí đo lường.`;
      }
      console.warn('GPT evaluate fallback:', err?.message || err);
    }
  }

  // ======= RENDER + WIRING =======
  function rebuildAll() {
    rebuildFilters();
    createCy();
    rebuildTable();
  }

  document.addEventListener('DOMContentLoaded', () => {
    // A. Build từ CSV
    btnBuild?.addEventListener('click', () => {
      onBuildFromCsv().catch(err => alert('Không đọc được CSV: ' + err));
    });

    // B. COURSE–CLO.csv
    csvCourseCLO?.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      onLoadCourseCLO(f).catch(err => alert('Không đọc được CSV COURSE–CLO: ' + err));
    });

    // C. Bloom verbs
    csvBloom?.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      onLoadBloom(f).catch(err => alert('Không đọc được CSV Bloom: ' + err));
    });

    // Bộ lọc
    [filterPLO, filterCourse, filterCLO].forEach(sel =>
      sel?.addEventListener('change', () => { createCy(); rebuildTable(); })
    );
    btnClearFilters?.addEventListener('click', () => {
      if (filterPLO) filterPLO.value = '';
      if (filterCourse) filterCourse.value = '';
      if (filterCLO) filterCLO.value = '';
      createCy(); rebuildTable();
    });

    // GPT tools
    btnAISuggest?.addEventListener('click', suggestCLO);
    btnAIEval?.addEventListener('click', evaluateCLO);

    // Fit & Screenshot (nếu có nút trong HTML)
  document.getElementById('btnFit')?.addEventListener('click', () => {
    window.cy?.fit();
  });
  document.getElementById('btnScreenshot')?.addEventListener('click', () => {
    if (!window.cy) return;
    const png64 = window.cy.png({ bg: 'white', full: true, scale: 2 });
    const a = document.createElement('a');
    a.href = png64; a.download = 'CLO-PLO-graph.png';
    a.click();
  });
    
    // Khởi tạo rỗng
    rebuildAll();
  });
})();
