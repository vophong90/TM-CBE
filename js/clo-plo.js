// ./js/clo-plo.js
// CLO–PLO (PLO → COURSE → CLO) — phiên bản gọn & đồng bộ brand
// - Đọc 4 file bắt buộc: PLO.csv, COURSE.csv, PLO-COURSE.csv (plo,course,level), COURSE–CLO.csv (label, fullname, tong, clo, content)
// - Tuỳ chọn: Bloom verbs.csv (verb, level)
// - Vẽ đồ thị Cytoscape, bộ lọc, bảng PLO–COURSE–CLO
// - GPT tools (gợi ý & đánh giá) có fallback offline
(function(){
  // =================== CONFIG GPT (tuỳ chọn) ===================
  const API_BASE = 'https://cm-gpt-service.onrender.com';
  const APP_TOKEN = ''; // nếu backend có token thì điền

  // =================== STATE HOẠT ĐỘNG (dataset đang hiển thị) ===================
  let PLO = {};                 // { "PLO1": "..." }
  let COURSES = {};             // { "C001": {id,label,fullname,group,tong}, ... }
  let COURSE_BY_LABEL = {};     // { "Mac": "C001", ... }
  let EDGES_PC = [];            // [{plo, courseId, level}, ...]
  let CLO_ITEMS = [];           // [{courseId, courseLabel, fullname, tong, clo, content}, ...]
  let BLOOM = [];               // [{verb, level}]
  let BLOOM_BY_LEVEL = {};      // { level: [verb, ...] }

  // =================== RAW DATA (đã nạp, chưa lọc) ===================
  const DATA = {
    // bản thô đã normalize headers
    ploRows: [],            // PLO.csv
    courseRows: [],         // COURSE.csv
    pcRows: [],             // PLO-COURSE.csv
    cloRows: [],            // COURSE-CLO.csv
    maps: {
      courseById: {},       // từ courseRows
      courseIdByLabel: {},  // từ courseRows
    },
    loaded: { plo:false, course:false, pc:false, clo:false }
  };

  let cy = null; // cytoscape instance

  // =================== DOM GETTERS ===================
  function el(id){ return document.getElementById(id); }

  // =================== HELPERS ===================
  const esc = s => String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  function normalizeRow(row){
    const out = {};
    Object.keys(row).forEach(k=>{
      const nk = String(k || '').replace(/^\ufeff/,'').trim().toLowerCase();
      let v = row[k];
      if (typeof v === 'string') v = v.replace(/^\ufeff/,'').trim();
      out[nk] = v;
    });
    return out;
  }

  function parseCSV(file){
    return new Promise((resolve, reject)=>{
      if (!file) return reject(new Error('File trống'));
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        complete: res => resolve(res.data.map(normalizeRow)),
        error: reject
      });
    });
  }

  function colorForLevel(level){
    switch((level||'').toUpperCase()){
      case 'I': return '#60A5FA';     // sky-400
      case 'R': return '#34D399';     // emerald-400
      case 'M': return '#FBBF24';     // amber-400
      case 'A': return '#EF4444';     // red-500
      default:  return '#94A3B8';     // slate-400 (fallback)
    }
  }

  function rebuildCourseMapsFromRaw(){
    DATA.maps.courseById = {};
    DATA.maps.courseIdByLabel = {};
    DATA.courseRows.forEach(r=>{
      const id = (r.id || r.code || r.courseid || '').trim();
      if (!id) return;
      const label = (r.label || r.code || id).trim();
      DATA.maps.courseById[id] = r;
      if (label) DATA.maps.courseIdByLabel[label] = id;
    });
  }

  function resolveCourseIdFlexible(key){
    // Nhận vào id hoặc label; ưu tiên id trong COURSE master
    if (!key) return '';
    const k = String(key).trim();
    if (!k) return '';
    if (DATA.maps.courseById[k]) return k;
    if (DATA.maps.courseIdByLabel[k]) return DATA.maps.courseIdByLabel[k];
    return ''; // không ép dùng nếu không có trong COURSE master (quyết định ở bước build)
  }

  function updateBuildButton(){
    const ready = DATA.loaded.plo && DATA.loaded.course && DATA.loaded.pc && DATA.loaded.clo;
    const btn = el('btnBuild');
    if (btn) btn.disabled = !ready;
    if (!ready) {
      el('buildStatus') && (el('buildStatus').textContent = 'Chưa đủ file: cần PLO, COURSE, PLO-COURSE, COURSE-CLO.');
    } else {
      el('buildStatus') && (el('buildStatus').textContent = 'Sẵn sàng: bấm “Xây đồ thị”.');
    }
  }

  // =================== FILTERS ===================
  function rebuildFilters(){
    const selP = el('filter-plo');
    const selC = el('filter-course');
    const selL = el('filter-clo');

    function setOpts(select, opts, firstText){
      const keep = select?.value || '';
      if (!select) return;
      select.innerHTML = '';
      const first = document.createElement('option');
      first.value = '';
      first.textContent = firstText;
      select.appendChild(first);
      opts.forEach(o=>{
        const op = document.createElement('option');
        op.value = o.value; op.textContent = o.label;
        select.appendChild(op);
      });
      if ([...select.options].some(o=>o.value===keep)) select.value = keep;
    }

    setOpts(selP, Object.keys(PLO).map(x=>({value:x,label:x})), '— Tất cả PLO —');

    const courseOpts = Object.values(COURSES)
      .map(c => ({ value: c.id, label: `${c.label || c.id} — ${c.fullname || ''}`.trim() }))
      .sort((a,b)=>a.label.localeCompare(b.label));
    setOpts(selC, courseOpts, '— Tất cả Course —');

    const cloSet = new Set(CLO_ITEMS.map(x=>x.clo));
    const cloOpts = Array.from(cloSet).sort().map(v=>({value:v, label:v}));
    setOpts(selL, cloOpts, '— Tất cả CLO —');

    // GPT dropdowns
    const aiP = el('ai-plo'), aiC = el('ai-course'), evP = el('eval-plo');
    setOpts(aiP, Object.keys(PLO).map(x=>({value:x,label:x})), '— chọn PLO —');
    setOpts(aiC, courseOpts, '— chọn Course —');
    setOpts(evP, Object.keys(PLO).map(x=>({value:x,label:x})), '— chọn PLO —');
  }

  // =================== BUILD GRAPH ELEMENTS ===================
  function buildElementsByFilters(){
    const fP = el('filter-plo')?.value || '';
    const fC = el('filter-course')?.value || '';
    const fL = el('filter-clo')?.value || '';

    // Lập map CLO theo courseId
    const cloMap = {};
    CLO_ITEMS.forEach(it => {
      (cloMap[it.courseId] = cloMap[it.courseId] || []).push(it);
    });

    const elements = [];
    const nodeSet = new Set();
    const edgeSet = new Set();

    function addNode(id, data){
      if (nodeSet.has(id)) return;
      nodeSet.add(id);
      elements.push({ data: { id, ...data } });
    }
    function addEdge(id, data){
      if (edgeSet.has(id)) return;
      edgeSet.add(id);
      elements.push({ data: { id, ...data } });
    }

    // Với mỗi cạnh PLO–COURSE thoả bộ lọc
    EDGES_PC.forEach(e=>{
      if (fP && e.plo !== fP) return;
      if (fC && e.courseId !== fC) return;

      const course = COURSES[e.courseId];
      if (!course) return;

      // Add nodes
      addNode(`PLO::${e.plo}`, {
        kind: 'PLO', label: e.plo, content: PLO[e.plo] || ''
      });
      addNode(`COURSE::${course.id}`, {
        kind: 'COURSE', id: course.id, label: course.label || course.id,
        fullname: course.fullname || '', tong: course.tong || 0
      });

      // Add edge PLO -> COURSE
      addEdge(`E_PC::${e.plo}__${course.id}`, {
        kind: 'PC', source: `PLO::${e.plo}`, target: `COURSE::${course.id}`, level: e.level || 'I'
      });

      // Add CLOs for this course (filter by CLO nếu có)
      const list = cloMap[course.id] || [];
      list.forEach(ci=>{
        if (fL && ci.clo !== fL) return;
        addNode(`CLO::${course.id}::${ci.clo}`, { kind:'CLO', clo: ci.clo, content: ci.content || '' });
        addEdge(`E_CC::${course.id}__${ci.clo}`, {
          kind: 'CC', source: `COURSE::${course.id}`, target: `CLO::${course.id}::${ci.clo}`
        });
      });
    });

    return elements;
  }

  // =================== CYTOSCAPE ===================
  function createCy(){
    const container = el('cy');
    if (!container) return;
    if (!container.style.height) container.style.height = '640px';
    if (!container.style.minHeight) container.style.minHeight = '480px';
    if (cy) { cy.destroy(); cy = null; }

    const elements = buildElementsByFilters();

    cy = cytoscape({
      container,
      elements,
      style: [
        // PLO
        { selector: 'node[kind="PLO"]', style: {
          'shape': 'round-rectangle',
          'background-color': '#CFE8FF',
          'border-color': '#0E7BD0', 'border-width': 1.2,
          'label': 'data(label)', 'font-size': 10, 'color': '#0B253A',
          'text-valign': 'center', 'text-wrap': 'wrap', 'text-max-width': 160
        }},
        // COURSE
        { selector: 'node[kind="COURSE"]', style: {
          'shape': 'round-rectangle',
          'background-color': '#FFE7A8',
          'border-color': '#B7791F', 'border-width': 1.2,
          'label': 'data(label)', 'font-size': 10, 'color': '#3B2F0A',
          'text-valign': 'center', 'text-wrap': 'wrap', 'text-max-width': 180
        }},
        // CLO
        { selector: 'node[kind="CLO"]', style: {
          'shape': 'ellipse',
          'background-color': '#E5E7EB',
          'border-color': '#6B7280', 'border-width': 1,
          'label': 'data(clo)', 'font-size': 10, 'color': '#111827'
        }},
        // Edge PLO–COURSE
        { selector: 'edge[kind="PC"]', style: {
          'width': 3, 'curve-style': 'bezier',
          'line-color': ele => colorForLevel(ele.data('level')),
          'target-arrow-color': ele => colorForLevel(ele.data('level')),
          'target-arrow-shape': 'triangle'
        }},
        // Edge COURSE–CLO
        { selector: 'edge[kind="CC"]', style: {
          'width': 2, 'curve-style': 'bezier',
          'line-color': '#94A3B8', 'target-arrow-color': '#94A3B8', 'target-arrow-shape': 'triangle'
        }},
        { selector: '.dim', style: { 'opacity': 0.12 } },
        { selector: '.hl',  style: { 'border-width': 2, 'background-blacken': -0.1 } }
      ],
      layout: { name: 'cose', animate: true, nodeRepulsion: 14000, idealEdgeLength: 120, padding: 30 }
    });

    // expose to global for Fit & Screenshot buttons in HTML
    window.cy = cy;

    bindCyEvents();
  }

  function bindCyEvents(){
    const tip = el('tooltip');
    function showTip(html){ if(tip){ tip.innerHTML = html; tip.style.display = 'block'; } }
    function hideTip(){ if(tip){ tip.style.display = 'none'; } }
    function moveTip(evt){
      if (tip && tip.style.display === 'block') {
        tip.style.left = (evt.originalEvent.pageX + 12) + 'px';
        tip.style.top  = (evt.originalEvent.pageY + 12) + 'px';
      }
    }

    cy.on('mouseover', 'node', (evt)=>{
      const n = evt.target;
      if (n.data('kind') === 'PLO') {
        showTip(`<b>${esc(n.data('label'))}</b><br>${esc(n.data('content') || '')}`);
      } else if (n.data('kind') === 'COURSE') {
        const tc = n.data('tong') || 0;
        showTip(`<b>${esc(n.data('label'))}</b> — ${esc(n.data('fullname') || '')}<br>TC: ${esc(tc)}`);
      } else {
        showTip(`<b>${esc(n.data('clo'))}</b><br>${esc(n.data('content') || '')}`);
      }
    });
    cy.on('mouseout', 'node', hideTip);
    cy.on('mousemove', moveTip);

    cy.on('tap', 'node', (evt)=>{
      const n = evt.target;
      cy.elements().addClass('dim');
      n.removeClass('dim');
      n.connectedEdges().removeClass('dim');
      n.connectedEdges().connectedNodes().removeClass('dim').addClass('hl');
      setTimeout(()=> cy.elements('.hl').removeClass('hl'), 600);
    });
    cy.on('tap', (evt)=>{ if (evt.target === cy) cy.elements().removeClass('dim'); });
  }

  // =================== TABLE ===================
  function rebuildTable(){
    const tbody = el('resultTable')?.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const fP = el('filter-plo')?.value || '';
    const fC = el('filter-course')?.value || '';
    const fL = el('filter-clo')?.value || '';

    // Map CLO theo courseId
    const cloMap = {};
    CLO_ITEMS.forEach(it => {
      (cloMap[it.courseId] = cloMap[it.courseId] || []).push(it);
    });

    const rows = [];
    EDGES_PC.forEach(e=>{
      if (fP && e.plo !== fP) return;
      if (fC && e.courseId !== fC) return;
      const course = COURSES[e.courseId]; if (!course) return;

      const list = (cloMap[course.id] || []).filter(ci => !fL || ci.clo === fL);
      if (list.length === 0) return;

      list.forEach(ci=>{
        rows.push({
          plo: e.plo,
          ploContent: PLO[e.plo] || '',
          courseLabel: course.label || course.id,
          courseFull: course.fullname || '',
          level: e.level || '',
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

    if (rows.length === 0){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="border p-2 text-gray-500" colspan="4"><i>Không có kết quả phù hợp bộ lọc.</i></td>`;
      tbody.appendChild(tr);
      return;
    }

    rows.forEach(r=>{
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
      tbody.appendChild(tr);
    });
  }

  // =================== BUILD LOGIC (từ dữ liệu đã nạp) ===================
  function materializeActiveDatasetFromRaw(){
    // 1) PLO active
    PLO = {};
    DATA.ploRows.forEach(r=>{
      const label = (r.label || r.plo || '').trim();
      const content = (r.content || r.desc || r.description || '').trim();
      if (label) PLO[label] = content;
    });

    // 2) COURSE master (để lấy metadata; chưa lọc theo CLO)
    const masterById = {};
    const masterIdByLabel = {};
    DATA.courseRows.forEach(r=>{
      const id = (r.id || r.code || r.courseid || '').trim();
      if (!id) return;
      const label    = (r.label || r.code || id).trim();
      const fullname = (r.fullname || r.name || '').trim();
      const group    = (r.group || r.khoi || r.type || '').trim();
      const tong     = Number(r.tong ?? r.tc ?? 0) || 0;
      masterById[id] = { id, label, fullname, group, tong };
      masterIdByLabel[label] = id;
    });

    // 3) Tập COURSE cuối cùng = những course xuất hiện trong COURSE-CLO.csv
    // Cho phép CLO định nghĩa tối thiểu nếu không có trong master (tạo placeholder)
    const allowedMap = {}; // id -> courseObj
    const label2id   = {}; // label -> id (chuẩn hoá)
    DATA.cloRows.forEach(r=>{
      const rawKey = (r.label || r.course_id || r.id || r.code || '').trim();
      if (!rawKey) return;
      // Ưu tiên map sang id master; nếu không có thì dùng chính rawKey làm id
      const idFromMaster = masterById[rawKey] ? rawKey : (masterIdByLabel[rawKey] || '');
      const cid = idFromMaster || rawKey;
      if (!allowedMap[cid]){
        if (masterById[cid]) {
          allowedMap[cid] = { ...masterById[cid] };
        } else {
          // tạo placeholder từ chính CLO
          allowedMap[cid] = {
            id: cid,
            label: rawKey,
            fullname: (r.fullname || '').trim(),
            group: '',
            tong: Number(r.tong || 0) || 0
          };
        }
      }
      // nếu CLO có fullname/tong cụ thể thì cập nhật (ưu tiên dữ liệu CLO)
      if (r.fullname) allowedMap[cid].fullname = String(r.fullname).trim();
      if (r.tong)     allowedMap[cid].tong = Number(r.tong) || allowedMap[cid].tong || 0;

      label2id[rawKey] = cid; // cho phép map label → canonical id
    });

    // 4) CLO_ITEMS active: chỉ giữ các CLO thuộc allowedMap
    CLO_ITEMS = [];
    DATA.cloRows.forEach(r=>{
      const rawKey = (r.label || r.course_id || r.id || r.code || '').trim();
      const cid = label2id[rawKey];
      if (!cid || !allowedMap[cid]) return; // bỏ im lặng
      const clo = (r.clo || '').trim();
      if (!clo) return;
      const content = (r.content || '').trim();
      CLO_ITEMS.push({
        courseId: cid,
        courseLabel: allowedMap[cid].label || cid,
        fullname: allowedMap[cid].fullname || '',
        tong: allowedMap[cid].tong || 0,
        clo, content
      });
    });

    // 5) COURSES active = allowedMap
    COURSES = allowedMap;
    COURSE_BY_LABEL = {};
    Object.values(COURSES).forEach(c=>{
      if (c.label) COURSE_BY_LABEL[c.label] = c.id;
    });

    // 6) EDGES_PC active: chỉ giữ cạnh có courseId thuộc COURSES active & PLO hợp lệ
    EDGES_PC = [];
    DATA.pcRows.forEach(r=>{
      const plo = (r.plo || r['plo_label'] || '').trim();
      if (!plo || !PLO[plo]) return; // PLO không tồn tại -> bỏ
      const rawCourse = (r.course || r['course_id'] || '').trim();
      // rawCourse có thể là id hoặc label; canonical:
      let cid = '';
      if (COURSES[rawCourse]) cid = rawCourse;
      else if (COURSE_BY_LABEL[rawCourse]) cid = COURSE_BY_LABEL[rawCourse];
      if (!cid) return; // không thuộc allowedMap -> bỏ im lặng
      let level = (r.level || '').trim().toUpperCase();
      if (!level) level = 'I';
      EDGES_PC.push({ plo, courseId: cid, level });
    });
  }

  function buildAndRender(){
    materializeActiveDatasetFromRaw();
    rebuildFilters();
    createCy();
    rebuildTable();

    // Tóm tắt trạng thái — không báo lỗi miss
    const status = `PLO: ${Object.keys(PLO).length} • Course: ${Object.keys(COURSES).length} • Liên kết PLO–COURSE: ${EDGES_PC.length} • CLO: ${CLO_ITEMS.length}`;
    el('buildStatus') && (el('buildStatus').textContent = status);
    // CLO status đơn giản (không báo "bỏ X")
    el('cloStatus') && (el('cloStatus').textContent = `Đã nạp COURSE–CLO: ${DATA.cloRows.length} dòng (đang dùng: ${CLO_ITEMS.length} CLO).`);
  }

  // =================== LOADERS (mỗi file nạp riêng, không build vội) ===================
  async function onLoadPLO(file){
    const rows = await parseCSV(file);
    DATA.ploRows = rows.map(normalizeRow);
    DATA.loaded.plo = true;
    updateBuildButton();
  }

  async function onLoadCOURSE(file){
    const rows = await parseCSV(file);
    DATA.courseRows = rows.map(normalizeRow);
    rebuildCourseMapsFromRaw();
    DATA.loaded.course = true;
    updateBuildButton();
  }

  async function onLoadPLOCOURSE(file){
    const rows = await parseCSV(file);
    DATA.pcRows = rows.map(normalizeRow);
    DATA.loaded.pc = true;
    updateBuildButton();
  }

  async function onLoadCOURSECLO(file){
    const rows = await parseCSV(file);
    DATA.cloRows = rows.map(normalizeRow);
    DATA.loaded.clo = true;
    // Không build ở đây — theo yêu cầu đợi đủ 4 file
    el('cloStatus') && (el('cloStatus').textContent = `Đã nạp COURSE–CLO: ${rows.length} dòng.`);
    updateBuildButton();
  }

  // =================== Bloom verbs ===================
  async function onLoadBloom(file){
    const rows = await parseCSV(file);
    BLOOM = [];
    BLOOM_BY_LEVEL = {};
    rows.forEach(r=>{
      const verb = (r.verb || '').trim();
      const level = (r.level || '').trim();
      if (!verb || !level) return;
      BLOOM.push({ verb, level });
      (BLOOM_BY_LEVEL[level] = BLOOM_BY_LEVEL[level] || []).push(verb);
    });
    el('bloomStatus') && (el('bloomStatus').textContent = `Đã nạp Bloom verbs: ${BLOOM.length} động từ / ${Object.keys(BLOOM_BY_LEVEL).length} mức.`);
  }

  // =================== GPT TOOLS ===================
  async function gptCall(kind, payload){
    try{
      const res = await fetch(`${API_BASE}/api/${kind}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(APP_TOKEN ? { 'Authorization': `Bearer ${APP_TOKEN}` } : {})
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    }catch(e){
      throw new Error(`GPT API error: ${e.message || e}`);
    }
  }

  const LEVEL2BLOOM = {
    I: ['Remember','Understand'],
    R: ['Apply','Analyze'],
    M: ['Analyze','Evaluate'],
    A: ['Evaluate','Create']
  };
  function pickVerbs(level, n=6){
    const lvls = LEVEL2BLOOM[level] || [];
    const pool = [];
    lvls.forEach(l => (BLOOM_BY_LEVEL[l] || []).forEach(v => pool.push({verb:v, level:l})));
    if (pool.length===0) ['Describe','Explain','Apply','Analyze','Evaluate','Create']
      .forEach(v=>pool.push({verb:v, level:'*'}));
    const used = new Set(); const out = [];
    while (out.length < Math.min(n, pool.length)){
      const i = Math.floor(Math.random()*pool.length);
      const k = pool[i].verb.toLowerCase();
      if (used.has(k)) continue;
      used.add(k); out.push(pool[i]);
    }
    return out;
  }

  function nextCLOCode(courseId){
    const cur = CLO_ITEMS.filter(x=>x.courseId===courseId);
    let maxN = 0;
    cur.forEach(x=>{
      const m = String(x.clo||'').match(/CLO\s*0*(\d+)/i);
      if (m){ const n = parseInt(m[1],10); if (n>maxN) maxN = n; }
    });
    return `CLO${maxN+1}`;
  }

  function addCLO(courseId, text, explicitCLO){
    if (!COURSES[courseId]) return false;
    const cloCode = explicitCLO || nextCLOCode(courseId);
    const courseLabel = COURSES[courseId].label || courseId;
    const fullname = COURSES[courseId].fullname || '';
    const tong = COURSES[courseId].tong || 0;
    CLO_ITEMS.push({ courseId, courseLabel, fullname, tong, clo: cloCode, content: text });
    rebuildFilters(); createCy(); rebuildTable();
    return true;
  }

  async function suggestCLO(){
    const plo = el('ai-plo')?.value;
    const courseId = el('ai-course')?.value;
    const level = el('ai-level')?.value || 'I';
    const list = el('aiSuggestions');
    if (!plo || !courseId){ alert('Chọn PLO và Course trước.'); return; }
    if (list) list.innerHTML = '<li class="text-gray-500">Đang gọi GPT…</li>';

    const ploText = PLO[plo] || '';
    const course = COURSES[courseId] || {};
    try{
      const gpt = await gptCall('suggest', {
        plo, ploText, course, level, bloomVerbs: BLOOM, count: 6
      });
      const items = (gpt && Array.isArray(gpt.items) && gpt.items.length)
        ? gpt.items
        : pickVerbs(level, 5).map((v,i)=>`CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo ${plo} (${v.level}).`);

      if (list){
        list.innerHTML = '';
        items.forEach(text=>{
          const li = document.createElement('li');
          li.className = 'flex items-start justify-between gap-2';
          const span = document.createElement('span'); span.textContent = text;
          const add = document.createElement('button');
          add.className = 'btn btn-outline'; add.textContent = '+ Thêm';
          add.title = 'Thêm CLO này vào dữ liệu';
          add.addEventListener('click', ()=>{
            const ok = addCLO(courseId, text);
            if (!ok) alert('Không thể thêm CLO. Kiểm tra Course.');
          });
          li.appendChild(span); li.appendChild(add);
          list.appendChild(li);
        });
      }
    }catch(e){
      // Fallback offline
      const items = pickVerbs(level, 5).map((v,i)=>`CLO${i+1}: ${v.verb} ${course.fullname || course.label || 'học phần'} theo ${plo} (${v.level}).`);
      if (list){
        list.innerHTML = '';
        items.forEach(text=>{ const li = document.createElement('li'); li.textContent = text; list.appendChild(li); });
      }
      console.warn('GPT suggest fallback:', e.message || e);
    }
  }

  async function evaluateCLO(){
    const plo = el('eval-plo')?.value;
    const cloText = (el('eval-clo')?.value || '').trim();
    const out = el('evalResult');
    if (!plo || !cloText){ alert('Chọn PLO và nhập CLO.'); return; }
    if (out) out.textContent = 'Đang gọi GPT…';

    const ploText = PLO[plo] || '';
    try{
      const gpt = await gptCall('evaluate', { plo, ploText, cloText });
      if (gpt && gpt.text){ if (out) out.textContent = gpt.text; return; }
      throw new Error('Empty GPT text');
    }catch(e){
      // Heuristic fallback
      function kw(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]+/g) || []; }
      const kp = new Set(kw(ploText));
      const kc = kw(cloText);
      let overlap = 0; kc.forEach(w=>{ if (kp.has(w)) overlap++; });
      const score = Math.min(100, Math.round((overlap / Math.max(4, kp.size||1)) * 100));
      const verdict = score>=70 ? 'Rất phù hợp' : score>=40 ? 'Tương đối phù hợp' : 'Chưa phù hợp';
      if (out) out.textContent =
        `Điểm tương đồng (heuristic): ${score}/100 → ${verdict}.
Gợi ý: nhấn mạnh từ khoá PLO trong CLO, làm rõ động từ Bloom và tiêu chí đo lường.`;
      console.warn('GPT evaluate fallback:', e.message || e);
    }
  }

  // =================== RENDER ALL ===================
  function rebuildAll(){
    rebuildFilters();
    createCy();
    rebuildTable();
  }

  // =================== EVENTS ===================
  document.addEventListener('DOMContentLoaded', ()=>{
    // Disable nút build ngay từ đầu
    updateBuildButton();

    // Nạp từng file (không build vội)
    el('csvPLO')?.addEventListener('change', e=>{
      const f = e.target.files?.[0]; if (!f) return;
      onLoadPLO(f).catch(err => alert('Không đọc được PLO.csv: ' + (err?.message || err)));
    });
    el('csvCOURSE')?.addEventListener('change', e=>{
      const f = e.target.files?.[0]; if (!f) return;
      onLoadCOURSE(f).catch(err => alert('Không đọc được COURSE.csv: ' + (err?.message || err)));
    });
    el('csvConnPloCourse')?.addEventListener('change', e=>{
      const f = e.target.files?.[0]; if (!f) return;
      onLoadPLOCOURSE(f).catch(err => alert('Không đọc được PLO-COURSE.csv: ' + (err?.message || err)));
    });
    el('csvCourseCLO')?.addEventListener('change', e=>{
      const f = e.target.files?.[0]; if (!f) return;
      onLoadCOURSECLO(f).catch(err => alert('Không đọc được COURSE–CLO.csv: ' + (err?.message || err)));
    });

    // Bloom verbs
    el('csvBloom')?.addEventListener('change', e=>{
      const f = e.target.files?.[0]; if (!f) return;
      onLoadBloom(f).catch(err => alert('Không đọc được CSV Bloom: ' + (err?.message || err)));
    });

    // Build từ dữ liệu đã nạp (đã đủ 4 file)
    el('btnBuild')?.addEventListener('click', ()=>{
      const ready = DATA.loaded.plo && DATA.loaded.course && DATA.loaded.pc && DATA.loaded.clo;
      if (!ready){
        alert('Vui lòng nạp đủ 4 file (PLO, COURSE, PLO-COURSE, COURSE-CLO) trước khi xây.');
        return;
      }
      buildAndRender();
    });

    // Filters
    ['filter-plo','filter-course','filter-clo'].forEach(id=>{
      el(id)?.addEventListener('change', ()=>{ createCy(); rebuildTable(); });
    });
    el('btnClearFilters')?.addEventListener('click', ()=>{
      if (el('filter-plo')) el('filter-plo').value = '';
      if (el('filter-course')) el('filter-course').value = '';
      if (el('filter-clo')) el('filter-clo').value = '';
      createCy(); rebuildTable();
    });

    // GPT tools
    el('btnAISuggest')?.addEventListener('click', suggestCLO);
    el('btnAIEval')?.addEventListener('click', evaluateCLO);

    // Khởi tạo rỗng UI (trước khi build)
    rebuildAll();
  });
})();
