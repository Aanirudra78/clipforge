const $ = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => [...el.querySelectorAll(q)];
const fmt = (s) => s ? (s / 60).toFixed(1) : '0.0';
const fmtDur = (s) => {
  if (!s && s !== 0) return '—';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m ? `${m}m ${sec}s` : `${sec}s`;
};
const hexToRgb = (h) => {
  const x = h.replace('#', '');
  const n = parseInt(x.length === 3 ? x.split('').map(c => c + c).join('') : x, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

let state = {
  health: null,
  projects: [],
  active: null,
  file: null,
  options: {
    count: 6, template: 'pop', crop: 'auto', title: '', accent: 'yellow', zoom: 0,
    punch: 1.3, look: 'none', music: 'auto', musicTrack: '', musicGain: 0.22, musicPulse: true,
  },
  edit: null,
  edits: null,
  nav: 'home',
};

const templates = [
  { id: 'pop', name: 'Bold Pop', hint: '2–3 words · active word pops' },
  { id: 'karaoke', name: 'Karaoke Clean', hint: 'word-by-word fill' },
  { id: 'box', name: 'Minimal Box', hint: 'quiet lower third' },
  { id: 'neon', name: 'Neon Punch', hint: 'glow + punch' },
];
const accents = [
  { id: 'yellow', color: '#FFD400' },
  { id: 'cyan', color: '#00E5FF' },
  { id: 'green', color: '#7CFF6B' },
  { id: 'pink', color: '#FF4D9D' },
  { id: 'orange', color: '#FF8A3D' },
  { id: 'white', color: '#FFFFFF' },
  { id: 'gold', color: '#E8C36A' },
  { id: 'red', color: '#FF3B30' },
];

const NORMAL_LOOK = { id: 'none', name: 'Normal', hint: 'No grade — keep the source look.', swatch: ['#d8d4c9', '#8d8a7f'] };
const lookPresets = () => state.health?.looks?.presets || [];
const lookById = (id) => lookPresets().find((l) => l.id === id) || null;
const lookLabel = (id) => lookById(id)?.name || 'Normal';

function lookTile(look, current, onPick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'look-tile' + (current === look.id ? ' active' : '');
  b.dataset.look = look.id;
  b.title = look.hint || look.name;
  b.innerHTML = `<span class="look-swatch" style="--a:${look.swatch[0]};--b:${look.swatch[1]}"></span><span class="look-name">${look.name}</span>`;
  b.onclick = () => onPick(look);
  return b;
}

function renderLookStrip(el, current, onPick) {
  if (!el) return;
  el.innerHTML = '';
  el.appendChild(lookTile(NORMAL_LOOK, current, onPick));
  for (const l of lookPresets()) el.appendChild(lookTile(l, current, onPick));
}

/* ---- music library + pickers ------------------------------------------- */

let musicLib = null;

async function musicLibrary(force = false) {
  if (!musicLib || force) {
    try { musicLib = await api('/api/music'); }
    catch { musicLib = musicLib || { uploads: [], tracks: [] }; }
  }
  return musicLib;
}

async function uploadMusic(file) {
  const fd = new FormData();
  fd.append('audio', file);
  const r = await api('/api/music', { method: 'POST', body: fd });
  await musicLibrary(true);
  return String(r.id || '').replace(/^upload:/, '');
}

function fillUploads(sel, selected) {
  if (!sel) return;
  sel.innerHTML = '';
  const up = musicLib?.uploads || [];
  if (!up.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No uploads yet — add one';
    sel.appendChild(o);
  }
  for (const u of up) {
    const o = document.createElement('option');
    o.value = u.file;
    o.textContent = u.name;
    sel.appendChild(o);
  }
  if (selected && !up.some((u) => u.file === selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = selected;
    sel.appendChild(o);
  }
  sel.value = selected || '';
}

function renderMusicUi() {
  const mode = state.options.music || 'auto';
  $$('#musicChips .chip').forEach(c => c.classList.toggle('active', c.dataset.music === mode));
  $('#musicUploadRow').classList.toggle('hidden', mode !== 'upload');
  $('#musicVal').textContent = mode === 'auto' ? 'Auto' : mode === 'none' ? 'None' : 'My track';
  $('#musicHint').textContent = mode === 'none'
    ? 'Original audio only.'
    : mode === 'upload'
      ? 'Your track, ducked under speech.'
      : "Ducks under speech, matched to the look's mood.";
}

function wireMusicControls() {
  const cs = $('#musicChips');
  if (!cs || cs.dataset.wired) return;
  cs.dataset.wired = '1';
  $$('#musicChips .chip').forEach(b => {
    b.onclick = async () => {
      state.options.music = b.dataset.music;
      if (b.dataset.music === 'upload') {
        await musicLibrary();
        fillUploads($('#musicTrackSelect'), state.options.musicTrack);
        if (!state.options.musicTrack && musicLib.uploads?.length) {
          state.options.musicTrack = musicLib.uploads[0].file;
          $('#musicTrackSelect').value = state.options.musicTrack;
        }
      }
      renderMusicUi();
    };
  });
  $('#musicTrackSelect').onchange = (e) => { state.options.musicTrack = e.target.value; };
  $('#musicPickBtn').onclick = () => $('#musicFileInput').click();
  $('#musicFileInput').onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    $('#musicFileName').textContent = 'uploading…';
    try {
      const file = await uploadMusic(f);
      state.options.music = 'upload';
      state.options.musicTrack = file;
      await musicLibrary(true);
      fillUploads($('#musicTrackSelect'), file);
      $('#musicFileName').textContent = f.name;
      toast(`Music added — ${f.name}`);
    } catch (err) {
      toast(err.message, 'err');
      $('#musicFileName').textContent = '';
    } finally {
      e.target.value = '';
      renderMusicUi();
    }
  };
}

const toast = (msg, type = 'ok') => {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="dot"></span><span>${msg}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 280); }, 2400);
};

const closeRail = () => {
  $('#rail').classList.remove('open');
  $('#railScrim')?.classList.remove('show');
};

const nav = (to) => {
  state.nav = to;
  $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === to));
  $$('.view').forEach(v => v.classList.add('hidden'));
  if (to === 'home') {
    $('#viewHome').classList.remove('hidden');
    $('#viewProject').classList.add('hidden');
  }
  if (to === 'settings') { $('#viewSettings').classList.remove('hidden'); renderSettings(); }
  if (to === 'edits') { $('#viewEdits').classList.remove('hidden'); loadEdits(); }
  $('#crumbs').innerHTML = to === 'settings' ? '<span>Settings</span>'
    : to === 'edits' ? '<span>Edits</span>' : '<span>Studio</span>';
};

$$('.rail-btn[data-nav]').forEach(b => b.addEventListener('click', () => { nav(b.dataset.nav); closeRail(); }));
$('#menuBtn')?.addEventListener('click', () => {
  const open = $('#rail').classList.toggle('open');
  $('#railScrim')?.classList.toggle('show', open);
});
$('#railScrim')?.addEventListener('click', closeRail);
$('.brand')?.addEventListener('click', (e) => { e.preventDefault(); nav('home'); closeRail(); });
$$('.rail-btn[data-filter]').forEach(b => b.addEventListener('click', () => {
  nav('home');
  closeRail();
  document.getElementById('projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

const api = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
};

async function init() {
  try {
    state.health = await api('/api/health');
    $('#engineName').textContent = state.health.encoder === 'h264_nvenc' ? 'GPU (NVENC)' : 'CPU (x264)';
    $('#engineSub').textContent = state.health.groq ? 'Groq Whisper ready' : 'no Groq key';
    const gp = $('#groqPill');
    if (!state.health.groq) gp.classList.add('off');
    renderBrief();
    await loadProjects();
    const box = $('#editsList');
    if (box) box.dataset.sig = '';
    await loadEdits();
  } catch (e) { toast(e.message, 'err'); }
}

function renderBrief() {
  const tc = $('#templateChips');
  tc.innerHTML = '';
  for (const t of templates) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (t.id === state.options.template ? ' active' : '');
    btn.dataset.template = t.id;
    btn.innerHTML = `<span>${t.name}</span><small>${t.hint}</small>`;
    btn.addEventListener('click', () => {
      $$('#templateChips .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      state.options.template = t.id;
    });
    tc.appendChild(btn);
  }
  $$('#cropChips .chip').forEach(btn => {
    btn.onclick = () => {
      $$('#cropChips .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      state.options.crop = btn.dataset.crop;
    };
  });
  const sc = $('#accentSwatches');
  sc.innerHTML = '';
  for (const a of accents) {
    const b = document.createElement('button');
    b.className = 'swatch' + (a.id === state.options.accent ? ' active' : '');
    b.style.background = a.color;
    b.title = a.id;
    b.onclick = () => {
      $$('#accentSwatches .swatch').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.options.accent = a.id;
    };
    sc.appendChild(b);
  }
  $('#optCount').oninput = (e) => {
    state.options.count = +e.target.value;
    $('#countVal').textContent = e.target.value;
  };
  $('#optTitle').oninput = (e) => (state.options.title = e.target.value);
  $('#optPunch').value = state.options.punch;
  $('#punchVal').textContent = `${(+state.options.punch).toFixed(2).replace(/0$/, '')}×`;
  $('#optPunch').oninput = (e) => {
    state.options.punch = +e.target.value;
    $('#punchVal').textContent = `${(+e.target.value).toFixed(2).replace(/0$/, '')}×`;
  };

  // Look catalogue: preset bundle (grade + texture + caption default), while
  // the caption chips above remain a manual override.
  renderLookStrip($('#lookStrip'), state.options.look, (look) => {
    state.options.look = look.id;
    if (look.id !== 'none') {
      state.options.template = look.template || state.options.template;
      state.options.accent = look.accent || state.options.accent;
    }
    renderBrief();
  });
  const curLook = lookById(state.options.look);
  $('#lookVal').textContent = curLook?.name || 'Normal';
  $('#lookHint').textContent = curLook?.hint || NORMAL_LOOK.hint;

  wireMusicControls();
  renderMusicUi();
}

const drop = $('#dropCard');
const fileInput = $('#fileInput');
$('#pickBtn').onclick = () => fileInput.click();
drop.addEventListener('click', (e) => { if (e.target.closest('button')) return; fileInput.click(); });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); });
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.onchange = (e) => { const f = e.target.files?.[0]; if (f) setFile(f); };
$('#clearFile').onclick = (e) => { e.stopPropagation(); state.file = null; fileInput.value = ''; $('#dropFile').classList.add('hidden'); $('#startBtn').disabled = true; };

function setFile(f) {
  state.file = f;
  $('#fileName').textContent = f.name;
  $('#fileSize').textContent = (f.size / 1024 / 1024).toFixed(1) + ' MB';
  $('#dropFile').classList.remove('hidden');
  $('#startBtn').disabled = false;
}

$('#startBtn').onclick = async () => {
  if (!state.file) return;
  $('#startBtn').disabled = true;
  $('#startBtn').innerHTML = '<span>Uploading…</span>';
  try {
    const fd = new FormData();
    fd.append('video', state.file);
    fd.append('options', JSON.stringify(state.options));
    fd.append('name', state.file.name);
    const res = await fetch('/api/projects', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('Project started — finding clips');
    state.file = null; fileInput.value = '';
    $('#dropFile').classList.add('hidden');
    await loadProjects();
    openProject(data.project.id);
  } catch (e) { toast(e.message, 'err'); }
  finally {
    $('#startBtn').disabled = !state.file;
    $('#startBtn').innerHTML = '<span>Cut my clips</span><svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M5 12h13m0 0l-5-5m5 5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
};

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjects();
  let clips = 0, secs = 0;
  for (const p of state.projects) {
    if (p.meta?.duration) secs += p.meta.duration / 60;
  }
  $('#statProjects').textContent = state.projects.length;
  $('#statSecs').textContent = Math.round(secs);
}

function renderProjects() {
  const box = $('#projects');
  const q = ($('#searchInput').value || '').toLowerCase();
  const list = state.projects.filter(p => !q || (p.name || '').toLowerCase().includes(q));
  const sig = list.map(p => `${p.id}:${p.status}:${Math.round(p.progress * 100)}:${p.step || ''}:${p.name}`).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = '';
  $('#emptyProjects').classList.toggle('hidden', list.length > 0);
  for (const p of list) {
    const dur = Math.round(p.meta?.duration || 0);
    const source = [
      p.meta?.width && p.meta?.height ? `${p.meta.width}×${p.meta.height}` : null,
      p.meta?.transcriptSource === 'groq' ? 'groq' : 'local stt',
      p.meta?.autoCrop || p.meta?.options?.crop || null,
    ].filter(Boolean).join(' · ');
    const label = p.status === 'running' ? (p.step || 'working')
      : p.status === 'done' ? 'ready'
      : p.status === 'error' ? 'interrupted'
      : p.status === 'queued' ? 'queued'
      : p.status;
    const card = document.createElement('article');
    card.className = 'proj-card';
    card.innerHTML = `
      <div class="proj-thumb">
        <svg viewBox="0 0 24 24" fill="none" width="20" height="20"><path d="M4.5 6.5A2.5 2.5 0 017 4h10a2.5 2.5 0 012.5 2.5v11A2.5 2.5 0 0117 20H7a2.5 2.5 0 01-2.5-2.5z" stroke="currentColor" stroke-width="1.5"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>
        <span class="count">${dur}s</span>
      </div>
      <div class="proj-body">
        <b title="${p.name}">${p.name}</b>
        <small>${source || 'source'}</small>
        ${p.status === 'running' ? `<div class="proj-track"><div style="width:${Math.round(p.progress * 100)}%"></div></div>` : ''}
      </div>
      <div class="proj-status ${p.status}">
        <span class="dot"></span>
        <span>${label}</span>
      </div>
      <span class="proj-go" aria-hidden="true">→</span>
    `;
    card.onclick = () => openProject(p.id);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProject(p.id); }
    };
    box.appendChild(card);
  }
}
$('#searchInput').oninput = renderProjects;

async function openProject(id) {
  const data = await api(`/api/projects/${id}`);
  state.active = data;
  nav('home');
  $('#viewHome').classList.add('hidden');
  $('#viewProject').classList.remove('hidden');
  $('#crumbs').innerHTML = '<button class="link" id="crumbHome">Studio</button><span>/</span><b id="crumbProj"></b>';
  $('#crumbHome').onclick = () => { nav('home'); $('#viewHome').classList.remove('hidden'); $('#viewProject').classList.add('hidden'); loadProjects(); };
  $('#projName').textContent = data.project.name;
  const m = data.project.meta || {};
  $('#projMeta').innerHTML = `
    <span class="meta-chip">${m.width || '-'}×${m.height || '-'}</span>
    <span class="meta-chip">${fmtDur(m.duration)}</span>
    <span class="meta-chip">${m.wordCount || 0} words</span>
    <span class="meta-chip">caps: ${m.transcriptSource || '—'}</span>
    <span class="meta-chip">framing: ${m.autoCrop || '—'}</span>
  `;
  renderClips(data);
  toggleJobbar(data.project);
}
$('#backBtn').onclick = () => { nav('home'); $('#viewHome').classList.remove('hidden'); $('#viewProject').classList.add('hidden'); loadProjects(); };

function toggleJobbar(p) {
  const bar = $('#jobbar');
  if (p.status === 'running' || p.status === 'queued') {
    bar.classList.remove('hidden');
    $('#jobbarFill').style.width = Math.round(p.progress * 100) + '%';
    $('#jobPct').textContent = Math.round(p.progress * 100) + '%';
    $('#jobStep').textContent = p.step || 'processing';
  } else {
    bar.classList.add('hidden');
  }
}

function renderClips(data) {
  const box = $('#clipsGrid');
  const clips = (data.clips || []).slice().sort((a, b) => b.score - a.score);
  const sig = clips.map(c => `${c.id}:${c.status}:${c.path ? 1 : 0}:${c.start}:${c.data?.look || ''}:${c.data?.brollUsed?.assets ?? ''}${c.data?.brollUsed?.cards ?? ''}`).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = '';
  $('#emptyClips').classList.toggle('hidden', clips.length > 0);
  $('#statClips').textContent = clips.filter(c => c.status === 'ready').length;
  const zipBtn = $('#zipBtn');
  if (zipBtn && state.active) {
    zipBtn.href = `/api/projects/${state.active.project.id}/zip`;
    zipBtn.style.display = clips.some((c) => c.status === 'ready') ? '' : 'none';
  }
  for (const c of clips) {
    const el = document.createElement('article');
    el.className = 'clip-card' + (c.status === 'rendering' ? ' rendering' : '');
    el.dataset.clip = c.id;
    el.innerHTML = `
      <div class="clip-media" data-play="${c.id}">
        ${c.thumb ? `<img src="/api/thumbs/${c.id}" loading="lazy" alt="">` : '<div class="clip-skeleton"></div>'}
        ${c.path && c.status === 'ready' ? `<video src="/api/clips/${c.id}/file" muted loop playsinline preload="none"></video>` : ''}
        <div class="clip-badges">
          <span class="badge">${(c.duration || 0).toFixed(0)}s</span>
          ${(c.data?.brollUsed?.assets || 0) + (c.data?.brollUsed?.cards || 0) > 0 ? `<span class="badge broll" title="topic visuals: ${esc((c.data?.broll || []).map((r) => r.query).filter(Boolean).join(', ') || 'text card')}">${(c.data?.brollUsed?.assets || 0) + (c.data?.brollUsed?.cards || 0)} visuals</span>` : ''}
          ${c.data?.look && c.data.look !== 'none' ? `<span class="badge look">${lookLabel(c.data.look)}</span>` : ''}
          ${c.score ? `<span class="badge score">${Math.round(c.score)}</span>` : ''}
        </div>
        <div class="play-fab">
          <span>
            <svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M8.5 6.5l8 5.5-8 5.5z" fill="white"/></svg>
          </span>
        </div>
      </div>
      <div class="clip-body">
        <div class="clip-reason">${c.reason || 'auto pick'}</div>
        <div class="clip-row">
          <span class="clip-time">${(c.start || 0).toFixed(1)}s – ${(c.end || 0).toFixed(1)}s</span>
          <div class="clip-actions">
            <button class="mini-btn" data-edit="${c.id}">
              <svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M5 16.5V19h2.5L17 9.5l-2.5-2.5L5 16.5z" stroke="currentColor" stroke-width="1.6"/></svg>
              Edit
            </button>
            ${c.status === 'ready' ? `<a class="mini-btn primary" href="/api/clips/${c.id}/download" download>
              <svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M12 4v8m0 0l-3-3m3 3l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 17h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
              Save
            </a>` : '<span class="mini-btn">Rendering</span>'}
          </div>
        </div>
      </div>
    `;
    box.appendChild(el);
  }

  box.onclick = (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) { openEditor(edit.dataset.edit, data); return; }
    const play = e.target.closest('[data-play]');
    if (play) {
      const card = play.closest('.clip-card');
      const vid = play.querySelector('video');
      if (!vid) return;
      if (vid.paused) { vid.play(); card.classList.add('playing'); } else { vid.pause(); card.classList.remove('playing'); }
    }
  };
}

/* ---- Edits tab ---------------------------------------------------------- */

async function loadEdits() {
  try {
    const r = await api('/api/edits');
    state.edits = r;
    const badge = $('#editsCount');
    if (badge) {
      const n = r.pending || r.edited || 0;
      badge.textContent = String(n);
      badge.classList.toggle('hidden', !n);
      badge.classList.toggle('warn', r.pending > 0);
    }
    const sig = JSON.stringify((r.edits || []).map((e) => [e.clipId, e.status, e.pending, e.edits, e.hasFile]));
    const box = $('#editsList');
    if (box && box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      renderEdits(r);
    }
  } catch {}
}

function renderEdits(r) {
  const box = $('#editsList');
  if (!box) return;
  box.innerHTML = '';
  const edits = r?.edits || [];
  $('#emptyEdits').classList.toggle('hidden', edits.length > 0);
  $('#editsRenderAll').disabled = !edits.some((e) => e.pending);
  const zip = $('#editsZip');
  if (zip) zip.style.display = edits.some((e) => e.status === 'ready' && e.hasFile) ? '' : 'none';
  for (const e of edits) {
    const card = document.createElement('article');
    card.className = 'edit-card' + (e.pending ? ' pending' : '');
    const chips = [
      e.pending
        ? '<span class="edit-chip warn">re-render pending</span>'
        : '<span class="edit-chip ok">rendered</span>',
      e.status !== 'ready' ? `<span class="edit-chip">${esc(e.status)}</span>` : '',
      e.look && e.look !== 'none' ? `<span class="edit-chip">${esc(lookLabel(e.look))}</span>` : '',
      e.musicName ? `<span class="edit-chip">♪ ${esc(e.musicName)}</span>` : '',
    ].filter(Boolean).join('');
    card.innerHTML = `
      <div class="edit-thumb">
        ${e.thumb ? `<img src="/api/thumbs/${esc(e.clipId)}" loading="lazy" alt="">` : ''}
        <span class="edit-dur">${(e.duration || 0).toFixed(0)}s</span>
      </div>
      <div class="edit-body">
        <b title="${esc(e.projectName)}">${esc(e.projectName)}</b>
        <small>${e.edits} caption line${e.edits === 1 ? '' : 's'} fixed${e.changed ? ` · ${e.changed} not in the MP4` : ''}</small>
        <div class="edit-chips">${chips}</div>
        <div class="edit-actions">
          <button class="mini-btn" data-open="${esc(e.clipId)}" data-project="${esc(e.projectId)}">Open</button>
          ${e.pending ? `<button class="mini-btn primary" data-rerender="${esc(e.clipId)}">Re-render</button>` : ''}
          ${e.status === 'ready' && e.hasFile ? `<a class="mini-btn" href="/api/clips/${esc(e.clipId)}/download" download>Save</a>` : ''}
        </div>
      </div>`;
    box.appendChild(card);
  }
}

async function openEditClip(projectId, clipId) {
  try {
    const data = await api(`/api/projects/${projectId}`);
    openEditor(clipId, data, { fromEdits: true });
  } catch (e) { toast(e.message, 'err'); }
}

$('#editsList').onclick = async (ev) => {
  const open = ev.target.closest('[data-open]');
  if (open) { openEditClip(open.dataset.project, open.dataset.open); return; }
  const rr = ev.target.closest('[data-rerender]');
  if (rr) {
    rr.disabled = true;
    try {
      const r = await api('/api/edits/render', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clipIds: [rr.dataset.rerender] }),
      });
      toast(`Queued ${r.queued} re-render${r.queued === 1 ? '' : 's'}`);
      loadEdits();
    } catch (e) { toast(e.message, 'err'); rr.disabled = false; }
  }
};

$('#editsRenderAll').onclick = async () => {
  const btn = $('#editsRenderAll');
  btn.disabled = true;
  try {
    const r = await api('/api/edits/render', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    toast(r.queued ? `Queued ${r.queued} pending edit${r.queued === 1 ? '' : 's'}` : 'Nothing pending');
    loadEdits();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
};

loadEdits();

$('#rerunBtn').onclick = async () => {
  if (!state.active) return;
  try {
    await api(`/api/projects/${state.active.project.id}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    toast('Re-analysing with current defaults');
    openProject(state.active.project.id);
  } catch (e) { toast(e.message, 'err'); }
};
$('#deleteProjBtn').onclick = async () => {
  if (!state.active) return;
  if (!confirm('Delete this project and all clips?')) return;
  await api(`/api/projects/${state.active.project.id}`, { method: 'DELETE' });
  toast('Project deleted');
  $('#viewProject').classList.add('hidden');
  $('#viewHome').classList.remove('hidden');
  nav('home');
  loadProjects();
};

function renderSettings() {
  const h = state.health || {};
  $('#sttTag').textContent = h.groq ? 'Groq turbo' : 'none';
  $('#sttTag').className = 'tag ' + (h.groq ? 'ok' : 'warn');
  $('#sttDesc').textContent = h.groq ? 'whisper-large-v3-turbo · Hinglish friendly' : 'Set GROQ_API_KEY in .env';
  $('#encTag').textContent = h.encoder === 'h264_nvenc' ? 'NVENC' : 'libx264';
  $('#encTag').className = 'tag ok';
  $('#encDesc').textContent = h.encoder === 'h264_nvenc' ? 'RTX-accelerated · fast exports' : 'CPU encode';
  $('#dataDesc').textContent = h.dataDir || '—';
  const dtc = $('#defTemplateChips');
  if (dtc) {
    dtc.innerHTML = '';
    for (const t of templates) {
      const b = document.createElement('button');
      b.className = 'chip' + (t.id === state.options.template ? ' active' : '');
      b.textContent = t.name;
      b.onclick = () => {
        state.options.template = t.id;
        renderBrief();
        renderSettings();
        toast(`Default style — ${t.name}`);
      };
      dtc.appendChild(b);
    }
  }
  const lan = (h.lanUrls || [])[0];
  $('#lanHint').innerHTML = lan
    ? `On your phone (same Wi-Fi): <b style="color:var(--ink)">${lan}</b> — rendering still happens on this PC.`
    : 'Tip: run this from your phone on the same Wi-Fi using this PC\'s LAN IP — the render still happens here, so results are identical.';
}

function openEditor(id, data, opts = {}) {
  const c = data.clips.find(x => x.id === id);
  if (!c) return;
  state.edit = {
    clip: c, project: data.project, fromEdits: Boolean(opts.fromEdits),
    captionEdits: { ...(c.data?.captionEdits || {}) },
  };
  $('#editor').classList.remove('hidden');
  $('#edTitle').textContent = `Clip ${c.id.slice(0,4)}`;
  $('#edMeta').textContent = `${(c.duration||0).toFixed(1)}s · ${c.score ? 'score ' + Math.round(c.score) : ''}`;
  $('#edBadge').textContent = c.data?.template || 'clip';
  const v = $('#edVideo');
  v.src = `/api/clips/${c.id}/file`;
  $('#edDownload').href = `/api/clips/${c.id}/download`;
  v.play().catch(() => {});
  setupTrim(c);
  setupEdControls(c);
  loadCaptionLines(c, state.edit.template);
}

async function loadCaptionLines(c, template) {
  const box = $('#edCaptions');
  if (!box) return;
  box.innerHTML = '<div class="ctrl-status">loading lines…</div>';
  try {
    const r = await api(`/api/clips/${c.id}/captions?template=${encodeURIComponent(template || 'pop')}`);
    state.edit.capLines = r.lines;
    box.innerHTML = '';
    for (const line of r.lines) {
      const row = document.createElement('div');
      row.className = 'cap-line';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = `${line.start.toFixed(1)}s`;
      const inp = document.createElement('input');
      inp.value = line.text;
      inp.dataset.key = line.key;
      inp.spellcheck = false;
      inp.oninput = () => {
        const v = inp.value.trim();
        if (v && v !== line.original) state.edit.captionEdits[line.key] = v;
        else delete state.edit.captionEdits[line.key];
        row.classList.toggle('edited', v !== line.original);
      };
      row.append(t, inp);
      box.appendChild(row);
    }
    const hint = $('#edCapHint');
    if (hint) hint.textContent = `${r.lines.length} lines · tap to fix`;
  } catch (err) {
    box.innerHTML = `<div class="ctrl-status">${err.message}</div>`;
  }
}

function editorPayload(e) {
  return {
    start: e.start, end: e.end, template: e.template, crop: e.crop, accent: e.accent,
    size: e.size, position: e.position, title: e.title, zoom: e.zoom, punch: e.punch,
    look: e.look || 'none',
    music: e.music || 'auto', musicTrack: e.musicTrack || '',
    musicGain: e.musicGain ?? 0.22, musicPulse: e.musicPulse !== false,
    words: e.words, subject: e.subject, captionEdits: e.captionEdits || {},
  };
}

async function setupEditorMusic(d) {
  if (!state.edit) return;
  state.edit.music = d.music || 'auto';
  state.edit.musicTrack = d.musicTrack || '';
  state.edit.musicGain = d.musicGain ?? 0.22;
  state.edit.musicPulse = d.musicPulse !== false;
  const sync = () => {
    if (!state.edit) return;
    $$('#edMusicChips .chip').forEach(c => c.classList.toggle('active', c.dataset.music === state.edit.music));
    $('#edMusicRow').classList.toggle('hidden', state.edit.music !== 'upload');
    $('#edMusicHint').textContent = state.edit.music === 'none'
      ? 'original audio'
      : state.edit.music === 'upload'
        ? (state.edit.musicTrack || 'choose a track')
        : (d.musicName ? `auto · ${d.musicName}` : 'auto');
  };
  $$('#edMusicChips .chip').forEach(b => {
    b.onclick = async () => {
      if (!state.edit) return;
      state.edit.music = b.dataset.music;
      if (b.dataset.music === 'upload') {
        await musicLibrary();
        fillUploads($('#edMusicSelect'), state.edit.musicTrack);
        if (!state.edit.musicTrack && musicLib.uploads?.length) {
          state.edit.musicTrack = musicLib.uploads[0].file;
          $('#edMusicSelect').value = state.edit.musicTrack;
        }
      }
      sync();
    };
  });
  $('#edMusicSelect').onchange = (e) => { if (state.edit) state.edit.musicTrack = e.target.value; };
  $('#edMusicPick').onclick = () => $('#edMusicFile').click();
  $('#edMusicFile').onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f || !state.edit) return;
    $('#edMusicName').textContent = 'uploading…';
    try {
      const file = await uploadMusic(f);
      if (!state.edit) return;
      state.edit.music = 'upload';
      state.edit.musicTrack = file;
      await musicLibrary(true);
      fillUploads($('#edMusicSelect'), file);
      $('#edMusicName').textContent = f.name;
      toast(`Music added — ${f.name}`);
    } catch (err) {
      toast(err.message, 'err');
      $('#edMusicName').textContent = '';
    } finally {
      e.target.value = '';
      sync();
    }
  };
  await musicLibrary();
  fillUploads($('#edMusicSelect'), state.edit.musicTrack);
  sync();
}

function setupTrim(c) {
  const start = $('#trimStart'), end = $('#trimEnd'), active = $('#trimActive'), read = $('#trimReadout');
  const total = Math.max(1, c.duration || 10);
  start.min = 0; start.max = total; end.min = 0; end.max = total;
  start.value = 0; end.value = total;
  state.edit.start = c.start; state.edit.end = c.end;
  const sync = () => {
    let s = +start.value, e = +end.value;
    if (s > e - 0.5) { if (document.activeElement === start) e = s + 0.5; else s = e - 0.5; start.value = s; end.value = e; }
    state.edit.start = c.start + s; state.edit.end = c.start + e;
    const left = (s / total) * 100, right = ((total - e) / total) * 100;
    active.style.left = left + '%';
    active.style.right = right + '%';
    read.textContent = `${s.toFixed(1)}s → ${e.toFixed(1)}s`;
    const v = $('#edVideo');
    if (v.currentTime < c.start + s) v.currentTime = c.start + s;
  };
  start.oninput = sync; end.oninput = sync; sync();
}

function setupEdControls(c) {
  const d = c.data || {};
  // templates
  const et = $('#edTemplates'); et.innerHTML = '';
  for (const t of templates) {
    const b = document.createElement('button');
    b.className = 'chip' + ((d.template || 'pop') === t.id ? ' active' : '');
    b.dataset.template = t.id;
    b.innerHTML = `<span>${t.name}</span><small>${t.hint}</small>`;
    b.onclick = () => {
      $$('#edTemplates .chip').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.edit.template = t.id;
      $('#edBadge').textContent = t.id;
      loadCaptionLines(state.edit.clip, t.id);
    };
    et.appendChild(b);
  }
  state.edit.template = d.template || 'pop';
  // look strip: changes the grade/texture and supplies a caption default that
  // the chips above can still override afterwards
  const edLooks = $('#edLooks');
  state.edit.look = d.look || 'none';
  const applyLook = (look) => {
    state.edit.look = look.id;
    if (look.id !== 'none') {
      state.edit.template = look.template || state.edit.template;
      state.edit.accent = look.accent || state.edit.accent;
      $$('#edTemplates .chip').forEach(x => x.classList.toggle('active', x.dataset.template === state.edit.template));
      $$('#edAccents .swatch').forEach(x => x.classList.toggle('active', x.dataset.accent === state.edit.accent));
      loadCaptionLines(state.edit.clip, state.edit.template);
      $('#edBadge').textContent = state.edit.template;
    }
    $$('#edLooks .look-tile').forEach(x => x.classList.toggle('active', x.dataset.look === look.id));
    const hint = $('#edLookHint');
    if (hint) hint.textContent = look.hint || 'grade + texture';
  };
  renderLookStrip(edLooks, state.edit.look, applyLook);
  const edLook = lookById(state.edit.look);
  if ($('#edLookHint')) $('#edLookHint').textContent = edLook?.hint || 'No grade — source look.';
  // accents
  const ea = $('#edAccents'); ea.innerHTML = '';
  for (const a of accents) {
    const b = document.createElement('button');
    b.className = 'swatch' + ((d.accent || 'yellow') === a.id ? ' active' : '');
    b.dataset.accent = a.id;
    b.style.background = a.color;
    b.title = a.id;
    b.onclick = () => {
      $$('#edAccents .swatch').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.edit.accent = a.id;
    };
    ea.appendChild(b);
  }
  state.edit.accent = d.accent || 'yellow';
  // crops
  const cropUi = !d.crop || d.crop === 'punch' ? 'auto' : d.crop;
  $$('#edCrops .chip').forEach(btn => {
    btn.classList.toggle('active', cropUi === btn.dataset.crop);
    btn.onclick = () => {
      $$('#edCrops .chip').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.edit.crop = btn.dataset.crop;
    };
  });
  state.edit.crop = cropUi;
  // sliders
  $('#edSize').value = d.size || 1; $('#edSizeVal').textContent = Math.round((d.size||1)*100)+'%';
  $('#edSize').oninput = (e) => { state.edit.size = +e.target.value; $('#edSizeVal').textContent = Math.round(e.target.value*100)+'%'; };
  state.edit.size = d.size || 1;
  $('#edPos').value = d.position || 0.78;
  $('#edPos').oninput = () => {};
  state.edit.position = d.position || 0.78;
  $('#edPos').onchange = (e) => { state.edit.position = +e.target.value; };
  // punch-in
  const punch = d.punch ?? 1.3;
  $('#edPunch').value = punch;
  $('#edPunchVal').textContent = `${(+punch).toFixed(2).replace(/0$/, '')}×`;
  $('#edPunch').oninput = (e) => {
    state.edit.punch = +e.target.value;
    $('#edPunchVal').textContent = `${(+e.target.value).toFixed(2).replace(/0$/, '')}×`;
  };
  state.edit.punch = punch;
  // hook
  $('#edHook').value = d.title || '';
  $('#edHook').oninput = (e) => { state.edit.title = e.target.value; };
  state.edit.title = d.title || '';
  // zoom
  $('#edZoom').checked = Number(d.zoom) > 0;
  $('#edZoom').onchange = (e) => { state.edit.zoom = e.target.checked ? 0.06 : 0; };
  state.edit.zoom = Number(d.zoom) > 0 ? Number(d.zoom) : 0;
  // words + subject
  state.edit.words = d.words || [];
  state.edit.subject = d.subject || null;
  // music (async: fills the upload list from /api/music)
  setupEditorMusic(d);
}

let previewPoll = null;

function resetPreviewUI(msg) {
  clearInterval(previewPoll);
  previewPoll = null;
  const pv = $('#edPreview');
  if (pv) { pv.disabled = false; pv.innerHTML = '<span>Preview (fast)</span>'; }
  const rd = $('#edRender');
  if (rd) rd.disabled = false;
  if (msg) $('#edStatus').textContent = msg;
}

function finishPreview(id) {
  resetPreviewUI('draft preview ready');
  const v = $('#edVideo');
  if (!v) return;
  v.src = `/api/clips/${id}/preview?v=${Date.now()}`;
  v.play().catch(() => {});
}

function pollPreview(id) {
  clearInterval(previewPoll);
  const t0 = Date.now();
  let last = -1;
  let waiting = false;
  previewPoll = setInterval(async () => {
    if (!state.edit || state.edit.clip.id !== id) {
      clearInterval(previewPoll);
      previewPoll = null;
      return;
    }
    try {
      const r = await fetch(`/api/clips/${id}/preview?v=${Date.now()}`, { method: 'HEAD' });
      const len = Number(r.headers.get('content-length') || 0);
      if (r.ok && len > 1000 && len === last) { finishPreview(id); return; }
      last = len;
    } catch {}
    // a failed draft never writes a file — don't leave the buttons dead
    const quiet = Date.now() - t0;
    if (quiet > 60000 && !waiting) {
      waiting = true;
      $('#edStatus').textContent = 'draft is taking long — still working…';
    }
    if (quiet > 240000) resetPreviewUI('draft failed — try again');
  }, 1400);
}

$('#edPreview').onclick = async () => {
  if (!state.edit) return;
  const btn = $('#edPreview');
  const rd = $('#edRender');
  btn.disabled = true;
  rd.disabled = true;
  btn.innerHTML = '<span>Previewing…</span>';
  $('#edStatus').textContent = 'draft render at half size';
  const e = state.edit;
  try {
    await api(`/api/clips/${e.clip.id}/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(editorPayload(e)),
    });
    $('#edStatus').textContent = 'rendering draft…';
    pollPreview(e.clip.id);
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
    rd.disabled = false;
    btn.innerHTML = '<span>Preview (fast)</span>';
    $('#edStatus').textContent = err.message;
  }
};

$('#edRender').onclick = async () => {
  if (!state.edit) return;
  const btn = $('#edRender');
  btn.disabled = true;
  btn.innerHTML = '<span>Rendering…</span>';
  $('#edStatus').textContent = 'sending to queue';
  try {
    const e = state.edit;
    await api(`/api/clips/${e.clip.id}/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(editorPayload(e)),
    });
    toast('Clip re-render started');
    $('#edStatus').textContent = 'in queue — will update in library';
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = '<span>Re-render clip</span>';
      const fromEdits = Boolean(state.edit?.fromEdits);
      $('#editor').classList.add('hidden');
      if (!fromEdits && state.active) openProject(state.active.project.id);
      loadProjects();
      loadEdits();
    }, 800);
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
    btn.innerHTML = '<span>Re-render clip</span>';
    $('#edStatus').textContent = err.message;
  }
};

$$('[data-close]').forEach(b => b.addEventListener('click', () => $('#editor').classList.add('hidden')));
$('#editor').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) $('#editor').classList.add('hidden'); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#editor').classList.add('hidden'); closeRail(); }
  const editorOpen = !document.getElementById('editor').classList.contains('hidden');
  if (!editorOpen || document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    const v = $('#edVideo');
    e.preventDefault();
    if (v.paused) v.play(); else v.pause();
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const v = $('#edVideo');
    e.preventDefault();
    const step = e.shiftKey ? 1 : 0.1;
    v.currentTime = Math.max(0, v.currentTime + (e.key === 'ArrowLeft' ? -step : step));
  }
});

async function refreshActive() {
  if (state.active && !$('#viewProject').classList.contains('hidden')) {
    try {
      const d = await api(`/api/projects/${state.active.project.id}`);
      state.active = d;
      toggleJobbar(d.project);
      renderClips(d);
    } catch {}
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshActive();
    loadProjects().catch(() => {});
    loadEdits();
  }, 180);
}

setInterval(scheduleRefresh, 5000);

// live updates over SSE; polling above stays as a fallback
try {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'preview' && state.edit && ev.clipId === state.edit.clip.id) {
        finishPreview(ev.clipId);
        return;
      }
      if (ev.type === 'clip' && state.edit && ev.clip?.id === state.edit.clip.id && ev.clip.status === 'ready') {
        const v = $('#edVideo');
        if (v) {
          v.src = `/api/clips/${ev.clip.id}/file?v=${Date.now()}`;
          v.play().catch(() => {});
          $('#edStatus').textContent = 'final render ready';
        }
      }
      if (['progress', 'project', 'clip', 'done', 'deleted', 'job'].includes(ev.type)) scheduleRefresh();
    } catch {}
  };
  es.onerror = () => {};
} catch {}

$('#newBtn').onclick = () => {
  nav('home');
  $('#viewHome').classList.remove('hidden');
  $('#viewProject').classList.add('hidden');
  $('#workbench').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#dropCard').animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }],
    { duration: 520, easing: 'cubic-bezier(.22,1,.36,1)' },
  );
};
$('#openFolderBtn').onclick = () => toast(state.health?.dataDir || 'data folder', 'info');

init();
