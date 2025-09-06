// ========================= PLO–PI Mapping (CSV-driven) =========================
// Người dùng upload:
//   - PLO.csv: label,content
//   - PI.csv:  label,content
//
// Chức năng:
//   - Vẽ mạng lưới PLO ↔ PI (Cytoscape)
//   - Thêm / Xoá kết nối giữa PLO và PI (click edge để chọn, rồi Xoá/Hoàn tác)
//   - Tooltip hiển thị content khi rê chuột vào node
//   - Bảng kết quả (PLO, PI) + bộ lọc theo PLO/PI
//
// Phụ thuộc: Cytoscape 3.x, PapaParse 5.x

let cy;                       // cytoscape instance
let selectedEdge = null;      // cạnh đang chọn
let undoStack = [];           // stack để hoàn tác xóa

// Dữ liệu sau khi nạp CSV
let PLO = {};                 // { "PLO1": "content...", ... }
let PIs = {};                 // { "PI1": "content...", ... }
let PLO_KEYS = [];
let PI_KEYS = [];

// --------- Helpers ---------
function parseCsvFromInput(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: res => resolve(res.data), error: reject
    });
  });
}
function buildElements() {
  const ploNodes = PLO_KEYS.map(l => ({ data: { id: `PLO::${l}`, type: 'PLO', label: l } }));
  const piNodes  = PI_KEYS.map(l => ({ data: { id: `PI::${l}`,  type: 'PI',  label: l } }));
  return [...ploNodes, ...piNodes];
}
function nodeIsPLO(ele){ return ele.data('type') === 'PLO'; }
function nodeIsPI(ele){ return ele.data('type') === 'PI'; }

// --------- Graph ---------
function createCy(elements) {
  if (cy) cy.destroy();
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: [
      { selector: 'node', style: {
        'label': 'data(label)',
        'text-valign': 'center',
        'font-size': 11,
        'color': '#000',
        'background-color': (ele) => nodeIsPLO(ele) ? '#CFE8FF' : '#FFE7A8',
        'border-color': (ele) => nodeIsPLO(ele) ? '#0E7BD0' : '#B7791F',
        'border-width': 1.2
      }},
      { selector: 'edge', style: {
        'width': 3,
        'line-color': '#94a3b8',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#94a3b8',
        'curve-style': 'bezier'
      }},
      { selector: '.node-dimmed', style: { 'opacity': 0.15 } },
      { selector: '.edge-dimmed', style: { 'opacity': 0.06 } },
      { selector: '.edge.selected', style: { 'line-color': '#ef4444', 'target-arrow-color': '#ef4444', 'width': 4 } },
    ],
    layout: { name: 'cose', animate: true, nodeRepulsion: 12000, idealEdgeLength: 120, gravity: 1, numIter: 1500, fit: true, padding: 40 }
  });

  wireCyEvents();
  refreshUI();
}

// --------- Events ---------
function wireCyEvents() {
  const tooltip = document.getElementById('tooltip');

  cy.on('tap', 'edge', (evt) => {
    if (selectedEdge) selectedEdge.removeClass('selected');
    selectedEdge = evt.target;
    selectedEdge.addClass('selected');
  });

  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      cy.nodes().removeClass('node-dimmed');
      cy.edges().removeClass('edge-dimmed');
      if (selectedEdge) { selectedEdge.removeClass('selected'); selectedEdge = null; }
    }
  });

  cy.on('tap', 'node', (evt) => {
    const n = evt.target;
    cy.nodes().addClass('node-dimmed');
    cy.edges().addClass('edge-dimmed');
    n.removeClass('node-dimmed');
    n.connectedEdges().forEach(e => {
      e.removeClass('edge-dimmed');
      e.source().removeClass('node-dimmed');
      e.target().removeClass('node-dimmed');
    });
  });

  // Tooltip
  cy.on('mouseover', 'node', (evt) => {
    const id = evt.target.id(); // e.g., "PLO::PLO1"
    const [kind, label] = id.split('::');
    const content = (kind === 'PLO') ? PLO[label] : PIs[label];
    tooltip.innerHTML = `<strong>${label}</strong><br>${content || ''}`;
    tooltip.style.display = 'block';
  });
  cy.on('mouseout', 'node', () => tooltip.style.display = 'none');
  cy.on('mousemove', (evt) => {
    if (tooltip.style.display === 'block') {
      tooltip.style.left = (evt.originalEvent.pageX + 10) + 'px';
      tooltip.style.top  = (evt.originalEvent.pageY + 10) + 'px';
    }
  });

  cy.on('add remove', () => refreshUI());
}

// --------- File → Build ---------
async function bootFromCsvInputs() {
  const fPlo = document.getElementById('ploCsvInput')?.files?.[0];
  const fPi  = document.getElementById('piCsvInput')?.files?.[0];
  if (!fPlo || !fPi) { alert('Hãy chọn đủ PLO.csv và PI.csv'); return; }

  const ploRows = await parseCsvFromInput(fPlo);
  const piRows  = await parseCsvFromInput(fPi);

  PLO = {}; PLO_KEYS = [];
  ploRows.forEach(r => {
    const label = (r.label || r.LABEL || '').trim();
    const content = (r.content || r.CONTENT || '').trim();
    if (label) { PLO[label] = content; PLO_KEYS.push(label); }
  });

  PIs = {}; PI_KEYS = [];
  piRows.forEach(r => {
    const label = (r.label || r.LABEL || '').trim();
    const content = (r.content || r.CONTENT || '').trim();
    if (label) { PIs[label] = content; PI_KEYS.push(label); }
  });

  createCy(buildElements());
  document.getElementById('buildStatus').textContent = 'Đã dựng đồ thị từ CSV.';
}

// --------- UI (dropdowns + table) ---------
function populateDropdowns() {
  const ploAdd = document.getElementById('plo-add');
  const piAdd  = document.getElementById('pi-add');
  const fPlo   = document.getElementById('filter-plo');
  const fPi    = document.getElementById('filter-pi');

  if (ploAdd) ploAdd.innerHTML = '';
  if (piAdd)  piAdd.innerHTML  = '';
  if (fPlo)   fPlo.innerHTML   = '<option value="">— Tất cả PLO —</option>';
  if (fPi)    fPi.innerHTML    = '<option value="">— Tất cả PI —</option>';

  PLO_KEYS.forEach(l => {
    const o1 = document.createElement('option'); o1.value = l; o1.textContent = l; ploAdd?.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = l; o2.textContent = l; fPlo?.appendChild(o2);
  });
  PI_KEYS.forEach(l => {
    const o1 = document.createElement('option'); o1.value = l; o1.textContent = l; piAdd?.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = l; o2.textContent = l; fPi?.appendChild(o2);
  });
}

function updateTable() {
  const tbody = document.querySelector('#resultTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const fPlo = document.getElementById('filter-plo')?.value || '';
  const fPi  = document.getElementById('filter-pi')?.value || '';

  const rows = [];
  cy?.edges().forEach(e => {
    const s = e.source().data('label'); // PLO label
    const t = e.target().data('label'); // PI label
    if ((fPlo && s !== fPlo) || (fPi && t !== fPi)) return;
    rows.push([s, t]);
  });

  // sort để dễ đọc
  rows.sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  rows.forEach(([s,t]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="border p-2">${s}</td><td class="border p-2">${t}</td>`;
    tbody.appendChild(tr);
  });

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="border p-2 text-gray-500" colspan="2"><i>Không có kết quả phù hợp bộ lọc.</i></td>`;
    tbody.appendChild(tr);
  }
}

function refreshUI() {
  populateDropdowns();
  updateTable();
}

// --------- Connection ops ---------
function addConnection() {
  if (!cy) return;
  const s = document.getElementById('plo-add').value; // PLO label
  const t = document.getElementById('pi-add').value;  // PI label
  if (!s || !t) { alert('Chọn PLO và PI trước.'); return; }
  if (!PLO[s])  { alert('PLO không tồn tại.'); return; }
  if (!PIs[t])  { alert('PI không tồn tại.'); return; }

  const sid = `PLO::${s}`, tid = `PI::${t}`;
  const id  = `e_${s}__${t}`;
  if (cy.getElementById(id).length) { alert('Kết nối đã tồn tại.'); return; }

  cy.add({ data: { id, source: sid, target: tid } });
  cy.layout({ name: 'cose', animate: true }).run();
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

// --------- Wire DOM ---------
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnBuild')?.addEventListener('click', bootFromCsvInputs);
  document.getElementById('btnAdd')?.addEventListener('click', addConnection);
  document.getElementById('btnDelete')?.addEventListener('click', deleteSelectedEdge);
  document.getElementById('btnUndo')?.addEventListener('click', undoDelete);

  document.getElementById('filter-plo')?.addEventListener('change', updateTable);
  document.getElementById('filter-pi')?.addEventListener('change', updateTable);
  document.getElementById('btnClearFilters')?.addEventListener('click', () => {
    const a = document.getElementById('filter-plo'); if (a) a.value = '';
    const b = document.getElementById('filter-pi');  if (b) b.value = '';
    updateTable();
  });
});
