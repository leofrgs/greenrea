/* App logique — charge CSV + config, indexe, et recherche sémantique */
const $q = document.getElementById('q');
const $results = document.getElementById('results');
const $empty = document.getElementById('empty');
const $onlyKnown = document.getElementById('onlyKnown');

// Utils: normalization (remove diacritics, lowercase)
const norm = s => (s||"").toString()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim();

// Simple CSV parser (handles ; inside quotes by using commas; but our CSV uses commas and semicolons for aliases)
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const header = lines.shift().split(',');
  return lines.map(line => {
    // naive CSV split (no quoted commas in this dataset)
    const cols = line.split(',');
    const obj = {};
    header.forEach((h,i)=> obj[h]=cols[i]!==undefined ? cols[i] : '');
    return obj;
  });
}

// Trigram set for fuzzy matching
function trigrams(s) {
  const n = '  ' + norm(s) + '  ';
  const grams = new Set();
  for (let i=0; i<n.length-2; i++) grams.add(n.slice(i,i+3));
  return grams;
}
function jaccard(aSet, bSet) {
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union ? inter/union : 0;
}

// Tokenize for TF-IDF
function tokenize(s) {
  return norm(s).split(/[^a-z0-9]+/).filter(Boolean);
}

// Build index: TF-IDF vectors and trigram caches
function buildIndex(rows) {
  const docs = rows.map(r => {
    const hay = [r.name, r.aliases, r.notes].filter(Boolean).join(' ');
    return { ...r, hay, _tokens: tokenize(hay), _tri: trigrams(hay) };
  });
  // IDF
  const df = new Map();
  docs.forEach(d => {
    new Set(d._tokens).forEach(t => df.set(t, (df.get(t)||0)+1));
  });
  const N = docs.length;
  const idf = new Map();
  for (const [t, n] of df.entries()) idf.set(t, Math.log(1 + N/(1+n)));
  // TF-IDF vectors
  docs.forEach(d => {
    const tf = new Map();
    d._tokens.forEach(t => tf.set(t, (tf.get(t)||0)+1));
    const vec = new Map();
    let len2 = 0;
    for (const [t, c] of tf.entries()) {
      const w = (c / d._tokens.length) * (idf.get(t)||0);
      vec.set(t, w);
      len2 += w*w;
    }
    d._vec = { map: vec, norm: Math.sqrt(len2) || 1 };
  });
  return { docs, idf };
}

function cosineSim(vecA, vecB) {
  if (!vecA || !vecB || !vecA.map || !vecB.map) return 0;
  let sum = 0;
  const a = vecA.map, b = vecB.map;
  for (const [t, w] of a.entries()) {
    const v = b.get(t);
    if (v) sum += w * v;
  }
  const denom = (vecA.norm || 1) * (vecB.norm || 1);
  return denom ? (sum / denom) : 0;
}


function makeQueryVector(qTokens, idf) {
  const tf = new Map();
  qTokens.forEach(t => tf.set(t, (tf.get(t)||0)+1));
  const vec = new Map();
  let len2 = 0;
  for (const [t, c] of tf.entries()) {
    const w = (c / qTokens.length) * (idf.get(t)||0);
    vec.set(t, w);
    len2 += w*w;
  }
  return { map: vec, norm: Math.sqrt(len2) || 1 };
}

// Merge bins config into documents for rendering
function attachBins(docs, binsById) {
  return docs.map(d => {
    const bin = binsById[d.bin] || null;
    return { ...d, _bin: bin };
  });
}

async function loadAll() {
  try {
    const [csvText, binsJson] = await Promise.all([
      fetch('wastes.csv').then(r => r.text()),
      fetch('bins.config.json').then(r => r.json())
    ]);

    // Parse CSV et attache les bacs
    const rowsRaw = parseCSV(csvText);
    const binsById = {};
    for (const b of binsJson.bins) binsById[b.id] = b;
    const rowsWithBins = attachBins(rowsRaw, binsById);

    // Construire l’index : renvoie docs enrichis (_vec, _tri…)
    const index = buildIndex(rowsWithBins);

    // Utiliser les docs enrichis comme rows (et pas rowsRaw !)
    window.__DATA__ = { rows: index.docs, index, binsById };

    $empty.textContent = 'Commence à taper pour voir des suggestions.';
    renderTop(index.docs.slice(0, 5));
  } catch (e) {
    console.error(e);
    $empty.textContent = 'Erreur de chargement des données.';
  }
}

function renderTop(list) {
  $results.innerHTML = '';
  if (!list.length) {
    $empty.style.display = 'block';
    return;
  }
  $empty.style.display = 'none';
  list.forEach(renderCard);
}

function renderCard(it) {
  const card = document.createElement('div');
  card.className = 'card';
  const bin = it._bin;
  const badgeStyle = bin ? `style="background:${bin.hex};color:${bin.text_hex};border-color:${bin.hex}"` : '';
  const binLabel = bin ? bin.label : 'Bac non configuré';
  const binNote = bin && bin.notes ? `<div class="note">${bin.notes}</div>` : '';
  card.innerHTML = `
    <div class="title">${it.name}</div>
    <div class="row">
      <span class="badge" ${badgeStyle}>${binLabel}</span>
    </div>
    ${it.notes ? `<div class="note">${it.notes}</div>` : ''}
    ${binNote}
  `;
  $results.appendChild(card);
}

function search(q) {
  const data = window.__DATA__;
  if (!data) return [];
  const { rows, index } = data;
  const qNorm = norm(q);
  if (!qNorm) return [];
  const qTokens = tokenize(qNorm);
  const qTri = trigrams(qNorm);
  const qVec = makeQueryVector(qTokens, index.idf);

  // score = 0.7*cosineTFIDF + 0.3*trigramJaccard on hay
  const scored = rows.map(d => {
    const cos = cosineSim(qVec, d._vec || { map: new Map(), norm: 1 });
    const tri = jaccard(qTri, d._tri || new Set());
    const aliasText = (d.aliases || '').toLowerCase();
    const bonus = d.name.toLowerCase().includes(qNorm) || aliasText.includes(qNorm) ? 0.1 : 0;
    const score = 0.7 * cos + 0.3 * tri + bonus;
    return { item: d, score };
  }).sort((a, b) => b.score - a.score);


  // Optionally filter low scores
  const hideLow = $onlyKnown && $onlyKnown.checked;
  const filtered = hideLow ? scored.filter(s => s.score >= 0.12) : scored;
  return filtered.slice(0, 20);
}

function renderResults(list) {
  $results.innerHTML='';
  if (!list.length) {
    $empty.textContent = $q.value ? "Aucun résultat. Essaie un autre mot ou un synonyme." : "Commence à taper pour voir des suggestions.";
    $empty.style.display = 'block';
    return;
  }
  $empty.style.display = 'none';
  list.forEach(({item, score}) => {
    const card = document.createElement('div');
    card.className = 'card';
    const bin = item._bin;
    const badgeStyle = bin ? `style="background:${bin.hex};color:${bin.text_hex};border-color:${bin.hex}"` : '';
    const binLabel = bin ? bin.label : 'Bac non configuré';
    const binNote = bin && bin.notes ? `<div class="note">${bin.notes}</div>` : '';
    card.innerHTML = `
      <div class="title">${item.name}</div>
      <div class="row">
        <span class="badge" ${badgeStyle}>${binLabel}</span>
        <span class="small">Score: ${(score).toFixed(2)}</span>
      </div>
      ${item.notes ? `<div class="note">${item.notes}</div>` : ''}
      ${binNote}
      ${item.aliases ? `<div class="note small"><strong>Alias :</strong> ${item.aliases.split(';').map(a=>a.trim()).filter(Boolean).join(', ')}</div>` : ''}
    `;
    $results.appendChild(card);
  });
}

$q.addEventListener('input', () => {
  const res = search($q.value);
  renderResults(res);
});
if ($onlyKnown) $onlyKnown.addEventListener('change', () => {
  const res = search($q.value);
  renderResults(res);
});

// PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  });
}

loadAll();
