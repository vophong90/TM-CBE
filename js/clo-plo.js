// js/clo-plo.js — đọc PLO.csv, COURSE.csv và PLO-COURSE.csv (plo,course,level)

(function () {
  // ======= CONFIG: (tuỳ chọn) GPT backend =======
  const API_BASE = 'https://cm-gpt-service.onrender.com';
  const APP_TOKEN = '';

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
  const btnBuild = document.getElementById('btnBuild');
  const ploCsvInput = document.getElementById('ploCsvInput');
  const courseCsvInput = document.getElementById('courseCsvInput');
  const pcConnCsvInput = document.getElementById('pcConnCsvInput');

  const csvCourseCLO = document.getElementById('csvCourseCLO');
  const csvBloom = document.getElementById('csvBloom');

  const filterPLO = document.getElementById('filter-plo');
  const filterCourse = document.getElementById('filter-course');
  const filterCLO = document.getElementById('filter-clo');
  const btnClearFilters = document.getElementById('btnClearFilters');

  const resultTable = document.getElementById('resultTable');
  const resultTableBody = resultTable?.querySelector('tbody');

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
  function norm(s){ return String(s || '').replace(/^\ufeff/, '').trim(); }

  // ======= BUILD FROM CSV (PLO, COURSE, PLO-COURSE) =======
  async function onBuildFromCsv() {
    const fPLO    = ploCsvInput?.files?.[0];
    const fCOURSE = courseCsvInput?.files?.[0];
    const fPC     = pcConnCsvInput?.files?.[0];
    if (!fPLO || !fCOURSE || !fPC) {
      alert('Hãy chọn đủ 3 file: PLO.csv, COURSE.csv và PLO-COURSE.csv (plo,course,level)'); return;
    }

    const [ploRows, courseRows, pcRows] = await Promise.all([
      parseCSV(fPLO),
      parseCSV(fCOURSE),
      parseCSV(fPC),
    ]);

    // 1) PLO
    PLO = {};
    ploRows.forEach(r => {
      const label   = norm(r.label || r.plo);
      const content = norm(r.content || r.desc || r.description);
      if (label) PLO[label] = content;
    });

    // 2) COURSE + map label→id
    COURSES = {};
    COURSE_BY_LABEL = {};
    courseRows.forEach(r => {
      const id    = norm(r.id || r.code || r.courseid);
      if (!id) return;
      const label = norm(r.label) || id;
      const fullname = norm(r.fullname || r.name);
      const tong  = Number(r.tong || r.tc || 0);
      const group = norm(r.group || r.khoi || r.type);
      COURSES[id] = { id, label, fullname, tong, group };
      COURSE_BY_LABEL[label] = id;
    });

    // 3) EDGES PLO–COURSE (CSV cột bắt buộc: plo, course, level)
    //    - course có thể là id (Cxxx) hoặc label (tên/mã hiển thị)
    EDGES_PC = [];
    const skipped = [];
    pcRows.forEach(r => {
      const plo = norm(r.plo);
      const rawCourse = norm(r.course);     // id hoặc label
      const level = (norm(r.level) || 'I').toUpperCase();
      if (!plo || !rawCourse) return;

      // Ưu tiên id; nếu không có id thì map từ label
      const cid = COURSES[rawCourse] ? rawCourse : (COURSE_BY_LABEL[rawCourse] || '');
      if (!cid) { skipped.push({ plo, course: rawCourse }); return; }

      EDGES_PC.push({ plo, courseId: cid, level });
    });

    if (skipped.length) {
      console.warn('Bỏ qua kết nối vì không tìm thấy COURSE id/label:', skipped.slice(0, 10), skipped.length > 10 ? `…(+${skipped.length - 10})` : '');
    }

    // Giữ CLO_ITEMS/BLOOM nếu người dùng đã nạp ở panel B/C
    rebuildAll();
  }

  // ======= COURSE–CLO CSV =======
  async function onLoadCourseCLO(file) {
    const rows = await parseCSV(file);
    CLO_ITEMS = [];
    const label2id = (lab) => COURSES[lab] ? lab : (COURSE_BY_LABEL[lab] || '');

    rows.forEach(r => {
      const courseLabelOrId = norm(r.label || r.id);
      const courseId = label2id(courseLabelOrId);
      if (!courseId) return; // chỉ nhận các CLO thuộc course đã nạp ở A.

      const fullname = norm(r.fullname || COURSES[courseId]?.fullname || '');
      const tong     = Number(r.tong ?? COURSES[courseId]?.tong ?? 0);
      const clo      = norm(r.clo);
      const content  = norm(r.content);
      if (!clo) return;

      CLO_ITEMS.push({
        courseId,
        courseLabel: COURSES[courseId]?.label || courseId,
        fullname,
        tong,
        clo,
        content
      });
    });

    rebuildAll();
  }

  // ======= Bloom verbs =======
  async function onLoadBloom(file) {
    const rows = await parseCSV(file);
    BLOOM = [];
    BLOOM_BY_LEVEL = {};
    rows.forEach(r => {
      const v = norm(r.verb), lvl = norm(r.level);
      if (!v || !lvl) return;
      BLOOM.push({ verb: v, level: lvl });
      (BLOOM_BY_LEVEL[lvl] = BLOOM_BY_LEVEL[lvl] || []).push(v);
    });
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

    setOpts(filterPLO, Object.keys(PLO).map(l => ({ value: l, label: l })), '— Tất cả PLO —');

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
  function colorForLevel(level) {
    switch ((level || '').toUpperCase()) {
      case 'I': return '#60A5FA';   // sky-400
      case 'R': return '#34D399';   // emerald-400
      case 'M': return '#FBBF24';   // amber-400
      case 'A': return '#EF4444';   // red-500
      default:  return '#94A3B8';   // slate-400
    }
  }

  function buildElementsByFilters() {
    const fPLO = filterPLO?.value || '';
    const fCourse = filterCourse?.value || '';
    const fCLO = filterCLO?.value || '';

    const elements = [];
    const nodeSet = new Set();
    const edgeSet = new Set();

    const addNode = (id, data) => { if (!nodeSet.has(id)) { nodeSet.add(id); elements.push({ data: { id, ...data } }); } };
    const addEdge = (id, data) => { if (!edgeSet.has(id)) { edgeSet.add(id); elements.push({ data: { id, ...data } }); } };

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
        { selector: 'node[kind="PLO"]', style: {
          'shape':'round-rectangle','background-color':'#CFE8FF','border-color':'#0E7BD0','border-width':1.2,
          'label':'data(label)','font-size':10,'text-valign':'center','text-wrap':'wrap','text-max-width':140
        }},
        { selector: 'node[kind="COURSE"]', style: {
          'shape':'round-rectangle','background-color':'#FFE7A8','border-color':'#B7791F','border-width':1.2,
          'label':'data(label)','font-size':10,'text-valign':'center','text-wrap':'wrap','text-max-width':140
        }},
        { selector: 'node[kind="CLO"]', style: {
          'shape':'ellipse','background-color':'#E5E7EB','border-color':'#6B7280','border-width':1,
          'label':'data(clo)','font-size':10
        }},
        { selector: 'edge[kind="PC"]', style: {
          'width':3,'curve-style':'bezier',
          'line-color': ele => colorForLevel(ele.data('level')),
          'target-arrow-color': ele => colorForLevel(ele.data('level')),
          'target-arrow-shape':'triangle'
        }},
        { selector: 'edge[kind="CC"]', style: {
          'width':2,'curve-style':'bezier','line-color':'#94A3B8','target-arrow-color':'#94A3B8','target-arrow-shape':'triangle'
        }},
        { selector: '.dim', style: { 'opacity': 0.12 } },
        { selector: '.hl',  style: { 'border-width': 2, 'background-blacken': -0.1 } }
      ],
      layout: { name:'cose', animate:true, nodeRepulsion:14000, idealEdgeLength:120, padding:30 }
    });

    bindCyEvents();
    // expose for Fit/Screenshot
    window.cy = cy;
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

    cy.on('tap', (evt) => { if (evt.target === cy) cy.elements().removeClass('dim'); });
  }

  // ======= TABLE =======
  function rebuildTable() {
    ensureTableToolbar();
    const fP = filterPLO?.value || '';
    const fC = filterCourse?.value || '';
    const fL = filterCLO?.value || '';

    if (!resultTableBody) return;
    resultTableBody.innerHTML = '';

    const cloMap = {};
    CLO_ITEMS.forEach(it => { (cloMap[it.courseId] = cloMap[it.courseId] || []).push(it); });

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

    rows.sort((a,b) =>
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
          <span class="inline-flex items-center justify-center px-2 py-0.5 rounded text-white text-xs"
                style="background:${colorForLevel(r.level)}">${esc(r.level || '')}</span>
        </td>
        <td class="border p-2 align-top">
          <div class="font-medium">${esc(r.clo)}</div>
          <div class="text-xs text-gray-600">${esc(r.cloContent)}</div>
        </td>`;
      resultTableBody.appendChild(tr);
    });

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="border p-2 text-gray-500" colspan="4"><i>Không có kết quả phù hợp bộ lọc.</i></td>`;
      resultTableBody.appendChild(tr);
    }
  }

  // Toolbar cho bảng (nút Export CSV)
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

  // Xuất CSV bảng ghép theo bộ lọc hiện tại
  function exportMatrixCsv(){
    const fP = filterPLO?.value || '';
    const fC = filterCourse?.value || '';
    const fL = filterCLO?.value || '';

    const cloMap = {};
    CLO_ITEMS.forEach(it => { (cloMap[it.courseId] = cloMap[it.courseId] || []).push(it); });

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

  // ======= GPT =======
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
      let msg = ''; try { msg = await res.text(); } catch {}
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
    if (pool.length === 0) ['Describe','Explain','Apply','Analyze','Evaluate','Create']
      .forEach(v => pool.push({ verb: v, level: '*' }));
    const out = []; const used = new Set();
    for (let i = 0; i < pool.length && out.length < Math.min(n, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const key = pool[idx].verb.toLowerCase();
      if (used.has(key)) continue;
      used.add(key); out.push(pool[idx]);
    }
    return out;
  }

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

  async function suggestCLO() {
    const plo = aiPLO?.value; const courseId = aiCourse?.value; const level = aiLevel?.value || 'I';
    if (!plo || !courseId) return alert('Chọn PLO và Course trước.');
    const ploText = PLO[plo] || '';
    const course = COURSES[courseId] || {};

    if (aiSuggestions) aiSuggestions.innerHTML = '<li class="text-gray-500">Đang gọi GPT…</li>';
    try {
      const gpt = await gptCall('suggest', { plo, ploText, course, level, bloomVerbs: BLOOM, count: 6 });
      const items = (gpt && Array.isArray(gpt.items) && gpt.items.length)
        ? gpt.items
        : pickVerbs(level, 5).map((v,i)=>`CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo yêu cầu ${plo} (${v.level}).`);

      if (aiSuggestions) {
        aiSuggestions.innerHTML = '';
        items.forEach(text=>{
          const li = document.createElement('li');
          li.className = 'flex items-start justify-between gap-2';
          const span = document.createElement('span');
          span.textContent = text;
          const add = document.createElement('button');
          add.className = 'btn btn-outline'; add.textContent = '+ Thêm';
          add.addEventListener('click', ()=> { if (!addCLO(courseId, text)) alert('Không thể thêm CLO.'); });
          li.appendChild(span); li.appendChild(add);
          aiSuggestions.appendChild(li);
        });
      }
    } catch {
      if (aiSuggestions) {
        aiSuggestions.innerHTML = '';
        const ideas = pickVerbs(level, 5).map((v,i)=>`CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo yêu cầu ${plo} (${v.level}).`);
        ideas.forEach(t => { const li = document.createElement('li'); li.textContent = t; aiSuggestions.appendChild(li); });
      }
    }
  }

  async function evaluateCLO() {
    const plo = evalPLO?.value; const cloText = (evalCLO?.value || '').trim();
    if (!plo || !cloText) return alert('Chọn PLO và nhập CLO.');
    const ploText = PLO[plo] || '';
    if (evalResult) evalResult.textContent = 'Đang gọi GPT…';
    try {
      const gpt = await gptCall('evaluate', { plo, ploText, cloText });
      if (evalResult) evalResult.textContent = (gpt && gpt.text) ? gpt.text : '—';
    } catch {
      // simple fallback
      if (evalResult) evalResult.textContent = 'Đánh giá nhanh: hãy tăng từ khoá trùng với PLO và làm rõ động từ Bloom.';
    }
  }

  // ======= RENDER =======
  function rebuildAll() {
    rebuildFilters();
    createCy();
    rebuildTable();
  }

  // ======= UTIL: download text =======
  function __downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 0);
  }
  window.__downloadText = __downloadText;

  // ======= EVENTS =======
  document.addEventListener('DOMContentLoaded', () => {
    // A. Build từ CSV (PLO, COURSE, PLO-COURSE)
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
    document.getElementById('btnFit')?.addEventListener('click', () => { if (window.cy) window.cy.fit(); });
    document.getElementById('btnScreenshot')?.addEventListener('click', () => {
      if (!window.cy) return;
      const png64 = window.cy.png({ bg: 'white', full: true, scale: 2 });
      const a = document.createElement('a'); a.href = png64; a.download = 'CLO-PLO-graph.png'; a.click();
    });

    // Khởi tạo rỗng
    rebuildAll();
  });
})();
