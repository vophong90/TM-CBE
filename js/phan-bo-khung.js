/* Phân bổ khung
 * - Nạp kho học phần từ CSV: label, fullname, lt, th, group, khoi, type, tong
 * - Kéo-thả vào 12 học kỳ; tín chỉ tính theo 'tong' (nếu trống thì lt+th)
 * - Xuất/Tải CSV phân bổ (label,semester) + xuất chi tiết kèm fullname, lt, th, tong, group, khoi, type
 * - Ràng buộc: tiên quyết (from→to) & song hành (a↔b) + đồ thị Cytoscape
 * - Biểu đồ cột chồng:
 *     (1) Tín chỉ theo khối (Tây/Đông/Kết hợp) & năm học
 *     (2) Tín chỉ theo type & năm học
 * - Thống kê mỗi học kỳ (TC; LT|TH; TY|ĐY|KH)
 */

(function () {
  // ---------- State ----------
  let courses = [];                     // [{id,label,fullname,lt,th,tong,group,khoi,type}]
  const assigns = {};                   // { id: semester (1..12) }
  const prerequisites = [];             // [{from, to}]
  const corequisites  = [];             // [{a, b}]
  let cy = null;                        // Cytoscape
  let creditChart = null;               // Chart.js (khối)
  let typeChart = null;                 // Chart.js (type)

  // ---------- DOM ----------
  const bankEl   = document.getElementById('course-bank');
  const bankStatus = document.getElementById('bankStatus');
  const csvCoursesInput = document.getElementById('csvCourses');
  const btnClearBank = document.getElementById('btnClearBank');

  const btnExportAssign = document.getElementById('btnExportAssign');
  const fileAssignCsv   = document.getElementById('fileAssignCsv');

  const semesterContainer = document.getElementById('semester-container');
  const btnRefreshCharts  = document.getElementById('btnRefreshCharts');

  const prereqFrom = document.getElementById('prereq-from');
  const prereqTo   = document.getElementById('prereq-to');
  const coreqA     = document.getElementById('coreq-a');
  const coreqB     = document.getElementById('coreq-b');
  const btnAddPrereq = document.getElementById('btnAddPrereq');
  const btnAddCoreq  = document.getElementById('btnAddCoreq');
  const violationsEl  = document.getElementById('violations');

  // ---------- Utils ----------
  const esc = s => String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  const toNum = v => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const s = String(v).replace(',', '.').trim();
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };

  // normalize headers: trim, lowercase, remove BOM
  function normalizeRow(row) {
    const out = {};
    for (const k in row) {
      const nk = k.replace(/^\ufeff/,'').trim().toLowerCase();
      let v = row[k];
      if (typeof v === 'string') v = v.replace(/^\ufeff/,'').trim();
      out[nk] = v;
    }
    return out;
  }
  function parseCSV(file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: res => resolve(res.data.map(normalizeRow)),
        error: reject
      });
    });
  }

  function creditOf(c) { return c.tong != null && c.tong !== '' ? toNum(c.tong) : (toNum(c.lt) + toNum(c.th)); }

  const khoiClass = (khoi) => {
    const k = (khoi || '').toLowerCase();
    if (k.startsWith('tây')) return 'khoi-tay';
    if (k.startsWith('đông') || k.startsWith('dong')) return 'khoi-dong';
    return 'khoi-ket'; // Kết hợp
  };

  // ---------- Courses bank ----------
  function renderBank() {
    bankEl.innerHTML = '';
    courses.forEach(c => {
      if (assigns[c.id]) return; // đã xếp -> không hiện trong bank
      const chip = document.createElement('div');
      chip.className = `chip ${khoiClass(c.khoi)}`;
      chip.draggable = true;
      chip.dataset.id = c.id;
      chip.title = `${c.label} — ${c.fullname}\n${creditOf(c)} tín chỉ (${c.lt||0} LT, ${c.th||0} TH)`;
      chip.innerHTML = `<span>${esc(c.label)}</span><span class="opacity-70">(${creditOf(c)})</span>`;
      chip.addEventListener('dragstart', onDragStart);
      bankEl.appendChild(chip);
    });
    bankStatus.textContent = `${Object.keys(assigns).length}/${courses.length} học phần đã xếp vào học kỳ`;
  }

  function populateCourseSelects() {
    const opts = ['<option value="">— chọn học phần —</option>']
      .concat(courses.map(c => `<option value="${esc(c.id)}">${esc(c.label)} — ${esc(c.fullname)}</option>`));
    [prereqFrom, prereqTo, coreqA, coreqB].forEach(sel => sel.innerHTML = opts.join(''));
  }

  // ---------- Semesters ----------
  const SEMESTERS = 12;

  function createSemesters() {
    semesterContainer.innerHTML = '';
    for (let i = 1; i <= SEMESTERS; i++) {
      const wrap = document.createElement('section');
      wrap.className = 'semester card p-3';
      wrap.dataset.semester = String(i);

      const head = document.createElement('div');
      head.className = 'mb-2';
      head.innerHTML = `
        <div class="flex items-center justify-between">
          <div class="font-semibold">Học kỳ ${i}</div>
          <div class="text-sm text-gray-600">Tổng TC: <span class="tc" data-s="${i}">0</span></div>
        </div>
        <div class="text-xs text-gray-600 mt-1">
          LT: <span class="lt" data-s="${i}">0</span> | TH: <span class="th" data-s="${i}">0</span>
        </div>
        <div class="text-xs text-gray-600">
          TY: <span class="ty" data-s="${i}">0</span> | ĐY: <span class="dy" data-s="${i}">0</span> | KH: <span class="kh" data-s="${i}">0</span>
        </div>
      `;

      const list = document.createElement('div');
      list.className = 'min-h-[98px] rounded-xl border border-dashed border-gray-300 p-2 flex flex-wrap gap-2';
      list.dataset.dropzone = String(i);
      bindDropzone(list);

      wrap.appendChild(head);
      wrap.appendChild(list);
      semesterContainer.appendChild(wrap);
    }
  }

  function onDragStart(e) {
    const id = e.target?.dataset?.id;
    if (!id) return;
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  }
  function bindDropzone(el) {
    el.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; });
    el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const id = ev.dataTransfer.getData('text/plain');
      const s = Number(el.dataset.dropzone);
      if (!id || !s) return;
      moveCourseToSemester(id, s);
    });
  }

  // bank droppable (đưa về kho)
  bankEl.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; });
  bankEl.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    moveCourseToSemester(id, 0); // 0 = bank
  });

  function moveCourseToSemester(id, semester) {
    if (!courses.find(c => c.id === id)) return;

    // Xoá chip cũ
    document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach(n => n.remove());

    if (semester >= 1 && semester <= SEMESTERS) {
      assigns[id] = semester;

      const c = courses.find(x => x.id === id);
      const chip = document.createElement('div');
      chip.className = `chip ${khoiClass(c.khoi)}`;
      chip.draggable = true;
      chip.dataset.id = id;
      chip.title = `${c.label} — ${c.fullname}\n${creditOf(c)} tín chỉ (${c.lt||0} LT, ${c.th||0} TH)`;
      chip.innerHTML = `<span>${esc(c.label)}</span><span class="opacity-70">(${creditOf(c)})</span>`;
      chip.addEventListener('dragstart', onDragStart);

      const zone = document.querySelector(`[data-dropzone="${semester}"]`);
      zone?.appendChild(chip);
    } else {
      delete assigns[id];
      renderBank();
    }
    updateSemesterStats();
    validateConstraints();
    rebuildGraph();
    rebuildCharts();
  }

  // ---------- Per-semester stats ----------
  function updateSemesterStats() {
  const fmt = n => (Math.round(n * 100) / 100).toString();
  const stats = Array.from({ length: SEMESTERS }, () => ({
    tc: 0, lt: 0, th: 0, ty: 0, dy: 0, kh: 0
  }));

  // Dồn số liệu
  for (const id in assigns) {
    const sIndex = assigns[id] - 1; // 0..11
    const c = courses.find(x => x.id === id);
    if (!c || sIndex < 0) continue;

    const cc = creditOf(c);      // tổng TC của học phần
    stats[sIndex].tc += cc;      // Tổng TC
    stats[sIndex].lt += toNum(c.lt);
    stats[sIndex].th += toNum(c.th);

    const k = (c.khoi || '').toLowerCase();
    if (k.startsWith('tây')) stats[sIndex].ty += cc;                 // TY theo TC
    else if (k.startsWith('đông') || k.startsWith('dong')) stats[sIndex].dy += cc; // ĐY theo TC
    else stats[sIndex].kh += cc;                                     // KH theo TC
  }

  // Render ra DOM
  for (let i = 1; i <= SEMESTERS; i++) {
    const tcEl = document.querySelector(`.tc[data-s="${i}"]`);
    const ltEl = document.querySelector(`.lt[data-s="${i}"]`);
    const thEl = document.querySelector(`.th[data-s="${i}"]`);
    const tyEl = document.querySelector(`.ty[data-s="${i}"]`);
    const dyEl = document.querySelector(`.dy[data-s="${i}"]`);
    const khEl = document.querySelector(`.kh[data-s="${i}"]`);

    const s = stats[i - 1];
    if (tcEl) tcEl.textContent = fmt(s.tc);
    if (ltEl) ltEl.textContent = fmt(s.lt);
    if (thEl) thEl.textContent = fmt(s.th);
    if (tyEl) tyEl.textContent = fmt(s.ty);
    if (dyEl) dyEl.textContent = fmt(s.dy);
    if (khEl) khEl.textContent = fmt(s.kh);
  }

  bankStatus.textContent = `${Object.keys(assigns).length}/${courses.length} học phần đã xếp vào học kỳ`;
  }

  // ---------- Constraints ----------
  function addPrereq() {
    const from = prereqFrom.value, to = prereqTo.value;
    if (!from || !to || from === to) return alert('Chọn đúng 2 học phần (khác nhau).');
    if (!prerequisites.find(x => x.from === from && x.to === to)) {
      prerequisites.push({from, to});
      validateConstraints();
      rebuildGraph();
    }
  }
  function addCoreq() {
    const a = coreqA.value, b = coreqB.value;
    if (!a || !b || a === b) return alert('Chọn đúng 2 học phần (khác nhau).');
    if (!corequisites.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a))) {
      corequisites.push({a, b});
      validateConstraints();
      rebuildGraph();
    }
  }

  function delPrereq() {
  const from = prereqFrom.value, to = prereqTo.value;
  if (!from || !to || from === to) return alert('Chọn đúng 2 học phần (khác nhau).');

  const idx = prerequisites.findIndex(x => x.from === from && x.to === to);
  if (idx === -1) return alert('Không tìm thấy ràng buộc tiên quyết cần xóa.');

  prerequisites.splice(idx, 1);
  validateConstraints();
  rebuildGraph();
}

function delCoreq() {
  const a = coreqA.value, b = coreqB.value;
  if (!a || !b || a === b) return alert('Chọn đúng 2 học phần (khác nhau).');

  const idx = corequisites.findIndex(x =>
    (x.a === a && x.b === b) || (x.a === b && x.b === a)
  );
  if (idx === -1) return alert('Không tìm thấy ràng buộc song hành cần xóa.');

  corequisites.splice(idx, 1);
  validateConstraints();
  rebuildGraph();
}

  function validateConstraints() {
    const lines = [];
    prerequisites.forEach(({from, to}) => {
      const s1 = assigns[from], s2 = assigns[to];
      if (!s1 || !s2) return;
      if (!(s1 < s2)) {
        const cf = courses.find(c => c.id === from);
        const ct = courses.find(c => c.id === to);
        lines.push(`Tiên quyết: ${cf?.label} phải ở HK < ${ct?.label} (hiện: ${s1} → ${s2})`);
      }
    });
    corequisites.forEach(({a,b}) => {
      const s1 = assigns[a], s2 = assigns[b];
      if (!s1 || !s2) return;
      if (s1 !== s2) {
        const ca = courses.find(c => c.id === a);
        const cb = courses.find(c => c.id === b);
        lines.push(`Song hành: ${ca?.label} phải cùng HK với ${cb?.label} (hiện: ${s1} ≠ ${s2})`);
      }
    });
    violationsEl.innerHTML = lines.length ? ('• ' + lines.join('<br>• ')) : '<span class="text-green-700">Không có vi phạm.</span>';
  }

  // ---------- Graph ----------
  function rebuildGraph() {
    const elements = [];
    courses.forEach(c => {
      elements.push({ data: { id: c.id, label: c.label, khoi: c.khoi, sem: assigns[c.id] || 0 } });
    });
    prerequisites.forEach(({from,to},i) => elements.push({ data: { id:`pre_${i}`, source: from, target: to, type:'pre' } }));
    corequisites.forEach(({a,b},i) => elements.push({ data: { id:`co_${i}`, source: a, target: b, type:'co' } }));

    if (cy) cy.destroy();
    cy = cytoscape({
      container: document.getElementById('cy'),
      elements,
      style: [
        { selector: 'node', style: {
          'label':'data(label)','text-valign':'center','font-size':10,
          'background-color': (ele) => {
            const k = (ele.data('khoi')||'').toLowerCase();
            if (k.startsWith('tây')) return '#CFE3FA';
            if (k.startsWith('đông') || k.startsWith('dong')) return '#CFEFE0';
            return '#FFF0C8';
          },
          'border-color': '#94a3b8','border-width':1
        }},
        { selector: 'edge', style: {
          'width':2,'line-color':'#9ca3af','curve-style':'bezier',
          'target-arrow-shape':'triangle','target-arrow-color':'#9ca3af'
        }},
        { selector: 'edge[type="co"]', style: {
          'line-style':'dashed','target-arrow-shape':'none'
        }}
      ],
      layout: { name:'cose', animate:true, nodeRepulsion: 12000, idealEdgeLength: 120, padding: 20 }
    });
  }

  // ---------- Charts ----------
  function rebuildCharts() {
    rebuildKhoiChart();
    rebuildTypeChart();
  }

  function rebuildKhoiChart() {
    if (creditChart) { creditChart.destroy(); creditChart = null; }

    const years = [1,2,3,4,5,6];
    const buckets = { tay: [0,0,0,0,0,0], dong: [0,0,0,0,0,0], ket: [0,0,0,0,0,0] };

    for (const id in assigns) {
      const sem = assigns[id];
      const yearIndex = Math.ceil(sem / 2) - 1; // 0..5
      const c = courses.find(x => x.id === id);
      if (!c) continue;
      const cc = creditOf(c);
      const k = (c.khoi || '').toLowerCase();
      if (k.startsWith('tây')) buckets.tay[yearIndex] += cc;
      else if (k.startsWith('đông') || k.startsWith('dong')) buckets.dong[yearIndex] += cc;
      else buckets.ket[yearIndex] += cc;
    }

    const ctx = document.getElementById('creditChart');
    creditChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: years.map(y => `Năm ${y}`),
        datasets: [
          { label: 'Tây', data: buckets.tay, stack: 'khoi' },
          { label: 'Đông', data: buckets.dong, stack: 'khoi' },
          { label: 'Kết hợp', data: buckets.ket, stack: 'khoi' },
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display:true, text:'Tín chỉ' } } }
      }
    });
  }

  function rebuildTypeChart() {
    if (typeChart) { typeChart.destroy(); typeChart = null; }

    const years = [1,2,3,4,5,6];

    // Lấy danh sách type xuất hiện
    const typeSet = new Set();
    courses.forEach(c => typeSet.add((c.type || 'Khác').trim() || 'Khác'));
    const types = Array.from(typeSet);

    // Khởi tạo buckets
    const bucketsByType = {};
    types.forEach(t => { bucketsByType[t] = [0,0,0,0,0,0]; });

    // Dồn tín chỉ theo năm & type
    for (const id in assigns) {
      const sem = assigns[id];
      const yearIndex = Math.ceil(sem / 2) - 1; // 0..5
      const c = courses.find(x => x.id === id);
      if (!c) continue;
      const cc = creditOf(c);
      const t = (c.type || 'Khác').trim() || 'Khác';
      if (!bucketsByType[t]) bucketsByType[t] = [0,0,0,0,0,0];
      bucketsByType[t][yearIndex] += cc;
    }

    // Màu sắc dataset (vòng qua palette thương hiệu)
    const palette = [
      '#0E7BD0', '#2BAE72', '#FFB000', '#7C3AED', '#EA580C', '#059669',
      '#2563EB', '#9333EA', '#DC2626', '#0D9488'
    ];

    const datasets = types.map((t, idx) => ({
      label: t,
      data: bucketsByType[t],
      stack: 'type',
      backgroundColor: palette[idx % palette.length]
    }));

    const ctx = document.getElementById('typeChart');
    typeChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: years.map(y => `Năm ${y}`),
        datasets
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display:true, text:'Tín chỉ' } } }
      }
    });
  }

  // ---------- Import/Export ----------
  function exportAssignmentCSV() {
    // Xuất chi tiết để tiện kiểm toán & báo cáo
    const rows = [['label','semester','fullname','lt','th','tong','group','khoi','type']];
    courses.forEach(c => {
      const sem = assigns[c.id] || '';
      rows.push([
        c.label, sem, c.fullname || '', c.lt || '', c.th || '',
        creditOf(c), c.group || '', c.khoi || '', c.type || ''
      ]);
    });
    const csv = '\ufeff' + rows.map(r => r.map(x => {
      const s = String(x).replace(/"/g,'""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }).join(',')).join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'phan_bo_khung.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function importAssignmentCSV(file) {
    const rows = await parseCSV(file);
    let placed = 0, skipped = 0;

    // clear current placements
    for (const id in assigns) delete assigns[id];
    document.querySelectorAll('[data-dropzone]').forEach(z => z.innerHTML = '');

    rows.forEach(r => {
      const label = (r.label || '').trim();
      const sem = Math.round(toNum(r.semester));
      const c = courses.find(x => x.label === label);
      if (!c || !(sem >=1 && sem <=12)) { skipped++; return; }
      moveCourseToSemester(c.id, sem);
      placed++;
    });

    renderBank();
    updateSemesterStats();
    validateConstraints();
    rebuildGraph();
    rebuildCharts();

    alert(`Tải CSV phân bổ: xếp ${placed}, bỏ qua ${skipped}.`);
  }

  // ---------- Load Courses CSV ----------
  async function onLoadCoursesCSV(file) {
    const rows = await parseCSV(file);
    courses = rows.map((r, idx) => ({
      id: (r.label || `C${idx+1}`).trim(),
      label: (r.label || `C${idx+1}`).trim(),
      fullname: r.fullname || '',
      lt: toNum(r.lt),
      th: toNum(r.th),
      tong: (r.tong!==undefined && r.tong!=='' ? toNum(r.tong) : (toNum(r.lt)+toNum(r.th))),
      group: r.group || '',
      khoi: r.khoi || '',
      type: r.type || ''
    }));

    // Reset placements & constraints
    for (const k in assigns) delete assigns[k];
    prerequisites.length = 0; corequisites.length = 0;

    renderBank();
    createSemesters();
    updateSemesterStats();
    populateCourseSelects();
    rebuildGraph();
    rebuildCharts();
  }

  // ---------- Events ----------
  csvCoursesInput?.addEventListener('change', e => {
    const f = e.target.files?.[0]; if (!f) return;
    onLoadCoursesCSV(f).catch(err => alert('Không đọc được CSV học phần: ' + err));
  });

  btnClearBank?.addEventListener('click', () => {
    courses = [];
    for (const k in assigns) delete assigns[k];
    bankEl.innerHTML = '';
    semesterContainer.innerHTML = '';
    bankStatus.textContent = '';
    if (cy) { cy.destroy(); cy=null; }
    if (creditChart) { creditChart.destroy(); creditChart=null; }
    if (typeChart) { typeChart.destroy(); typeChart=null; }
    [prereqFrom, prereqTo, coreqA, coreqB].forEach(sel => sel.innerHTML = '<option value="">—</option>');
    violationsEl.innerHTML = '';
  });

  btnExportAssign?.addEventListener('click', exportAssignmentCSV);
  fileAssignCsv?.addEventListener('change', e => {
    const f = e.target.files?.[0]; if (!f) return;
    importAssignmentCSV(f).catch(err => alert('Không đọc được CSV phân bổ: ' + err));
  });

  btnAddPrereq?.addEventListener('click', addPrereq);
  btnAddCoreq?.addEventListener('click', addCoreq);
  document.getElementById('btnDelPrereq')?.addEventListener('click', delPrereq);
  document.getElementById('btnDelCoreq')?.addEventListener('click', delCoreq);

  btnRefreshCharts?.addEventListener('click', () => rebuildCharts());

  // Init bare UI
  createSemesters();
})();
