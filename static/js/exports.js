import {paintBoxes} from './viewer.js';

export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

export function annotatedCanvas(entry) {
  const canvas = document.createElement('canvas');
  canvas.width = entry.result.width;
  canvas.height = entry.result.height;
  const context = canvas.getContext('2d');
  context.drawImage(entry.image, 0, 0);
  // Lisibilité à la résolution d'origine : indépendante du zoom interactif.
  paintBoxes(context, entry.result.detections, {scale: 900 / entry.result.width});
  return canvas;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function exportResult(format, entry) {
  const name = entry.result.filename.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_.-]+/gu, '_') || 'pcb';
  if (format === 'png') {
    const blob = await new Promise(resolve => annotatedCanvas(entry).toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Impossible de générer l’image annotée.');
    download(blob, `${name}_annotee.png`);
  } else if (format === 'json') {
    download(new Blob([JSON.stringify(entry.result, null, 2)], {type: 'application/json;charset=utf-8'}), `${name}_resultats.json`);
  } else if (format === 'csv') {
    // Les noms fournis par l'utilisateur sont neutralisés contre les formules tableur.
    const cell = value => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const result = entry.result;
    const rows = [['fichier', 'date', 'modele', 'imgsz', 'largeur', 'hauteur', 'seuil_confiance', 'seuil_iou', 'duree_ms', 'total', 'class_id', 'classe', 'confiance', 'x1', 'y1', 'x2', 'y2', 'largeur_defaut', 'hauteur_defaut']];
    const base = [result.filename, result.analyzed_at, result.model, result.imgsz, result.width, result.height, result.conf, result.iou, result.inference_ms, result.total];
    for (const detection of result.detections) {
      const b = detection.bbox;
      rows.push([...base, detection.class_id, detection.class_name, detection.confidence, b.x1, b.y1, b.x2, b.y2, b.x2 - b.x1, b.y2 - b.y1]);
    }
    if (!result.total) rows.push([...base, ...Array(9).fill('')]);
    download(new Blob(['\ufeff', rows.map(row => row.map(cell).join(';')).join('\r\n')], {type: 'text/csv;charset=utf-8'}), `${name}_resultats.csv`);
  } else if (format === 'report') {
    download(new Blob([reportHTML([entry])], {type: 'text/html;charset=utf-8'}), `${name}_rapport.html`);
  }
}

export function reportHTML(entries) {
  const pages = entries.map(entry => {
    const r = entry.result;
    const groups = [];
    const columns = Math.max(1, Math.ceil(r.total / 32));
    const groupSize = Math.ceil(r.total / columns) || 1;
    for (let index = 0; index < r.total; index += groupSize) groups.push(r.detections.slice(index, index + groupSize));
    const table = groups.map((group, groupIndex) => `<table><thead><tr><th>N° / Classe</th><th>Score</th><th>Position / Taille (px)</th></tr></thead><tbody>${group.map((d, index) => `<tr><td>${groupIndex * groupSize + index + 1}. ${escapeHTML(d.class_name)}</td><td>${(d.confidence * 100).toFixed(1)} %</td><td>${d.bbox.x1.toFixed(1)}, ${d.bbox.y1.toFixed(1)} / ${(d.bbox.x2 - d.bbox.x1).toFixed(1)} × ${(d.bbox.y2 - d.bbox.y1).toFixed(1)}</td></tr>`).join('')}</tbody></table>`).join('');
    return `<section class="page"><header><strong>PCB Inspect</strong><span>Rapport d’inspection · Démonstration</span></header><h1>${escapeHTML(r.filename)}</h1><p>${escapeHTML(new Date(r.analyzed_at).toLocaleString('fr-FR'))} · ${escapeHTML(r.model)} · ${escapeHTML(r.device.toUpperCase())} · imgsz ${r.imgsz}<br>Image : ${r.width} × ${r.height} px · Confiance : ${r.conf} · IoU : ${r.iou} · Inférence : ${r.inference_ms} ms</p><h2>${r.total ? `${r.total} défaut(s) détecté(s)` : 'Aucun défaut détecté'}</h2><img class="annotation" src="${annotatedCanvas(entry).toDataURL('image/png')}" alt="Image avec toutes les détections annotées"><div class="tables" style="grid-template-columns:repeat(${columns},minmax(0,1fr));font-size:${Math.max(2, 8 - Math.max(0, columns - 2))}pt">${table || '<p>Aucune détection au seuil sélectionné.</p>'}</div><footer>Défauts artificiels (Akhatova / PCB Defects), test sur deux cartes seulement. L’absence de détection ne garantit pas l’absence de défaut.<br><strong>Outil de démonstration, ne remplace pas un contrôle qualité industriel.</strong></footer></section>`;
  }).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Rapport PCB Inspect</title><style>@page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;background:#edf0f2;color:#182a36;font:10pt system-ui,sans-serif}.print{display:block;margin:20px auto;padding:10px 20px;cursor:pointer}.page{width:190mm;height:275mm;margin:20px auto;background:white;padding:8mm;display:flex;flex-direction:column;break-after:page;overflow:hidden}header{display:flex;justify-content:space-between;border-bottom:1px solid #dfe6e9;padding-bottom:12px;color:#08796d}header span{font-size:8pt}h1{font-size:17pt;margin:14px 0 5px;overflow-wrap:anywhere}p{font-size:8pt;color:#586974;line-height:1.6;margin:5px 0}h2{font-size:12pt;margin:8px 0}.annotation{display:block;width:100%;height:95mm;object-fit:contain;background:#f6f8fa;margin:8px 0 14px}.tables{display:grid;gap:3mm;align-items:start;min-height:0}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{padding:3px 2px;text-align:left;border-bottom:1px solid #e2e8ec;overflow-wrap:anywhere}th{color:#586974}th:nth-child(1){width:38%}th:nth-child(2){width:18%}footer{margin-top:auto;padding-top:12px;font-size:7pt;color:#586974}@media print{body{background:white}.print{display:none}.page{margin:0;padding:0;height:275mm}.page:last-child{break-after:auto}}</style></head><body><button class="print" onclick="window.print()">Imprimer / Enregistrer en PDF</button>${pages}</body></html>`;
}
