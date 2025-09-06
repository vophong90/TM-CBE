/* Phân bổ khung
 * - Nạp kho học phần từ CSV: label, fullname, lt, th, group, khoi, type, tong
 * - Kéo-thả vào 12 học kỳ; tín chỉ tính theo 'tong' (nếu không có thì lt+th)
 * - Xuất/Tải CSV phân bổ (label,semester) + exporter chi tiết (kèm fullname, lt, th, tong, group, khoi, type)
 * - Ràng buộc tiên quyết (from→to) và song hành (a↔b) + đồ thị Cytoscape
 * - Biểu đồ tín chỉ theo khối (Tây/Đông/Kết hợp) và theo năm (1..6)
 */

(function () {
  // ---------- State ----------
  let courses = [];                     // [{id,label,fullname,lt,th,tong,group,khoi,type}]
  const assigns = {};                   // { id: semester (1..12) } ; không có nghĩa là ở kho
  const prerequisites = [];             // [{from, to}]
  const corequisites  = [];             // [{a, b}]
  let cy = null;                        // Cytoscape
  let creditChart = null;               // Chart.js

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
    // convert "1,5" -> 1.5 ; "1.0" -> 1
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

  function creditOf(c) { return c.tong != null ? toNum(c.tong) : (toNum(c.lt) + toNum(c.th)); }

  const khoiClass = (khoi) => {
    const k = (khoi || '').toLowerCase();
    if (k.startsWith('tây')) return 'khoi-tay';
    if (k.startsWith('đông') || k.startsWith('dong')) return 'khoi-dong';
    return 'khoi-ket'; // Kết hợp (mặc định)
  };

  // ---------- Courses bank ----------
  function renderBank() {
    bankEl.innerHTML = '';
    courses.forEach(c => {
      // nếu đã xếp vào học kỳ thì không hiển thị trong bank
      if (assigns[c.id]) return;

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
      head.className = 'flex items-center justify-between mb-2';
      head.innerHTML = `
        <div class="font-semibold">Học kỳ ${i}</div>
        <div class="text-sm text-gray-600">TC: <span class="tc" data-s="${i}">0</span></div>
      `;

      const list = document.createElement('div');
      list.className = 'min-h-[88px] rounded-xl border border-dashed border-gray-300 p-2 flex flex-wrap gap-2';
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

    // Xoá chip cũ ở bất kỳ nơi nào
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
      // trả về bank
      renderBank();
    }
    updateSemesterCredits();
    validateConstraints();
    rebuildGraph();
  }

  function updateSemesterCredits() {
    const totals = Array.from({length: SEMESTERS}, () => 0);
    for (const id in assigns) {
      const s = assigns[id] - 1;
      const c = courses.find(x => x.id === id);
      if (c && s >= 0) totals[s] += creditOf(c);
    }
    document.querySelectorAll('.tc').forEach(span => {
      const s = Number(span.dataset.s);
      span.textContent = (totals[s-1] || 0).toString();
    });
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

  function validateConstraints() {
    const lines = [];
    // Tiên quyết: from < to
    prerequisites.forEach(({from, to}) => {
      const s1 = assigns[from], s2 = assigns[to];
      if (!s1 || !s2) return; // chưa xếp: bỏ qua cảnh báo
      if (!(s1 < s2)) {
        const cf = courses.find(c => c.id === from);
        const ct = courses.find(c => c.id === to);
        lines.push(`Tiên quyết: ${cf?.label} phải ở HK < ${ct?.label} (hiện: ${s1} → ${s2})`);
      }
    });
    // Song hành: a == b
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
  function rebuildChart() {
    if (creditChart) { creditChart.destroy(); creditChart = null; }

    // Tính theo năm & khối
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
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display:true, text:'Tín chỉ' } } }
      }
    });
  }

  // ---------- Import/Export ----------
  function exportAssignmentCSV() {
    // Ghi chi tiết để tiện kiểm toán
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
    updateSemesterCredits();
    validateConstraints();
    rebuildGraph();
    rebuildChart();

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

    // Render
    renderBank();
    createSemesters();
    updateSemesterCredits();
    populateCourseSelects();
    rebuildGraph();
    rebuildChart();
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

  btnRefreshCharts?.addEventListener('click', () => rebuildChart());

  // Init bare UI
  createSemesters();
})();
