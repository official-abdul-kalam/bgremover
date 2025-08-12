const state = {
  fileIds: [],
  currentId: null,
  options: {
    background_mode: 'transparent',
    background_color: '#00000000',
    background_image_id: null,
    blur_background: 0,
    add_shadow: false,
    add_glow: false,
    ar_style: 'none',
    upscale: 1,
    output_format: 'PNG',
    export_mask: false,
  },
  jobId: null,
  dividerX: 0.5,
};

function $(sel){ return document.querySelector(sel); }

function setTheme(light){
  if(light) document.body.classList.add('light');
  else document.body.classList.remove('light');
}

function b64ToBlob(b64){
  const [meta, data] = b64.split(',');
  const contentType = meta.match(/image\/(\w+)/)[1];
  const byteChars = atob(data);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: `image/${contentType}` });
}

async function uploadFiles(files){
  const fd = new FormData();
  for(const f of files) fd.append('files', f);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const j = await res.json();
  if(!res.ok) throw new Error(j.error || 'Upload failed');
  state.fileIds = j.fileIds;
  state.currentId = state.fileIds[0];
  $('#beforeImg').src = URL.createObjectURL(files[0]);
  $('#afterImg').src = j.preview;
}

async function refreshPreview(){
  if(!state.currentId) return;
  const payload = { fileId: state.currentId, options: state.options };
  const res = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await res.json();
  if(!res.ok) throw new Error(j.error || 'Preview failed');
  $('#afterImg').src = j.preview;
}

function setupDragDrop(){
  const drop = $('#dropArea');
  const input = $('#fileInput');
  $('#btnBrowse').onclick = () => input.click();
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', e => { drop.classList.remove('drag'); });
  drop.addEventListener('drop', async e => {
    e.preventDefault(); drop.classList.remove('drag');
    if(e.dataTransfer.files.length) await uploadFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', async e => { if(input.files.length) await uploadFiles(input.files); });
}

function setupControls(){
  // background mode
  document.querySelectorAll('.seg').forEach(btn => btn.addEventListener('click', async e => {
    document.querySelectorAll('.seg').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const mode = e.currentTarget.getAttribute('data-bg');
    state.options.background_mode = mode;
    await refreshPreview();
  }));
  // background color
  $('#bgColor').addEventListener('change', async e => {
    const hex = e.target.value;
    state.options.background_color = hex + 'ff';
    await refreshPreview();
  });
  // background image
  $('#btnBgImage').onclick = () => $('#bgImage').click();
  $('#bgImage').addEventListener('change', async e => {
    if(!e.target.files.length) return;
    // Upload bg image as normal to reuse storage; take first id as background_image_id
    const fd = new FormData();
    fd.append('files', e.target.files[0]);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const j = await res.json();
    state.options.background_image_id = j.fileIds[0];
    await refreshPreview();
  });
  // effects
  $('#blurRange').addEventListener('input', async e => { state.options.blur_background = Number(e.target.value); await refreshPreview(); });
  $('#shadowToggle').addEventListener('change', async e => { state.options.add_shadow = e.target.checked; await refreshPreview(); });
  $('#glowToggle').addEventListener('change', async e => { state.options.add_glow = e.target.checked; await refreshPreview(); });
  $('#arStyle').addEventListener('change', async e => { state.options.ar_style = e.target.value; await refreshPreview(); });
  $('#upscale').addEventListener('change', async e => { state.options.upscale = Number(e.target.value); await refreshPreview(); });
  $('#format').addEventListener('change', async e => { state.options.output_format = e.target.value; await refreshPreview(); });
  $('#exportMask').addEventListener('change', e => { state.options.export_mask = e.target.checked; });

  // resolution
  const w = $('#outWidth');
  const h = $('#outHeight');
  $('#btnUseOriginal').addEventListener('click', async () => {
    const before = $('#beforeImg');
    if(before.naturalWidth && before.naturalHeight){
      w.value = before.naturalWidth;
      h.value = before.naturalHeight;
      state.options.output_width = before.naturalWidth;
      state.options.output_height = before.naturalHeight;
      await refreshPreview();
    }
  });
  w.addEventListener('change', async e => { const v = Number(e.target.value)||null; state.options.output_width = v; await refreshPreview(); });
  h.addEventListener('change', async e => { const v = Number(e.target.value)||null; state.options.output_height = v; await refreshPreview(); });

  // jpg quality
  const jq = $('#jpgQuality');
  const jqv = $('#jpgQualityVal');
  jq.addEventListener('input', e => { jqv.textContent = e.target.value; state.options.jpg_quality = Number(e.target.value); });

  $('#btnSave').addEventListener('click', async () => {
    // Process only current
    if(!state.currentId) return;
    const res = await fetch('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [state.currentId], options: state.options }) });
    const j = await res.json();
    state.jobId = j.jobId;
    $('#progressWrap').style.display = 'block';
    pollJob();
  });

  $('#btnProcessAll').addEventListener('click', async () => {
    if(!state.fileIds.length) return;
    const res = await fetch('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: state.fileIds, options: state.options }) });
    const j = await res.json();
    state.jobId = j.jobId;
    $('#progressWrap').style.display = 'block';
    pollJob();
  });

  $('#toggleTheme').addEventListener('click', () => {
    document.body.classList.toggle('light');
  });
}

function setupCompare(){
  const cmp = $('#compare');
  const divider = $('#divider');
  let dragging = false;
  function setX(x){
    const rect = cmp.getBoundingClientRect();
    let ratio = (x - rect.left) / rect.width; ratio = Math.max(0.05, Math.min(0.95, ratio));
    state.dividerX = ratio;
    $('#beforeImg').style.clipPath = `inset(0 ${100*(1-ratio)}% 0 0)`;
    $('#afterImg').style.clipPath = `inset(0 0 0 ${100*ratio}%)`;
    divider.style.left = `${100*ratio}%`;
  }
  divider.addEventListener('mousedown', () => dragging = true);
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('mousemove', e => { if(dragging) setX(e.clientX); });
  cmp.addEventListener('click', e => setX(e.clientX));
  setX(cmp.getBoundingClientRect().left + cmp.getBoundingClientRect().width/2);
}

async function pollJob(){
  if(!state.jobId) return;
  const res = await fetch(`/api/job_status/${state.jobId}`);
  const j = await res.json();
  const pct = j.progress || 0;
  $('#progressBar').style.width = pct + '%';
  $('#progressText').textContent = pct + '%';
  if(j.status === 'finished' && j.zip){
    // Auto download
    const a = document.createElement('a'); a.href = `/download/${j.zip}`; a.download = j.zip; document.body.appendChild(a); a.click(); a.remove();
    state.jobId = null;
    setTimeout(() => { $('#progressWrap').style.display = 'none'; $('#progressBar').style.width = '0%'; $('#progressText').textContent = '0%'; }, 800);
    return;
  }
  if(j.status === 'error'){
    alert('Error: ' + j.error);
    state.jobId = null;
    return;
  }
  setTimeout(pollJob, 600);
}

function init(){
  setupDragDrop();
  setupControls();
  setupCompare();
}

document.addEventListener('DOMContentLoaded', init);