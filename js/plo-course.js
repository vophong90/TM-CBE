// ========================= PLO–Course MATRIX (CSV-driven) =========================
// Người dùng upload:
//   - PLO.csv:     label,content
//   - COURSE.csv:  id,label,fullname,group
//
// Kết nối nhập/xuất dạng CSV:
//   - plo_label,course_id,level   (level ∈ {I,R,M,A})
//
// Phụ thuộc: Cytoscape 3.x, PapaParse 5.x, Tailwind (đã link trong HTML), styles.css (đã có)

let cy;                         // cytoscape instance
let selectedEdge = null;        // cạnh đang chọn
let undoStack = [];             // stack để undo xóa

// Dữ liệu sau khi nạp CSV
let PLO_LABELS = {};            // { "PLO1": "nội dung...", ... }   key = PLO label
let PLO_KEYS = [];              // ["PLO1", "PLO2", ...]
let HP_INFO = {};               // { "C001": { label, fullname, group }, ... }   key = Course id

// Lưu tạm rows đã parse từ CSV
let _ploRows = null, _courseRows = null;

// Màu theo group Course
const groupColors = {
  'Đại cương': '#90CAF9',
  'Cơ sở ngành': '#A5D6A7',
  'Ngành': '#FFCC80',
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
function levelColor(level) {
  return { I: '#CCCCCC', R: '#2196F3', M: '#FFC107', A: '#F44336' }[level] || '#888';
}
function csvQuote(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g,'""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

// -------------------------- Build Graph --------------------------
function buildElements() {
  const ploNodes = PLO_KEYS.map(p => ({ data: { id: p, label: p } }));
  const courseNodes = Object.keys(HP_INFO).map(cid => ({
    data: { id: cid, label: HP_INFO[cid].label || HP_INFO[cid].fullname || cid },
    classes: HP_INFO[cid].group
  }));
  return [...ploNodes, ...courseNodes];
}

function createCy(elements) {
  if (cy) cy.destroy();
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: [
      { selector: 'node', style: {
        'label': 'data(label)',
        'text-valign': 'center',
        'color': '#000',
        'background-color': ele => {
          const id = ele.id();
          if (PLO_LABELS[id]) return '#A3C4DC'; // PLO xanh nhạt
          if (HP_INFO[id])   return groupColors[HP_INFO[id].group] || '#ccc'; // Course theo group
          return '#ccc';
        },
        'font-size': '11px'
      }},
      { selector: 'edge', style: {
        'width': 3,
        'label': 'data(level)',
        'line-color': ele => levelColor(ele.data('level')),
        'target-arrow-shape': 'triangle',
        'target-arrow-color': ele => levelColor(ele.data('level')),
        'curve-style': 'bezier',
        'font-size': 12,
        'text-background-color': '#fff',
        'text-background-opacity': 1,
        'text-background-padding': 2
      }},
      { selector: '.node-dimmed', style: { 'opacity': 0.12 } },
      { selector: '.edge-dimmed', style: { 'opacity': 0.05 } },
      { selector: '.edge.selected', style: { 'line-color': 'red', 'target-arrow-color': 'red', 'width': 4 } },
    ],
    layout: { name: 'cose', animate: true, nodeRepulsion: 12000, idealEdgeLength: 120, edgeElasticity: 0.2, gravity: 1, numIter: 2000, fit: true, padding: 40 }
  });

  wireCyEvents();
  refreshUIAfterGraphChange();
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
      tooltip.innerHTML = `<strong>${fullname || label || id}</strong><br>${label ? `Mã: ${id} — ${label}<br>` : `Mã: ${id}<br>`}Nhóm: ${group || ''}`;
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

  // Cập nhật bảng/dropdowns nếu có thay đổi lớn
  cy.on('add remove data', () => refreshUIAfterGraphChange());
}

// -------------------------- UI Refresh (dropdowns + tables) --------------------------
function refreshUIAfterGraphChange() {
  populateDropdowns();
  buildMatrixHeader();
  updateSummaryTable();
  updateMatrixTable();
}

function populateDropdowns() {
  const ploAdd = document.getElementById('plo-add');
  const hpAdd  = document.getElementById('hp-add');
  if (ploAdd) ploAdd.innerHTML = '';
  if (hpAdd)  hpAdd.innerHTML  = '';

  PLO_KEYS.forEach(p => {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
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
  const cols = ['<th>Course (fullname)</th>'].concat(PLO_KEYS.map(p => `<th>${p}</th>`));
  thead.innerHTML = `<tr>${cols.join('')}</tr>`;
}

// Đếm & render summary theo Course
function updateSummaryTable() {
  const counts = {};  // { courseId: {I,R,M,A} }
  cy?.edges().forEach(e => {
    const cid = e.data('target'); // target = Course
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

// Render ma trận PLO × Course (cell = level nếu có)
function updateMatrixTable() {
  const matrix = {}; // { courseId: { PLO: level } }
  cy?.edges().forEach(e => {
    const plo = e.data('source');   // source = PLO
    const cid = e.data('target');   // target = Course
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

  // Build PLO_LABELS / PLO_KEYS
  PLO_LABELS = {}; PLO_KEYS = [];
  _ploRows.forEach(r => {
    // hỗ trợ header chữ hoa/thường
    const label = (r.label || r.LABEL || '').trim();
    const content = (r.content || r.CONTENT || '').trim();
    if (label) { PLO_LABELS[label] = content; PLO_KEYS.push(label); }
  });

  // Build HP_INFO
  HP_INFO = {};
  _courseRows.forEach(r => {
    const id = (r.id || r.ID || '').trim();
    if (!id) return;
    HP_INFO[id] = {
      label:    (r.label || r.LABEL || '').trim(),
      fullname: (r.fullname || r.FULLNAME || '').trim(),
      group:    (r.group || r.GROUP || '').trim(),
      // credit:  có thể thêm nếu CSV có cột credit; tạm thời để trống
    };
  });

  // Tạo lại đồ thị
  createCy(buildElements());
  document.getElementById('buildStatus').textContent = 'Đã dựng đồ thị từ CSV.';
}

// -------------------------- Connection Ops --------------------------
function addConnection() {
  if (!cy) return;
  const plo = document.getElementById('plo-add').value; // PLO label
  const cid = document.getElementById('hp-add').value;  // Course id
  const lvl = document.getElementById('level-add').value || 'I';
  if (!plo || !cid) { alert('Chọn PLO và Course trước.'); return; }

  if (!PLO_LABELS[plo]) { alert('PLO không tồn tại.'); return; }
  if (!HP_INFO[cid])    { alert('Course không tồn tại.'); return; }

  const id = `e_${plo}_${cid}`;
  if (cy.getElementById(id).length) {
    alert('Kết nối đã tồn tại.');
    return;
  }
  cy.add({ data: { id, source: plo, target: cid, level: lvl, label: lvl }});
  cy.layout({ name: 'cose', animate: true }).run();
}

function updateSelectedEdgeLevel() {
  if (!selectedEdge) { alert('Chưa chọn cạnh nào.'); return; }
  const lv = document.getElementById('level-select').value || 'I';
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
    plo_label: e.data('source'),   // source = PLO label
    course_id: e.data('target'),   // target = Course id
    level:     e.data('level') || ''
  }));
  const heads = ['plo_label','course_id','level'];
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
  data.forEach(r => {
    const plo = (r.plo_label || r.PLO || '').trim();
    const cid = (r.course_id || r.COURSE || '').trim();
    const lv  = (r.level || r.LEVEL || '').trim() || 'I';
    if (!plo || !cid) return;
    // Chỉ tạo nếu node tồn tại
    if (!PLO_LABELS[plo] || !HP_INFO[cid]) return;
    const id = `e_${plo}_${cid}`;
    if (!cy.getElementById(id).length) {
      cy.add({ data: { id, source: plo, target: cid, level: lv, label: lv }});
    }
  });
  cy.layout({ name: 'cose', animate: true }).run();
}

// -------------------------- Wire DOM --------------------------
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnBuild')?.addEventListener('click', bootFromCsvInputs);
  document.getElementById('btnAdd')?.addEventListener('click', addConnection);
  document.getElementById('btnUpdateLevel')?.addEventListener('click', updateSelectedEdgeLevel);
  document.getElementById('btnDelete')?.addEventListener('click', deleteSelectedEdge);
  document.getElementById('btnUndo')?.addEventListener('click', undoDelete);

  document.getElementById('btnExportCSV')?.addEventListener('click', exportConnectionsCSV);
  document.getElementById('connCsvInput')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (!cy) { alert('Hãy dựng đồ thị từ CSV trước.'); return; }
    importConnectionsCSV(f).catch(err => alert('Không đọc được CSV kết nối: ' + err));
  });
});
