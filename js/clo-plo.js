// js/clo-plo.js
// Dựng mạng CLO–PLO từ 3 CSV "tên mặc định":
//  - PLO.csv:           label,content
//  - COURSE.csv:        id,label,fullname,(group?),(tong?)
//  - PLO-COURSE.csv:    plo,course,level   (plo = PLO.label; course = COURSE.id)
//
// Ngoài ra hỗ trợ nạp thêm COURSE–CLO.csv (label,fullname,tong,clo,content)
// và Bloom verbs.csv (verb,level) nếu bạn dùng khu vực GPT & bảng.
//
// Yêu cầu các ID mặc định trong HTML:
//   ploCsvInput, courseCsvInput, pcCsvInput, btnBuild
// (Các phần khác như filter, GPT, Fit/Screenshot sẽ tự phát hiện nếu tồn tại.)

(function () {
  // ======= Tuỳ chọn GPT backend (nếu dùng) =======
  const API_BASE = 'https://cm-gpt-service.onrender.com';
  const APP_TOKEN = '';

  // ======= STATE =======
  let PLO = {};                    // { PLO1: "..." }
  let COURSES = {};                // { id: {id,label,fullname,tong,group} }
  let EDGES_PC = [];               // [{plo, courseId, level}]
  let CLO_ITEMS = [];              // [{courseId, courseLabel, fullname, tong, clo, content}]
  let BLOOM = [];                  // [{verb, level}]
  let BLOOM_BY_LEVEL = {};

  let cy = null;

  // ======= DOM (tên mặc định) =======
  const ploInput    = document.getElementById('ploCsvInput');       // PLO.csv
  const courseInput = document.getElementById('courseCsvInput');    // COURSE.csv
  const pcInput     = document.getElementById('pcCsvInput');        // PLO-COURSE.csv
  const btnBuild    = document.getElementById('btnBuild');

  // Tuỳ có/không trong HTML
  const buildStatus   = document.getElementById('buildStatus') || document.getElementById('cloStatus');

  const csvCourseCLO  = document.getElementById('csvCourseCLO');
  const btnExportCLO  = document.getElementById('btnExportCLO');
  const cloStatus     = document.getElementById('cloStatus');

  const csvBloom      = document.getElementById('csvBloom');
  const bloomStatus   = document.getElementById('bloomStatus');

  const filterPLO     = document.getElementById('filter-plo');
  const filterCourse  = document.getElementById('filter-course');
  const filterCLO     = document.getElementById('filter-clo');
  const btnClearFilters = document.getElementById('btnClearFilters');

  const aiPLO         = document.getElementById('ai-plo');
  const aiCourse      = document.getElementById('ai-course');
  const aiLevel       = document.getElementById('ai-level');
  const btnAISuggest  = document.getElementById('btnAISuggest');
  const aiSuggestions = document.getElementById('aiSuggestions');
  const evalPLO       = document.getElementById('eval-plo');
  const evalCLO       = document.getElementById('eval-clo');
  const btnAIEval     = document.getElementById('btnAIEval');
  const evalResult    = document.getElementById('evalResult');

  const resultTable   = document.getElementById('resultTable');
  const resultTableBody = resultTable ? resultTable.querySelector('tbody') : null;

  // ======= Helpers =======
  const esc = s => String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  function setStatus(msg) { if (buildStatus) buildStatus.textContent = msg; }

  function csvQuote(v) {
    if (v == null) return '';
    const s = String(v).replace(/"/g,'""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }

  function normalizeRow(row) {
    const out = {};
    Object.keys(row).forEach(k => {
      const nk = String(k || '').replace(/^\ufeff/, '').trim().toLowerCase();
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
      case 'I': return '#60A5FA';   // sky-400
      case 'R': return '#34D399';   // emerald-400
      case 'M': return '#FBBF24';   // amber-400
      case 'A': return '#EF4444';   // red-500
      default : return '#94A3B8';   // slate-400
    }
  }

  // ======= BUILD từ 3 CSV (tên cột mặc định) =======
  async function onBuildFromCsv() {
    const fPlo = ploInput?.files?.[0];
    const fCourse = courseInput?.files?.[0];
    const fPC = pcInput?.files?.[0];

    // Kiểm tra đúng 3 file & báo thiếu cụ thể
    const missing = [];
    if (!ploInput || !fPlo)    missing.push('PLO.csv (label,content)');
    if (!courseInput || !fCourse) missing.push('COURSE.csv (id,label,fullname,...)');
    if (!pcInput || !fPC)      missing.push('PLO-COURSE.csv (plo,course,level)');
    if (missing.length) {
      alert('Hãy chọn đủ 3 file:\n• ' + missing.join('\n• '));
      return;
    }

    setStatus('Đang đọc CSV…');

    // 1) PLO.csv
    const ploRows = await parseCSV(fPlo);
    PLO = {};
    ploRows.forEach(r => {
      const label = (r.label || '').trim();
      const content = (r.content || '').trim();
      if (label) PLO[label] = content;
    });

    // 2) COURSE.csv
    const cRows = await parseCSV(fCourse);
    COURSES = {};
    cRows.forEach(r => {
      const id = (r.id || '').trim();             // BẮT BUỘC dùng id
      if (!id) return;
      const label = (r.label || id).trim();
      const fullname = (r.fullname || '').trim();
      const group = (r.group || '').trim();
      const tong = Number(r.tong ?? (Number(r.tc || 0)));
      COURSES[id] = { id, label, fullname, group, tong };
    });

    // 3) PLO-COURSE.csv (plo,course,level)
    const pcRows = await parseCSV(fPC);
    EDGES_PC = [];
    const badPlo = []; const badCourse = [];

    pcRows.forEach((r, idx) => {
      const plo = (r.plo || '').trim();           // plo = PLO.label
      const cid = (r.course || '').trim();        // course = COURSE.id
      const level = (r.level || 'I').trim().toUpperCase();

      if (!plo || !cid) return;
      if (!PLO[plo])    { badPlo.push({row: idx+2, plo}); return; }
      if (!COURSES[cid]){ badCourse.push({row: idx+2, cid}); return; }

      EDGES_PC.push({ plo, courseId: cid, level });
    });

    let msg = `Đã nạp: PLO ${Object.keys(PLO).length} • Course ${Object.keys(COURSES).length} • Kết nối ${EDGES_PC.length}`;
    if (badPlo.length || badCourse.length) {
      msg += ` (bỏ ${badPlo.length + badCourse.length} dòng lỗi)`;
      const ex = badPlo[0] || badCourse[0];
      const exStr = badPlo[0] ? `PLO "${ex.plo}"` : `COURSE id "${ex.cid}"`;
      alert(`Một số dòng trong PLO-COURSE.csv không khớp:\n• Ví dụ dòng ${ex.row}: ${exStr}.`);
    }
    setStatus(msg);

    rebuildAll();
  }

  // ======= COURSE–CLO.csv (nếu dùng) =======
  async function onLoadCourseCLO(file) {
    const rows = await parseCSV(file);
    CLO_ITEMS = [];
    let ok = 0, miss = 0;

    rows.forEach(r => {
      const courseLabel = (r.label || '').trim();   // label của COURSE (không phải id)
      const fullname = (r.fullname || '').trim();
      const tong = Number(r.tong || 0);
      const clo = (r.clo || '').trim();
      const content = (r.content || '').trim();
      if (!courseLabel || !clo) return;

      // Map theo label -> id (tìm trong COURSES)
      let courseId = '';
      // duyệt COURSES để tìm label khớp
      for (const id in COURSES) {
        if ((COURSES[id].label || '').trim() === courseLabel) { courseId = id; break; }
      }
      if (!courseId) { miss++; return; }

      CLO_ITEMS.push({ courseId, courseLabel, fullname, tong, clo, content });
      ok++;
    });

    if (cloStatus) cloStatus.textContent = `Đã nạp ${ok} CLO (bỏ ${miss} do không khớp Course.label).`;
    rebuildAll();
  }

  function exportCourseCLOCsv() {
    if (!CLO_ITEMS.length) { alert('Chưa có CLO để xuất.'); return; }
    const headers = ['label','fullname','tong','clo','content'];
    const lines = [headers.join(',')];
    CLO_ITEMS.forEach(it => {
      const course = COURSES[it.courseId] || {};
      lines.push([
        csvQuote(course.label || it.courseLabel || it.courseId),
        csvQuote(course.fullname || it.fullname || ''),
        csvQuote(course.tong ?? it.tong ?? ''),
        csvQuote(it.clo),
        csvQuote(it.content || '')
      ].join(','));
    });
    const csv = '\ufeff' + lines.join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8;'}));
    a.download = 'course_clo.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ======= Bloom verbs =======
  async function onLoadBloom(file) {
    const rows = await parseCSV(file);
    BLOOM = []; BLOOM_BY_LEVEL = {};
    rows.forEach(r => {
      const v = (r.verb || '').trim();
      const lv = (r.level || '').trim();
      if (!v || !lv) return;
      BLOOM.push({ verb: v, level: lv });
      (BLOOM_BY_LEVEL[lv] = BLOOM_BY_LEVEL[lv] || []).push(v);
    });
    if (bloomStatus) bloomStatus.textContent = `Bloom: ${BLOOM.length} động từ / ${Object.keys(BLOOM_BY_LEVEL).length} mức.`;
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
      if ([...select.options].some(o => o.value === cur)) select.value = cur;
    }

    const ploList = Object.keys(PLO).map(x => ({ value: x, label: x }));
    setOpts(filterPLO, ploList, '— Tất cả PLO —');

    const coursesList = Object.values(COURSES)
      .map(c => ({ value: c.id, label: `${c.label} — ${c.fullname || ''}`.trim() }))
      .sort((a,b) => a.label.localeCompare(b.label));
    setOpts(filterCourse, coursesList, '— Tất cả Course —');

    const cloSet = new Set(CLO_ITEMS.map(x => x.clo));
    const cloList = Array.from(cloSet).sort().map(x => ({ value: x, label: x }));
    setOpts(filterCLO, cloList, '— Tất cả CLO —');

    // AI dropdowns
    setOpts(aiPLO, ploList, '— chọn PLO —');
    setOpts(aiCourse, coursesList, '— chọn Course —');
    setOpts(evalPLO, ploList, '— chọn PLO —');
  }

  // ======= Cytoscape =======
  function buildElementsByFilters() {
    const fPLO = filterPLO?.value || '';
    const fC   = filterCourse?.value || '';
    const fCLO = filterCLO?.value || '';

    const elements = [];
    const nodeSet = new Set();
    const edgeSet = new Set();
    const addNode = (id, data) => { if (!nodeSet.has(id)) { nodeSet.add(id); elements.push({ data: { id, ...data } }); } };
    const addEdge = (id, data) => { if (!edgeSet.has(id)) { edgeSet.add(id); elements.push({ data: { id, ...data } }); } };

    const cloMap = {};
    CLO_ITEMS.forEach(it => { (cloMap[it.courseId] = cloMap[it.courseId] || []).push(it); });

    EDGES_PC.forEach(e => {
      if (fPLO && e.plo !== fPLO) return;
      if (fC && e.courseId !== fC) return;

      const course = COURSES[e.courseId]; if (!course) return;

      addNode(`PLO::${e.plo}`, { kind: 'PLO', label: e.plo, content: PLO[e.plo] || '' });
      addNode(`COURSE::${course.id}`, { kind: 'COURSE', id: course.id, label: course.label || course.id, fullname: course.fullname || '', tong: course.tong || 0 });

      addEdge(`E_PC::${e.plo}__${course.id}`, { source: `PLO::${e.plo}`, target: `COURSE::${course.id}`, level: e.level, kind: 'PC' });

      (cloMap[course.id] || []).forEach(ci => {
        if (fCLO && ci.clo !== fCLO) return;
        addNode(`CLO::${course.id}::${ci.clo}`, { kind: 'CLO', clo: ci.clo, content: ci.content || '' });
        addEdge(`E_CC::${course.id}__${ci.clo}`, { source: `COURSE::${course.id}`, target: `CLO::${course.id}::${ci.clo}`, kind: 'CC' });
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
      layout: { name: 'cose', animate: true, nodeRepulsion: 14000, idealEdgeLength: 120, padding: 30 }
    });

    bindCyEvents();
    window.cy = cy; // để Fit/Screenshot dùng
  }

  function bindCyEvents() {
    const tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;display:none;background:#fff;border:1px solid #e5e7eb;padding:8px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08);font-size:12px;max-width:420px;z-index:50;';
    tip.id = 'cloTip'; document.body.appendChild(tip);

    cy.on('mouseover','node',(evt)=>{
      const n = evt.target;
      let html = '';
      if (n.data('kind')==='PLO') {
        html = `<b>${esc(n.data('label'))}</b><br>${esc(n.data('content')||'')}`;
      } else if (n.data('kind')==='COURSE') {
        html = `<b>${esc(n.data('label'))}</b> — ${esc(n.data('fullname')||'')}<br>TC: ${esc(n.data('tong')||0)}`;
      } else {
        html = `<b>${esc(n.data('clo'))}</b><br>${esc(n.data('content')||'')}`;
      }
      tip.innerHTML = html; tip.style.display = 'block';
    });
    cy.on('mouseout','node',()=> tip.style.display='none');
    cy.on('mousemove',(evt)=>{
      if (tip.style.display==='block') {
        tip.style.left = (evt.originalEvent.pageX + 12) + 'px';
        tip.style.top  = (evt.originalEvent.pageY + 12) + 'px';
      }
    });

    cy.on('tap','node',(evt)=>{
      const n = evt.target;
      cy.elements().addClass('dim');
      n.removeClass('dim');
      n.connectedEdges().removeClass('dim');
      n.connectedEdges().connectedNodes().removeClass('dim').addClass('hl');
      setTimeout(()=> cy.elements('.hl').removeClass('hl'), 600);
    });
    cy.on('tap',(evt)=>{ if (evt.target===cy) cy.elements().removeClass('dim'); });
  }

  // ======= TABLE =======
  function rebuildTable() {
    if (!resultTableBody) return;

    resultTableBody.innerHTML = '';
    const fP = filterPLO?.value || '';
    const fC = filterCourse?.value || '';
    const fL = filterCLO?.value || '';

    const cloMap = {};
    CLO_ITEMS.forEach(it => { (cloMap[it.courseId]=cloMap[it.courseId]||[]).push(it); });

    const rows = [];
    EDGES_PC.forEach(e => {
      if (fP && e.plo !== fP) return;
      if (fC && e.courseId !== fC) return;

      const course = COURSES[e.courseId]; if (!course) return;
      const list = (cloMap[course.id] || []).filter(ci => !fL || ci.clo === fL);
      if (!list.length) return;

      list.forEach(ci => {
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

    rows.sort((a,b)=>
      a.plo.localeCompare(b.plo) ||
      a.courseLabel.localeCompare(b.courseLabel) ||
      a.clo.localeCompare(b.clo)
    );

    rows.forEach(r=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="border p-2 align-top">
          <div class="font-medium">${esc(r.plo)}</div>
          <div class="text-xs text-gray-600">${esc(r.ploContent)}</div>
        </td>
        <td class="border p-2 align-top">${esc(r.courseLabel)} — ${esc(r.courseFull)}</td>
        <td class="border p-2 align-top">
          <span class="inline-block px-2 py-0.5 rounded text-white" style="background:${colorForLevel(r.level)}">${esc(r.level||'')}</span>
        </td>
        <td class="border p-2 align-top">
          <div class="font-medium">${esc(r.clo)}</div>
          <div class="text-xs text-gray-600">${esc(r.cloContent)}</div>
        </td>`;
      resultTableBody.appendChild(tr);
    });

    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="border p-2 text-gray-500" colspan="4"><i>Không có kết quả phù hợp bộ lọc.</i></td>`;
      resultTableBody.appendChild(tr);
    }

    ensureTableToolbar();
  }

  function ensureTableToolbar(){
    if (!resultTable || resultTable.__toolbarReady) return;
    const wrapCard = resultTable.closest('.card') || resultTable.parentElement;
    if (!wrapCard) return;
    const head = document.createElement('div');
    head.className = 'flex items-center justify-end mb-2 gap-2';
    const btn = document.createElement('button');
    btn.className = 'btn'; btn.textContent = 'Xuất bảng (CSV)';
    btn.addEventListener('click', exportMatrixCsv);
    head.appendChild(btn);
    wrapCard.insertBefore(head, wrapCard.firstChild);
    resultTable.__toolbarReady = true;
  }

  function exportMatrixCsv(){
    const fP = filterPLO?.value || '';
    const fC = filterCourse?.value || '';
    const fL = filterCLO?.value || '';

    const cloMap = {};
    CLO_ITEMS.forEach(it => { (cloMap[it.courseId]=cloMap[it.courseId]||[]).push(it); });

    const heads = ['plo','plo_content','course_label','course_fullname','level','clo','clo_content'];
    const lines = [heads.join(',')];

    EDGES_PC.forEach(e=>{
      if (fP && e.plo!==fP) return;
      if (fC && e.courseId!==fC) return;
      const course = COURSES[e.courseId]; if (!course) return;

      (cloMap[course.id]||[]).filter(ci => !fL || ci.clo===fL).forEach(ci=>{
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
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8;'}));
    a.download = 'plo_course_clo_table.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ======= GPT (tuỳ chọn) =======
  const LEVEL2BLOOM = { I:['Remember','Understand'], R:['Apply','Analyze'], M:['Analyze','Evaluate'], A:['Evaluate','Create'] };
  function pickVerbs(level, n=6){
    const lvls = LEVEL2BLOOM[level] || [];
    const pool = [];
    lvls.forEach(l => (BLOOM_BY_LEVEL[l]||[]).forEach(v => pool.push({verb:v, level:l})));
    if (!pool.length) ['Describe','Explain','Apply','Analyze','Evaluate','Create'].forEach(v=>pool.push({verb:v,level:'*'}));
    const out = []; const used = new Set();
    while (out.length < Math.min(n, pool.length)) {
      const i = Math.floor(Math.random()*pool.length);
      const key = pool[i].verb.toLowerCase();
      if (!used.has(key)) { used.add(key); out.push(pool[i]); }
    }
    return out;
  }
  async function gptCall(kind, payload){
    const res = await fetch(`${API_BASE}/api/${kind}`, {
      method:'POST',
      headers:{'Content-Type':'application/json', ...(APP_TOKEN?{'Authorization':`Bearer ${APP_TOKEN}`}:{})},
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`GPT API error: ${res.status} ${await res.text().catch(()=> '')}`);
    return await res.json();
  }
  async function suggestCLO(){
    const plo = aiPLO?.value; const courseId = aiCourse?.value; const level = aiLevel?.value || 'I';
    if (!plo || !courseId) return alert('Chọn PLO và Course trước.');
    const ploText = PLO[plo] || ''; const course = COURSES[courseId] || {};
    if (aiSuggestions) aiSuggestions.innerHTML = '<li class="text-gray-500">Đang gọi GPT…</li>';
    try {
      const gpt = await gptCall('suggest',{ plo, ploText, course, level, bloomVerbs: BLOOM, count: 6 });
      const items = (gpt && Array.isArray(gpt.items) && gpt.items.length)
        ? gpt.items
        : pickVerbs(level,5).map((v,i)=>`CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo yêu cầu ${plo} (${v.level}).`);
      if (aiSuggestions) {
        aiSuggestions.innerHTML = '';
        items.forEach(text=>{
          const li = document.createElement('li'); li.textContent = text;
          aiSuggestions.appendChild(li);
        });
      }
    } catch {
      if (aiSuggestions) {
        aiSuggestions.innerHTML = '';
        pickVerbs(level,5).forEach((v,i)=>{
          const li = document.createElement('li'); li.textContent = `CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo yêu cầu ${plo} (${v.level}).`;
          aiSuggestions.appendChild(li);
        });
      }
    }
  }
  async function evaluateCLO(){
    const plo = evalPLO?.value; const cloText = (evalCLO?.value || '').trim();
    if (!plo || !cloText) return alert('Chọn PLO và nhập CLO.');
    const ploText = PLO[plo] || '';
    if (evalResult) evalResult.textContent = 'Đang gọi GPT…';
    try {
      const gpt = await gptCall('evaluate',{ plo, ploText, cloText });
      if (gpt && gpt.text) { if (evalResult) evalResult.textContent = gpt.text; return; }
      throw new Error('Empty GPT text');
    } catch {
      // fallback heuristic
      function kw(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]+/g)||[]; }
      const kp = new Set(kw(ploText)); const kc = kw(cloText);
      let overlap = 0; kc.forEach(w=>{ if(kp.has(w)) overlap++; });
      const score = Math.min(100, Math.round((overlap / Math.max(4, kp.size)) * 100));
      const verdict = score>=70?'Rất phù hợp':score>=40?'Tương đối phù hợp':'Chưa phù hợp';
      if (evalResult) evalResult.textContent =
        `Điểm tương đồng (heuristic): ${score}/100 → ${verdict}.
Gợi ý: nhấn mạnh từ khoá PLO trong CLO, làm rõ động từ Bloom và tiêu chí đo lường.`;
    }
  }

  // ======= RENDER =======
  function rebuildAll(){
    rebuildFilters();
    createCy();
    rebuildTable();
  }

  // ======= EVENTS =======
  document.addEventListener('DOMContentLoaded', () => {
    // A) Build từ 3 CSV (tên mặc định)
    btnBuild?.addEventListener('click', () => {
      onBuildFromCsv().catch(err => alert('Không đọc được CSV: ' + err));
    });

    // B) COURSE–CLO.csv
    csvCourseCLO?.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      onLoadCourseCLO(f).catch(err => alert('Không đọc được CSV COURSE–CLO: ' + err));
    });
    btnExportCLO?.addEventListener('click', exportCourseCLOCsv);

    // C) Bloom verbs
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

    // GPT tools (nếu có)
    btnAISuggest?.addEventListener('click', suggestCLO);
    btnAIEval?.addEventListener('click', evaluateCLO);

    // Fit & Screenshot (nếu có nút trong HTML)
    document.getElementById('btnFit')?.addEventListener('click', ()=> { if (window.cy) window.cy.fit(); });
    document.getElementById('btnScreenshot')?.addEventListener('click', ()=> {
      if (!window.cy) return;
      const png64 = window.cy.png({ bg: 'white', full: true, scale: 2 });
      const a = document.createElement('a');
      a.href = png64; a.download = 'CLO-PLO-graph.png'; a.click();
    });

    // Khởi tạo rỗng (chưa có CSV)
    rebuildAll();
  });
})();
