// js/clo-plo.js (nâng cấp)
// - Gọi GPT qua Render
// - Thêm "+ Thêm vào dữ liệu" từ gợi ý GPT
// - Xuất bảng (CSV) PLO–COURSE–CLO
// - Tải mẫu CSV cho Bloom & Course–CLO
// - Xoá CLO ngay từ bảng

(function () {
  // ======= CONFIG: GPT backend (Render) =======
  const API_BASE = 'https://cm-gpt-service.onrender.com'; // đổi nếu khác
  const APP_TOKEN = ''; // điền nếu server có APP_TOKEN

  // ======= STATE =======
  let PLO = {};                // { "PLO1": "..." }
  let COURSES = {};            // { "C001": {id,label,fullname,tong,...}, ... }
  let COURSE_BY_LABEL = {};    // { "Triết học": "C001", ... }
  let EDGES_PC = [];           // [{plo, courseId, level}]
  let CLO_ITEMS = [];          // [{courseId, courseLabel, fullname, tong, clo, content}]
  let BLOOM = [];              // [{verb, level}]
  let BLOOM_BY_LEVEL = {};     // {Level:[verbs]}

  let cy = null;

  // ======= DOM =======
  const lsSummary = document.getElementById('lsSummary');
  const btnLoadFromLS = document.getElementById('btnLoadFromLS');
  const btnClearLS = document.getElementById('btnClearLS');

  const csvCourseCLO = document.getElementById('csvCourseCLO');
  const btnExportCLO = document.getElementById('btnExportCLO');
  const cloStatus = document.getElementById('cloStatus');

  const csvBloom = document.getElementById('csvBloom');
  const bloomStatus = document.getElementById('bloomStatus');

  const filterPLO = document.getElementById('filter-plo');
  const filterCourse = document.getElementById('filter-course');
  const filterCLO = document.getElementById('filter-clo');
  const btnClearFilters = document.getElementById('btnClearFilters');

  const resultTable = document.getElementById('resultTable');
  const resultTableBody = resultTable.querySelector('tbody');

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

  // ======= LOCAL STORAGE LOADING =======
  function loadFromLocalStorage() {
    // PLO
    const ploCandidates = ['CM_PLO', 'PLO_DATA', '__PLO_LIST__'];
    let ploArr = null;
    for (const k of ploCandidates) {
      const raw = localStorage.getItem(k);
      if (raw) { try { ploArr = JSON.parse(raw); break; } catch { } }
    }
    PLO = {};
    if (Array.isArray(ploArr)) {
      ploArr.forEach(r => {
        const label = (r.label || r.PLO || r.plo || '').trim();
        const content = (r.content || r.desc || r.description || '').trim();
        if (label) PLO[label] = content;
      });
    }

    // COURSES
    const courseCandidates = ['CM_COURSE', 'COURSE_DATA', '__COURSE_LIST__'];
    let courseArr = null;
    for (const k of courseCandidates) {
      const raw = localStorage.getItem(k);
      if (raw) { try { courseArr = JSON.parse(raw); break; } catch { } }
    }
    COURSES = {}; COURSE_BY_LABEL = {};
    if (Array.isArray(courseArr)) {
      courseArr.forEach(r => {
        const id = (r.id || r.courseId || r.ID || r.code || r.label || '').trim();
        const label = (r.label || r.code || id).trim();
        const fullname = (r.fullname || r.name || '').trim();
        const tong = Number(r.tong ?? (Number(r.lt || 0) + Number(r.th || 0)));
        if (id) {
          COURSES[id] = { id, label, fullname, tong, group: r.group || '', khoi: r.khoi || '', type: r.type || '' };
          if (label) COURSE_BY_LABEL[label] = id;
        }
      });
    }

    // PLO–COURSE edges
    const edgeCandidates = ['CM_PLO_COURSE', 'PLO_COURSE_EDGES', '__PLO_COURSE_EDGES__'];
    let edges = null;
    for (const k of edgeCandidates) {
      const raw = localStorage.getItem(k);
      if (raw) { try { edges = JSON.parse(raw); break; } catch { } }
    }
    EDGES_PC = [];
    if (Array.isArray(edges)) {
      edges.forEach(e => {
        const plo = (e.plo || e.PLO || '').trim();
        const cid = (e.courseId || e.course || e.id || '').trim();
        const level = (e.level || e.Level || '').trim().toUpperCase();
        if (plo && (cid || COURSE_BY_LABEL[e.courseLabel || ''])) {
          EDGES_PC.push({ plo, courseId: cid || COURSE_BY_LABEL[e.courseLabel || ''], level });
        }
      });
    }

    // CLO cache
    try {
      const raw = localStorage.getItem('CM_COURSE_CLO');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) CLO_ITEMS = arr;
      }
    } catch { }

    // Tóm tắt
    lsSummary.textContent = `PLO: ${Object.keys(PLO).length} • Course: ${Object.keys(COURSES).length} • Liên kết PLO–COURSE: ${EDGES_PC.length} • CLO: ${CLO_ITEMS.length}`;
  }

  function persistCLOToLS() {
    try {
      localStorage.setItem('CM_COURSE_CLO', JSON.stringify(CLO_ITEMS));
    } catch { }
  }

  // ======= COURSE–CLO CSV =======
  async function onLoadCourseCLO(file) {
    const rows = await parseCSV(file);
    CLO_ITEMS = [];
    let ok = 0, miss = 0;

    rows.forEach(r => {
      const courseLabel = (r.label || '').trim();
      const fullname = (r.fullname || '').trim();
      const tong = Number(r.tong || 0);
      const clo = (r.clo || r.CLO || '').trim();
      const content = (r.content || '').trim();
      if (!courseLabel || !clo) return;

      // map theo label hoặc id
      const tryId = COURSES[courseLabel] ? courseLabel : (COURSE_BY_LABEL[courseLabel] || '');
      const courseId = tryId || '';
      if (!courseId) { miss++; return; }

      CLO_ITEMS.push({ courseId, courseLabel, fullname, tong, clo, content });
      ok++;
    });

    cloStatus.textContent = `Đã nạp ${ok} CLO (bỏ ${miss} do không khớp course).`;
    persistCLOToLS();
    rebuildAll();
  }

  function exportCourseCLOCsv() {
    const headers = ['label', 'fullname', 'tong', 'clo', 'content'];
    const lines = [headers.join(',')];
    const labelById = (id) => COURSES[id]?.label || id;

    CLO_ITEMS.forEach(it => {
      const row = [
        csvQuote(labelById(it.courseId)),
        csvQuote(it.fullname || COURSES[it.courseId]?.fullname || ''),
        csvQuote(it.tong ?? COURSES[it.courseId]?.tong ?? ''),
        csvQuote(it.clo),
        csvQuote(it.content)
      ];
      lines.push(row.join(','));
    });

    const csv = '\ufeff' + lines.join('\r\n');
    __downloadText('course_clo.csv', csv);
  }

  // ======= Bloom verbs =======
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

    setOpts(filterPLO, Object.keys(PLO).map(l => ({ value: l, label: l })), '— Tất cả PLO —');

    const coursesList = Object.values(COURSES).map(c => ({
      value: c.id, label: `${c.label} — ${c.fullname || ''}`.trim()
    })).sort((a, b) => a.label.localeCompare(b.label));
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
  function colorForLevel(level) {
    switch ((level || '').toUpperCase()) {
      case 'I': return '#60A5FA';
      case 'R': return '#34D399';
      case 'M': return '#FBBF24';
      case 'A': return '#EF4444';
      default: return '#94A3B8';
    }
  }

  function buildElementsByFilters() {
    const fPLO = filterPLO.value || '';
    const fCourse = filterCourse.value || '';
    const fCLO = filterCLO.value || '';

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

      addNode(`PLO::${e.plo}`, { kind: 'PLO', label: e.plo, content: PLO[e.plo] || '' });

      const c = COURSES[e.courseId];
      if (!c) return;
      addNode(`COURSE::${c.id}`, { kind: 'COURSE', id: c.id, label: c.label || c.id, fullname: c.fullname || '', tong: c.tong || 0 });

      addEdge(`E_PC::${e.plo}__${c.id}`, { source: `PLO::${e.plo}`, target: `COURSE::${c.id}`, level: e.level, kind: 'PC' });

      CLO_ITEMS.forEach(it => {
        if (it.courseId !== c.id) return;
        if (fCLO && it.clo !== fCLO) return;
        addNode(`CLO::${c.id}::${it.clo}`, { kind: 'CLO', clo: it.clo, content: it.content || '' });
        addEdge(`E_CC::${c.id}__${it.clo}`, { source: `COURSE::${c.id}`, target: `CLO::${c.id}::${it.clo}`, kind: 'CC' });
      });
    });

    return elements;
  }

  function createCy() {
    if (cy) cy.destroy();
    const elements = buildElementsByFilters();

    cy = cytoscape({
      container: document.getElementById('cy'),
      elements,
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
      layout: { name: 'cose', animate: true, nodeRepulsion: 14000, idealEdgeLength: 120, padding: 30 }
    });

    bindCyEvents();
  }

  function bindCyEvents() {
    const tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;display:none;background:#fff;border:1px solid #e5e7eb;padding:8px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08);font-size:12px;max-width:420px;z-index:50;';
    tip.id = 'cloTip'; document.body.appendChild(tip);

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

    cy.on('tap', 'node', (evt) => {
      const n = evt.target;
      cy.elements().addClass('dim');
      n.removeClass('dim');
      n.connectedEdges().removeClass('dim');
      n.connectedEdges().connectedNodes().removeClass('dim').addClass('hl');
      setTimeout(() => cy.elements('.hl').removeClass('hl'), 600);
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) cy.elements().removeClass('dim');
    });
  }

  // ======= TABLE =======
  function rebuildTable() {
    ensureTableToolbar();
    const fP = filterPLO.value || '';
    const fC = filterCourse.value || '';
    const fL = filterCLO.value || '';

    resultTableBody.innerHTML = '';

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

      const thisCLOs = cloMap[course.id] || [];
      const cloFiltered = fL ? thisCLOs.filter(x => x.clo === fL) : thisCLOs;

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

    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="border p-2 align-top">
          <div class="font-medium">${esc(r.plo)}</div>
          <div class="text-xs text-gray-600">${esc(r.ploContent)}</div>
        </td>
        <td class="border p-2 align-top">${esc(r.courseLabel)} — ${esc(r.courseFull)}</td>
        <td class="border p-2 align-top">
          <span class="badge" style="background:${colorForLevel(r.level)};border-color:transparent;color:#fff">${esc(r.level || '')}</span>
        </td>
        <td class="border p-2 align-top">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="font-medium">${esc(r.clo)}</div>
              <div class="text-xs text-gray-600">${esc(r.cloContent)}</div>
            </div>
            <button class="btn btn-ghost" title="Xoá CLO này" data-del data-course="${esc(r.courseId)}" data-clo="${esc(r.clo)}">✕</button>
          </div>
        </td>
      `;
      resultTableBody.appendChild(tr);
    });

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="border p-2 text-gray-500" colspan="4"><i>Không có kết quả phù hợp bộ lọc.</i></td>`;
      resultTableBody.appendChild(tr);
    }

    // Xoá CLO handler
    resultTableBody.querySelectorAll('button[data-del]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const cid = btn.getAttribute('data-course');
        const clo = btn.getAttribute('data-clo');
        deleteCLO(cid, clo);
      });
    });
  }

  // Xoá CLO theo courseId + clo (xoá 1 bản ghi đầu tiên khớp)
  function deleteCLO(courseId, cloCode){
    const idx = CLO_ITEMS.findIndex(x => x.courseId === courseId && x.clo === cloCode);
    if (idx >= 0) {
      CLO_ITEMS.splice(idx, 1);
      persistCLOToLS();
      rebuildAll();
    }
  }

  // Toolbar cho bảng (thêm nút Export CSV)
  function ensureTableToolbar(){
    if (resultTable.__toolbarReady) return;
    const wrapCard = resultTable.closest('.card');
    if (!wrapCard) return;
    const head = document.createElement('div');
    head.className = 'flex items-center justify-end mb-2 gap-2';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Xuất bảng (CSV)';
    btn.addEventListener('click', exportMatrixCsv);
    head.appendChild(btn);
    wrapCard.insertBefore(head, wrapCard.firstChild);
    resultTable.__toolbarReady = true;
  }

  // Xuất CSV: PLO, PLO_content, Course_label, Course_fullname, Level, CLO, CLO_content (theo bộ lọc hiện tại)
  function exportMatrixCsv(){
    const fP = filterPLO.value || '';
    const fC = filterCourse.value || '';
    const fL = filterCLO.value || '';

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
    if (pool.length === 0) ['Describe', 'Explain', 'Apply', 'Analyze', 'Evaluate', 'Create'].forEach(v => pool.push({ verb: v, level: '*' }));
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

  // Tính CLO code tiếp theo cho 1 học phần
  function nextCLOCode(courseId){
    const cur = CLO_ITEMS.filter(x => x.courseId === courseId);
    let maxN = 0;
    cur.forEach(x=>{
      const m = String(x.clo||'').match(/CLO\s*0*(\d+)/i);
      if (m) { const n = parseInt(m[1],10); if (n>maxN) maxN = n; }
    });
    return `CLO${maxN+1}`;
  }

  // Thêm CLO item
  function addCLO(courseId, text, explicitCLO){
    if (!COURSES[courseId]) return false;
    const cloCode = explicitCLO || nextCLOCode(courseId);
    const courseLabel = COURSES[courseId].label;
    const fullname = COURSES[courseId].fullname || '';
    const tong = COURSES[courseId].tong || 0;
    CLO_ITEMS.push({ courseId, courseLabel, fullname, tong, clo: cloCode, content: text });
    persistCLOToLS();
    rebuildAll();
    return true;
  }

  // GỢI Ý CLO
  async function suggestCLO() {
    const plo = aiPLO.value; const courseId = aiCourse.value; const level = aiLevel.value || 'I';
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

      // Render kèm nút + Thêm
      aiSuggestions.innerHTML = '';
      items.forEach(text=>{
        const li = document.createElement('li');
        li.className = 'flex items-start justify-between gap-2';
        const span = document.createElement('span');
        span.textContent = text;
        const add = document.createElement('button');
        add.className = 'btn btn-ghost';
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
    const plo = evalPLO.value; const cloText = (evalCLO.value || '').trim();
    if (!plo || !cloText) return alert('Chọn PLO và nhập CLO.');
    const ploText = PLO[plo] || '';
    evalResult.textContent = 'Đang gọi GPT…';
    try {
      const gpt = await gptCall('evaluate', { plo, ploText, cloText });
      if (gpt && gpt.text) { evalResult.textContent = gpt.text; return; }
      throw new Error('Empty GPT text');
    } catch (err) {
      function keywords(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || []; }
      const kp = new Set(keywords(ploText));
      const kc = keywords(cloText);
      let overlap = 0; kc.forEach(w => { if (kp.has(w)) overlap++; });
      const score = Math.min(100, Math.round((overlap / Math.max(4, kp.size)) * 100));
      const verdict = score >= 70 ? 'Rất phù hợp' : score >= 40 ? 'Tương đối phù hợp' : 'Chưa phù hợp';
      evalResult.textContent =
        `Điểm tương đồng (heuristic): ${score}/100 → ${verdict}.
Gợi ý: nhấn mạnh từ khoá PLO trong CLO, làm rõ động từ Bloom và tiêu chí đo lường.`;
      console.warn('GPT evaluate fallback:', err?.message || err);
    }
  }

  // ======= TEMPLATE CSV =======
  function attachTemplateButtons(){
    // Bloom panel
    if (csvBloom && !csvBloom.__tmpl){
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost'; btn.textContent = 'Tải mẫu CSV Bloom';
      btn.addEventListener('click', ()=>{
        const sample = [
          'verb,level',
          'define,Remember',
          'describe,Understand',
          'apply,Apply',
          'analyze,Analyze',
          'evaluate,Evaluate',
          'create,Create'
        ].join('\r\n');
        __downloadText('bloom_verbs_template.csv', sample);
      });
      csvBloom.parentElement?.insertAdjacentElement('afterend', btn);
      csvBloom.__tmpl = true;
    }

    // Course–CLO panel
    if (csvCourseCLO && !csvCourseCLO.__tmpl){
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost'; btn.textContent = 'Tải mẫu CSV COURSE–CLO';
      btn.addEventListener('click', ()=>{
        const sample = [
          'label,fullname,tong,clo,content',
          'C041,Y học gia đình,2,CLO1,"Áp dụng quy trình chẩn đoán ban đầu cho người bệnh tại cộng đồng."',
          'C041,Y học gia đình,2,CLO2,"Phân tích yếu tố nguy cơ và đề xuất can thiệp phù hợp."'
        ].join('\r\n');
        __downloadText('course_clo_template.csv', sample);
      });
      csvCourseCLO.parentElement?.insertAdjacentElement('afterend', btn);
      csvCourseCLO.__tmpl = true;
    }
  }

  // ======= RENDER + WIRING =======
  function rebuildAll() {
    rebuildFilters();
    createCy();
    rebuildTable();
  }

  // ======= EVENTS =======
  document.addEventListener('DOMContentLoaded', () => {
    loadFromLocalStorage();
    attachTemplateButtons();
    rebuildAll();

    btnLoadFromLS?.addEventListener('click', () => { loadFromLocalStorage(); rebuildAll(); });
    btnClearLS?.addEventListener('click', () => {
      localStorage.removeItem('CM_COURSE_CLO');
      CLO_ITEMS = []; cloStatus.textContent = 'Đã xoá cache COURSE–CLO.';
      rebuildAll();
    });

    csvCourseCLO?.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      onLoadCourseCLO(f).catch(err => alert('Không đọc được CSV COURSE–CLO: ' + err));
    });
    btnExportCLO?.addEventListener('click', exportCourseCLOCsv);

    csvBloom?.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      onLoadBloom(f).catch(err => alert('Không đọc được CSV Bloom: ' + err));
    });

    [filterPLO, filterCourse, filterCLO].forEach(sel => sel?.addEventListener('change', () => { createCy(); rebuildTable(); }));
    btnClearFilters?.addEventListener('click', () => {
      filterPLO.value = ''; filterCourse.value = ''; filterCLO.value = '';
      createCy(); rebuildTable();
    });

    btnAISuggest?.addEventListener('click', suggestCLO);
    btnAIEval?.addEventListener('click', evaluateCLO);
  });
})();
