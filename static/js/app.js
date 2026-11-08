import {COLORS, ImageViewer} from './viewer.js';
import {escapeHTML, exportResult} from './exports.js';

const $ = selector => document.querySelector(selector);
const viewer = new ImageViewer($('#inspection-canvas'));
const state = {
  queue: [], history: [], selected: null, busy: false, importing: false, ready: false,
  maxBytes: 25 * 1024 * 1024, classes: [], examples: [], exampleIndex: 0,
  sort: {key: 'confidence', direction: -1}, nextId: 1,
};
let toastTimer;

async function request(url, options) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error('Connexion au serveur impossible. Vérifiez que l’application est démarrée.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `La requête a échoué (HTTP ${response.status}).`);
  }
  return response;
}

function showError(message) {
  $('#error-text').textContent = message;
  $('#error-banner').hidden = false;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

function updateControls() {
  const locked = state.busy || state.importing;
  $('#analyze-button').disabled = locked || !state.ready || !state.queue.length;
  $('#analyze-button span').textContent = state.importing ? 'Préparation des images…' : state.busy ? 'Analyse en cours…' : state.queue.length > 1 ? `Analyser les ${state.queue.length} images` : 'Lancer l’analyse';
  $('#confidence').disabled = locked;
  $('#iou').disabled = locked;
  $('#file-input').disabled = locked;
  $('#example-button').disabled = locked;
  $('#drop-zone').setAttribute('aria-disabled', String(locked));
  $('#clear-history').disabled = locked || !state.history.length;
  $('#workspace-state').textContent = state.busy ? 'Analyse en cours' : state.selected ? 'Image chargée' : 'En attente d’une image';
  $('#loading-overlay').hidden = !state.busy || state.selected?.status !== 'analyzing';
  renderQueue();
}

function renderQueue() {
  const labels = {pending: 'Prête', analyzing: 'Analyse…', done: 'Terminée', error: 'Erreur'};
  $('#queue').innerHTML = state.queue.map(item => `<div class="queue-item ${state.selected?.id === item.id ? 'selected' : ''}"><button class="queue-select" data-select="${item.id}" aria-label="Afficher ${escapeHTML(item.file.name)}" ${state.busy ? 'disabled' : ''} style="flex:1;min-width:0;text-align:left;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(item.file.name)}</button><small>${labels[item.status]}</small><button data-remove="${item.id}" aria-label="Retirer ${escapeHTML(item.file.name)}" ${state.busy ? 'disabled' : ''}>×</button></div>`).join('');
}

function imageFromURL(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Impossible de prévisualiser cette image.'));
    image.src = url;
  });
}

async function addFiles(files) {
  if (state.busy || state.importing) return;
  state.importing = true;
  $('#error-banner').hidden = true;
  updateControls();
  const errors = [];
  try {
    for (const file of files) {
      if (file.size > state.maxBytes) {
        errors.push(`${file.name} : la limite est de ${Math.round(state.maxBytes / 1024 / 1024)} Mo par image.`);
        continue;
      }
      let url;
      try {
        const form = new FormData();
        form.append('file', file);
        const response = await request('/api/preview', {method: 'POST', body: form});
        url = URL.createObjectURL(await response.blob());
        const image = await imageFromURL(url);
        const item = {id: state.nextId++, file, image, url, result: null, status: 'pending', error: ''};
        state.queue.push(item);
        showEntry(item);
        renderQueue();
      } catch (error) {
        if (url) URL.revokeObjectURL(url);
        errors.push(`${file.name} : ${error.message}`);
      }
    }
  } finally {
    state.importing = false;
    $('#file-input').value = '';
    if (errors.length) showError(errors.join(' '));
    updateControls();
    renderBatch();
  }
}

function resetView() {
  state.selected = null;
  viewer.image = null;
  viewer.detections = [];
  viewer.draw();
  $('#empty-state').hidden = false;
  $('#viewer-area').hidden = true;
  $('#result-summary').hidden = true;
  $('#details-area').hidden = true;
  updateControls();
}

function showEntry(entry) {
  state.selected = entry;
  $('#empty-state').hidden = true;
  $('#viewer-area').hidden = false;
  $('#image-filename').textContent = entry.file.name;
  $('#image-filename').title = entry.file.name;
  $('#image-dimensions').textContent = `${entry.image.naturalWidth} × ${entry.image.naturalHeight} px`;
  viewer.setImage(entry.image, entry.result?.detections || []);
  $('#inspection-canvas').setAttribute('aria-label', `${entry.file.name}, ${entry.result ? entry.result.total + ' défaut(s) détecté(s)' : 'image prête à analyser'}. Plus et moins : zoom ; flèches : déplacement ; zéro : ajuster.`);
  $('#toggle-boxes').setAttribute('aria-pressed', String(viewer.boxesVisible));
  $('#result-summary').hidden = !entry.result;
  $('#details-area').hidden = !entry.result;
  if (entry.result) {
    const result = entry.result;
    $('#verdict').textContent = result.total ? `${result.total} défaut(s) détecté(s)` : 'Aucun défaut détecté';
    $('#verdict').classList.toggle('clean', !result.total);
    $('#inference-time').textContent = `${Math.round(result.inference_ms)} ms · ${result.device.toUpperCase()} · Confiance ${Math.round(result.conf * 100)} % · IoU ${result.iou.toLocaleString('fr-FR')}`;
    $('#detection-count').textContent = result.total;
    renderDetections();
    renderLegend();
  }
  updateControls();
}

function sortedDetections() {
  return (state.selected?.result?.detections || []).map((detection, index) => ({...detection, index})).sort((a, b) => {
    const key = state.sort.key;
    let comparison;
    if (key === 'class_name') comparison = a.class_name.localeCompare(b.class_name);
    else if (key === 'position') comparison = a.bbox.x1 - b.bbox.x1 || a.bbox.y1 - b.bbox.y1;
    else if (key === 'size') comparison = (a.bbox.x2 - a.bbox.x1) * (a.bbox.y2 - a.bbox.y1) - (b.bbox.x2 - b.bbox.x1) * (b.bbox.y2 - b.bbox.y1);
    else comparison = a.confidence - b.confidence;
    return comparison * state.sort.direction;
  });
}

function renderDetections() {
  const detections = sortedDetections();
  $('#detections-body').innerHTML = detections.length ? detections.map(d => `<tr data-id="${d.index}" data-hidden="${viewer.hidden.has(d.class_id)}" tabindex="0" aria-label="Détection ${d.index + 1}, ${escapeHTML(d.class_name)}, cliquer pour zoomer"><td>${String(d.index + 1).padStart(2, '0')}</td><td><span class="swatch" style="background:${COLORS[d.class_id]}"></span>${escapeHTML(d.class_name)}</td><td><span class="confidence-pill">${(d.confidence * 100).toFixed(1)} %</span></td><td>${d.bbox.x1.toFixed(1)}, ${d.bbox.y1.toFixed(1)}</td><td>${(d.bbox.x2 - d.bbox.x1).toFixed(1)} × ${(d.bbox.y2 - d.bbox.y1).toFixed(1)} px</td></tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:28px">Aucune détection au seuil sélectionné.</td></tr>';
}

function renderLegend() {
  const result = state.selected?.result;
  if (!result) return;
  const max = Math.max(1, ...Object.values(result.counts));
  $('#class-legend').innerHTML = state.classes.map(cls => {
    const count = result.counts[cls.name] || 0;
    return `<button class="legend-button" data-class="${cls.id}" aria-pressed="${!viewer.hidden.has(cls.id)}" aria-label="${escapeHTML(cls.label_fr)} : ${count}, afficher ou masquer"><span class="swatch" style="background:${COLORS[cls.id]}"></span><span>${escapeHTML(cls.name)}</span><strong>${count}</strong><svg class="legend-chart" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="4" rx="2" fill="var(--border)"/><rect width="${count / max * 100}" height="4" rx="2" fill="${COLORS[cls.id]}"/></svg></button>`;
  }).join('');
}

function renderBatch() {
  $('#batch-area').hidden = state.queue.length < 2;
  $('#batch-label').textContent = `${state.queue.filter(item => item.status === 'done').length} / ${state.queue.length} images analysées`;
  const labels = {pending: 'En attente', analyzing: 'En cours', done: 'Terminée', error: 'Erreur'};
  $('#batch-body').innerHTML = state.queue.map(item => `<tr data-index="${item.id}" tabindex="0" aria-label="Afficher ${escapeHTML(item.file.name)}"><td>${escapeHTML(item.file.name)}</td><td>${item.result?.total ?? '—'}</td><td>${item.result ? item.result.total ? 'Défauts détectés' : 'Aucun défaut détecté' : '—'}</td><td title="${escapeHTML(item.error)}">${labels[item.status]}</td></tr>`).join('');
}

function makeThumbnail(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = Math.max(1, Math.round(image.naturalHeight / image.naturalWidth * 400));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}

function renderHistory() {
  $('#history-count').textContent = state.history.length;
  $('#clear-history').disabled = state.busy || state.importing || !state.history.length;
  $('#history-grid').innerHTML = state.history.length ? state.history.map(entry => `<button class="history-card" data-history="${entry.historyId}"><img src="${entry.thumbnail}" alt="Miniature de ${escapeHTML(entry.file.name)}"><div><strong>${escapeHTML(entry.file.name)}</strong><small>${escapeHTML(new Date(entry.result.analyzed_at).toLocaleString('fr-FR'))} · Seuil ${Math.round(entry.result.conf * 100)} %</small><span class="verdict ${entry.result.total ? '' : 'clean'}">${entry.result.total ? entry.result.total + ' défaut(s) détecté(s)' : 'Aucun défaut détecté'}</span></div></button>`).join('') : '<div class="history-empty"><h2 style="justify-content:center">Votre première inspection vous attend.</h2><p>Les images analysées apparaîtront ici pendant cette session.</p><a href="#inspection">Commencer une inspection →</a></div>';
}

async function analyze() {
  if (state.busy || state.importing || !state.queue.length || !state.ready) return;
  state.busy = true;
  $('#error-banner').hidden = true;
  const conf = $('#confidence').value;
  const iou = $('#iou').value;
  const items = [...state.queue];
  $('#progress-area').hidden = false;
  $('#batch-progress').max = items.length;
  $('#batch-progress').value = 0;
  const errors = [];
  try {
    for (const [index, item] of items.entries()) {
      item.status = 'analyzing';
      item.result = null;
      item.error = '';
      showEntry(item);
      renderBatch();
      $('#progress-label').textContent = `Image ${index + 1} sur ${items.length}`;
      $('#progress-count').textContent = `${index} / ${items.length}`;
      const form = new FormData();
      form.append('file', item.file);
      form.append('conf', conf);
      form.append('iou', iou);
      try {
        const result = await (await request('/api/predict', {method: 'POST', body: form})).json();
        if (result.width !== item.image.naturalWidth || result.height !== item.image.naturalHeight) throw new Error('Dimensions de prévisualisation incohérentes avec l’inférence.');
        item.result = result;
        item.status = 'done';
        const snapshot = {...item, historyId: state.nextId++, thumbnail: makeThumbnail(item.image)};
        state.history.unshift(snapshot);
        showEntry(item);
        renderHistory();
      } catch (error) {
        item.status = 'error';
        item.error = error.message;
        errors.push(`${item.file.name} : ${error.message}`);
      }
      $('#batch-progress').value = index + 1;
      $('#progress-count').textContent = `${index + 1} / ${items.length}`;
      renderBatch();
    }
  } finally {
    state.busy = false;
    $('#progress-label').textContent = errors.length ? 'Lot terminé avec des erreurs' : 'Analyse terminée';
    if (errors.length) showError(errors.join(' '));
    else toast(items.length > 1 ? `${items.length} images analysées.` : 'Inspection terminée.');
    updateControls();
  }
}

function navigate() {
  const requested = location.hash.slice(1) || (location.pathname === '/about' ? 'about' : 'inspection');
  const view = ['inspection', 'history', 'about'].includes(requested) ? requested : 'inspection';
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  for (const link of document.querySelectorAll('[data-view]')) {
    link.classList.toggle('active', link.dataset.view === view);
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (view === 'history') renderHistory();
  if (view === 'inspection') requestAnimationFrame(() => viewer.resize());
}

function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#theme-toggle').setAttribute('aria-label', dark ? 'Activer le thème clair' : 'Activer le thème sombre');
  $('#theme-toggle').setAttribute('aria-pressed', String(dark));
}

$('#theme-toggle').addEventListener('click', () => {
  const dark = $('#theme-toggle').getAttribute('aria-pressed') === 'true';
  const theme = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('pcb-theme', theme); } catch { /* Stockage privé indisponible. */ }
  syncThemeButton();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButton);
syncThemeButton();

$('#drop-zone').addEventListener('click', () => { if (!state.busy && !state.importing) $('#file-input').click(); });
$('#drop-zone').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#drop-zone').click(); }
});
for (const type of ['dragenter', 'dragover']) $('#drop-zone').addEventListener(type, event => { event.preventDefault(); $('#drop-zone').classList.add('drag-over'); });
for (const type of ['dragleave', 'drop']) $('#drop-zone').addEventListener(type, event => { event.preventDefault(); $('#drop-zone').classList.remove('drag-over'); });
$('#drop-zone').addEventListener('drop', event => { void addFiles([...event.dataTransfer.files]); });
$('#file-input').addEventListener('change', event => { void addFiles([...event.target.files]); });
$('#dismiss-error').addEventListener('click', () => { $('#error-banner').hidden = true; });
$('#confidence').addEventListener('input', event => { $('#confidence-value').textContent = `${Math.round(event.target.value * 100)} %`; });
$('#iou').addEventListener('input', event => { $('#iou-value').textContent = Number(event.target.value).toLocaleString('fr-FR', {minimumFractionDigits: 2}); });
$('#analyze-button').addEventListener('click', () => { void analyze(); });
$('#zoom-in').addEventListener('click', () => viewer.zoom(1.3));
$('#zoom-out').addEventListener('click', () => viewer.zoom(1 / 1.3));
$('#zoom-fit').addEventListener('click', () => viewer.fit());
$('#toggle-boxes').addEventListener('click', event => {
  viewer.boxesVisible = !viewer.boxesVisible;
  event.currentTarget.setAttribute('aria-pressed', String(viewer.boxesVisible));
  event.currentTarget.innerHTML = `<svg><use href="#i-eye"/></svg>Boîtes ${viewer.boxesVisible ? 'visibles' : 'masquées'}`;
  viewer.draw();
});

$('#queue').addEventListener('click', event => {
  if (state.busy || state.importing) return;
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const item = state.queue.find(entry => entry.id === Number(remove.dataset.remove));
    state.queue = state.queue.filter(entry => entry !== item);
    if (!state.history.some(entry => entry.url === item.url)) URL.revokeObjectURL(item.url);
    if (state.selected?.id === item.id) state.queue.length ? showEntry(state.queue.at(-1)) : resetView();
    updateControls();
    renderBatch();
  }
  const select = event.target.closest('[data-select]');
  if (select) showEntry(state.queue.find(item => item.id === Number(select.dataset.select)));
});

for (const button of document.querySelectorAll('[data-sort]')) button.addEventListener('click', () => {
  state.sort.direction = state.sort.key === button.dataset.sort ? -state.sort.direction : 1;
  state.sort.key = button.dataset.sort;
  for (const th of document.querySelectorAll('#detections-table th[aria-sort]')) th.setAttribute('aria-sort', 'none');
  button.closest('th').setAttribute('aria-sort', state.sort.direction === 1 ? 'ascending' : 'descending');
  renderDetections();
});

function highlightRow(event, enabled) {
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  viewer.active = enabled ? Number(row.dataset.id) : -1;
  row.classList.toggle('hovered', enabled);
  viewer.draw();
}
$('#detections-body').addEventListener('mouseover', event => highlightRow(event, true));
$('#detections-body').addEventListener('mouseout', event => highlightRow(event, false));
$('#detections-body').addEventListener('focusin', event => highlightRow(event, true));
$('#detections-body').addEventListener('focusout', event => highlightRow(event, false));
function focusDetection(event) {
  const row = event.target.closest('tr[data-id]');
  if (row) { viewer.focus(Number(row.dataset.id)); $('#inspection-canvas').focus({preventScroll: true}); }
}
$('#detections-body').addEventListener('click', focusDetection);
$('#detections-body').addEventListener('keydown', event => { if (event.key === 'Enter') focusDetection(event); });
$('#class-legend').addEventListener('click', event => {
  const button = event.target.closest('[data-class]');
  if (!button) return;
  const classId = Number(button.dataset.class);
  viewer.hidden.has(classId) ? viewer.hidden.delete(classId) : viewer.hidden.add(classId);
  button.setAttribute('aria-pressed', String(!viewer.hidden.has(classId)));
  renderDetections();
  viewer.draw();
});

for (const button of document.querySelectorAll('[data-export]')) button.addEventListener('click', async () => {
  if (!state.selected?.result) return;
  try {
    await exportResult(button.dataset.export, state.selected);
    toast(button.dataset.export === 'report' ? 'Rapport HTML téléchargé : ouvrez-le pour imprimer ou enregistrer en PDF.' : 'Export téléchargé. Toutes les détections sont incluses.');
  } catch (error) { showError(error.message); }
});

function selectBatch(event) {
  if (state.busy || state.importing) return;
  const row = event.target.closest('[data-index]');
  if (row) showEntry(state.queue.find(item => item.id === Number(row.dataset.index)));
}
$('#batch-body').addEventListener('click', selectBatch);
$('#batch-body').addEventListener('keydown', event => { if (event.key === 'Enter') selectBatch(event); });
$('#history-grid').addEventListener('click', event => {
  if (state.busy || state.importing) return;
  const card = event.target.closest('[data-history]');
  if (!card) return;
  showEntry(state.history.find(entry => entry.historyId === Number(card.dataset.history)));
  location.hash = 'inspection';
});
$('#clear-history').addEventListener('click', () => {
  if (state.busy || state.importing) return;
  const selectedRemoved = state.selected && !state.queue.some(item => item === state.selected);
  for (const url of new Set(state.history.map(entry => entry.url))) {
    if (!state.queue.some(item => item.url === url)) URL.revokeObjectURL(url);
  }
  state.history = [];
  if (selectedRemoved) state.queue.length ? showEntry(state.queue.at(-1)) : resetView();
  renderHistory();
  toast('Historique de session effacé.');
});
$('#example-button').addEventListener('click', async () => {
  if (state.busy || state.importing || !state.examples.length) return;
  const example = state.examples[state.exampleIndex++ % state.examples.length];
  $('#example-button').disabled = true;
  try {
    const blob = await (await request(example.url)).blob();
    await addFiles([new File([blob], example.name, {type: blob.type})]);
  } catch (error) { showError(error.message); }
  finally { updateControls(); }
});
window.addEventListener('hashchange', navigate);
window.addEventListener('beforeunload', () => {
  for (const url of new Set([...state.queue, ...state.history].map(entry => entry.url))) URL.revokeObjectURL(url);
});

async function checkHealth() {
  try {
    const health = await (await request('/api/health')).json();
    state.ready = health.status === 'ready';
    $('#model-status').className = `status ${state.ready ? 'ready' : 'unavailable'}`;
    $('#model-status span:last-child').textContent = state.ready ? 'Modèle prêt' : 'Modèle indisponible';
    $('#model-status').title = health.message;
    $('#device-label').textContent = health.device.toUpperCase();
    $('#about-device').textContent = health.device.toUpperCase();
    if (!state.ready) showError(health.message);
  } catch (error) {
    state.ready = false;
    $('#model-status').className = 'status unavailable';
    $('#model-status span:last-child').textContent = 'Serveur indisponible';
    showError(error.message);
  }
  updateControls();
}

async function initialize() {
  navigate();
  renderHistory();
  const tasks = await Promise.allSettled([
    checkHealth(),
    (async () => {
      const metadata = await (await request('/api/model')).json();
      state.classes = metadata.classes;
      state.maxBytes = metadata.max_upload_bytes;
      $('#upload-limit').textContent = Math.round(state.maxBytes / 1024 / 1024);
      $('#confidence').value = metadata.default_conf;
      $('#confidence').dispatchEvent(new Event('input'));
      $('#iou').value = metadata.default_iou;
      $('#iou').dispatchEvent(new Event('input'));
      $('#model-metrics-body').innerHTML = metadata.classes.map(cls => `<tr><td>${cls.id}</td><td>${escapeHTML(cls.name)}</td><td>${escapeHTML(cls.label_fr)}</td><td>${cls.precision === null ? '—' : cls.precision.toLocaleString('fr-FR')}</td><td>${cls.recall === null ? '—' : cls.recall.toLocaleString('fr-FR')}</td><td>${cls.map50 === null ? '—' : cls.map50.toLocaleString('fr-FR')}</td></tr>`).join('');
    })(),
    (async () => {
      state.examples = (await (await request('/api/examples')).json()).examples;
      $('#example-button').hidden = !state.examples.length;
    })(),
  ]);
  for (const task of tasks) if (task.status === 'rejected') showError(task.reason.message);
  setInterval(() => { if (!state.busy) void checkHealth(); }, 30000);
}

void initialize();
