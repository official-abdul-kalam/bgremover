const state = {
  fileIds: [],
  gallery: [], // {id, url, name}
  currentId: null,
  options: {
    background_mode: 'transparent',
    background_color: '#00000000',
    background_image_id: null,
    blur_background: 0,
    add_shadow: false,
    shadow_offset_x: 20,
    shadow_offset_y: 20,
    shadow_blur: 40,
    shadow_opacity: 0.5,
    add_glow: false,
    glow_radius: 20,
    glow_intensity: 0.6,
    glow_color: '#00FFFF',
    ar_style: 'none',
    upscale: 1,
    output_format: 'PNG',
    export_mask: false,
  },
  jobId: null,
  dividerX: 0.5,
  aborter: null,
  debounceTimer: null,
};

function $(sel){ return document.querySelector(sel); }
function create(tag, cls){ const el = document.createElement(tag); if(cls) el.className = cls; return el; }

function debounce(fn, ms){
  return (...args) => { clearTimeout(state.debounceTimer); state.debounceTimer = setTimeout(() => fn(...args), ms); };
}

function showToast(msg){
  let t = $('.toast');
  if(!t){ t = create('div','toast'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function renderGallery(){
  const wrap = $('#gallery'); if(!wrap) return; wrap.innerHTML = '';
  state.gallery.forEach(it => {
    const cell = create('div','gallery-item' + (it.id===state.currentId?' active':''));
    const img = create('img'); img.src = it.url; img.alt = it.name || 'image';
    cell.appendChild(img);
    cell.onclick = () => { state.currentId = it.id; $('#beforeImg').src = it.url; refreshPreview(); renderGallery(); };
    wrap.appendChild(cell);
  });
}

async function uploadFiles(files){
  const fd = new FormData(); for(const f of files) fd.append('files', f);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const j = await res.json(); if(!res.ok) throw new Error(j.error || 'Upload failed');
  // Map IDs to local urls
  const urls = Array.from(files).map(f => URL.createObjectURL(f));
  j.fileIds.forEach((id, i) => state.gallery.push({ id, url: urls[i] || urls[0], name: files[i]?.name }));
  state.fileIds = state.gallery.map(g => g.id);
  state.currentId = state.gallery[0].id;
  $('#beforeImg').src = state.gallery[0].url;
  $('#afterImg').src = j.preview;
  renderGallery();
}

const refreshPreview = debounce(async () => {
  if(!state.currentId) return;
  try {
    if(state.aborter) state.aborter.abort();
    state.aborter = new AbortController();
    const payload = { fileId: state.currentId, options: state.options, fast: true };
    const res = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: state.aborter.signal });
    const j = await res.json();
    if(!res.ok) throw new Error(j.error || 'Preview failed');
    $('#afterImg').src = j.preview;
  } catch {}
}, 150);

function setupDragDrop(){
  const drop = $('#dropArea'); const input = $('#fileInput'); const inputHidden = $('#fileInputHidden');
  const choose = (files) => files && files.length && uploadFiles(files);
  const openPicker = () => (inputHidden || input).click();
  $('#btnBrowse').onclick = openPicker; $('#btnBrowseGhost').onclick = openPicker;
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', e => { drop.classList.remove('drag'); });
  drop.addEventListener('drop', async e => { e.preventDefault(); drop.classList.remove('drag'); choose(e.dataTransfer.files); });
  input?.addEventListener('change', e => choose(input.files));
  inputHidden?.addEventListener('change', e => choose(inputHidden.files));
}

function applyPreset(name){
  const o = state.options;
  if(name==='product'){
    o.background_mode='color'; o.background_color='#ffffffff'; o.blur_background=0; o.add_shadow=true; o.shadow_offset_x=20; o.shadow_offset_y=30; o.shadow_blur=50; o.shadow_opacity=0.45; o.add_glow=false; o.ar_style='none';
  } else if(name==='portrait'){
    o.background_mode='transparent'; o.blur_background=12; o.add_shadow=false; o.add_glow=false; o.ar_style='bokeh';
  } else if(name==='neon'){
    o.background_mode='transparent'; o.add_glow=true; o.glow_color='#00ffff'; o.glow_radius=30; o.glow_intensity=0.8; o.ar_style='neon';
  } else if(name==='holo'){
    o.background_mode='transparent'; o.blur_background=6; o.add_glow=false; o.ar_style='holo';
  }
  renderGallery(); refreshPreview();
}

function setupControls(){
  document.querySelectorAll('.toolbar [data-preset]').forEach(b => b.addEventListener('click', e => applyPreset(e.currentTarget.getAttribute('data-preset'))));

  // background mode
  document.querySelectorAll('.seg').forEach(btn => btn.addEventListener('click', e => {
    document.querySelectorAll('.seg').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const mode = e.currentTarget.getAttribute('data-bg');
    state.options.background_mode = mode; refreshPreview();
  }));
  // background color
  $('#bgColor').addEventListener('change', e => { const hex = e.target.value; state.options.background_color = hex + 'ff'; refreshPreview(); });
  // background image
  $('#btnBgImage').onclick = () => $('#bgImage').click();
  $('#bgImage').addEventListener('change', async e => { if(!e.target.files.length) return; const fd = new FormData(); fd.append('files', e.target.files[0]); const res = await fetch('/api/upload', { method: 'POST', body: fd }); const j = await res.json(); state.options.background_image_id = j.fileIds[0]; refreshPreview(); });

  // effects
  $('#blurRange').addEventListener('input', e => { state.options.blur_background = Number(e.target.value); refreshPreview(); });
  $('#shadowToggle').addEventListener('change', e => { state.options.add_shadow = e.target.checked; refreshPreview(); });
  $('#glowToggle').addEventListener('change', e => { state.options.add_glow = e.target.checked; refreshPreview(); });
  $('#arStyle').addEventListener('change', e => { state.options.ar_style = e.target.value; refreshPreview(); });
  $('#upscale').addEventListener('change', e => { state.options.upscale = Number(e.target.value); refreshPreview(); });
  $('#format').addEventListener('change', e => { state.options.output_format = e.target.value; refreshPreview(); });
  $('#exportMask').addEventListener('change', e => { state.options.export_mask = e.target.checked; });

  // resolution
  const w = $('#outWidth'); const h = $('#outHeight');
  $('#btnUseOriginal').addEventListener('click', () => { const before = $('#beforeImg'); if(before.naturalWidth && before.naturalHeight){ w.value = before.naturalWidth; h.value = before.naturalHeight; state.options.output_width = before.naturalWidth; state.options.output_height = before.naturalHeight; refreshPreview(); } });
  w.addEventListener('change', e => { const v = Number(e.target.value)||null; state.options.output_width = v; refreshPreview(); });
  h.addEventListener('change', e => { const v = Number(e.target.value)||null; state.options.output_height = v; refreshPreview(); });

  // jpg quality
  const jq = $('#jpgQuality'); const jqv = $('#jpgQualityVal');
  jq.addEventListener('input', e => { jqv.textContent = e.target.value; state.options.jpg_quality = Number(e.target.value); });

  // shadow
  $('#shadowOffsetX').addEventListener('input', e => { state.options.shadow_offset_x = Number(e.target.value); refreshPreview(); });
  $('#shadowOffsetY').addEventListener('input', e => { state.options.shadow_offset_y = Number(e.target.value); refreshPreview(); });
  $('#shadowBlur').addEventListener('input', e => { state.options.shadow_blur = Number(e.target.value); refreshPreview(); });
  $('#shadowOpacity').addEventListener('input', e => { state.options.shadow_opacity = Number(e.target.value); refreshPreview(); });

  // glow
  $('#glowColor').addEventListener('input', e => { state.options.glow_color = e.target.value; refreshPreview(); });
  $('#glowRadius').addEventListener('input', e => { state.options.glow_radius = Number(e.target.value); refreshPreview(); });
  $('#glowIntensity').addEventListener('input', e => { state.options.glow_intensity = Number(e.target.value); refreshPreview(); });

  $('#btnSave').addEventListener('click', async () => {
    if(!state.currentId) return;
    const res = await fetch('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [state.currentId], options: state.options }) });
    const j = await res.json(); state.jobId = j.jobId; $('#progressWrap').style.display = 'block'; pollJob();
  });

  $('#btnProcessAll').addEventListener('click', async () => {
    if(!state.fileIds.length) return;
    const res = await fetch('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: state.fileIds, options: state.options }) });
    const j = await res.json(); state.jobId = j.jobId; $('#progressWrap').style.display = 'block'; pollJob();
  });

  $('#toggleTheme').addEventListener('click', () => { document.body.classList.toggle('light'); });
}

function setupCompare(){
  const cmp = $('#compare'); const divider = $('#divider');
  let dragging = false;
  function setX(x){ const rect = cmp.getBoundingClientRect(); let ratio = (x - rect.left) / rect.width; ratio = Math.max(0.05, Math.min(0.95, ratio)); state.dividerX = ratio; $('#beforeImg').style.clipPath = `inset(0 ${100*(1-ratio)}% 0 0)`; $('#afterImg').style.clipPath = `inset(0 0 0 ${100*ratio}%)`; divider.style.left = `${100*ratio}%`; }
  divider.addEventListener('mousedown', () => dragging = true);
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('mousemove', e => { if(dragging) setX(e.clientX); });
  cmp.addEventListener('click', e => setX(e.clientX)); setX(cmp.getBoundingClientRect().left + cmp.getBoundingClientRect().width/2);
}

async function pollJob(){
  if(!state.jobId) return;
  const res = await fetch(`/api/job_status/${state.jobId}`);
  const j = await res.json(); const pct = j.progress || 0;
  $('#progressBar').style.width = pct + '%'; $('#progressText').textContent = pct + '%';
  if(j.status === 'finished' && j.zip){
    const a = document.createElement('a'); a.href = `/download/${j.zip}`; a.download = j.zip; document.body.appendChild(a); a.click(); a.remove(); state.jobId = null; showToast('Export complete'); setTimeout(() => { $('#progressWrap').style.display = 'none'; $('#progressBar').style.width = '0%'; $('#progressText').textContent = '0%'; }, 800); return;
  }
  if(j.status === 'error'){ alert('Error: ' + j.error); state.jobId = null; return; }
  setTimeout(pollJob, 500);
}

function init(){ setupDragDrop(); setupControls(); setupCompare(); }

document.addEventListener('DOMContentLoaded', init);