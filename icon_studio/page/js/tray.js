// The drop tray: dropped image files become tiles, kept on the server (tray/) until they are assigned.
// Click picks one tile, Ctrl-click adds to or removes from the pick (up to MAX_PICK), and the picked
// ones are saved to the targeted slot together. Also the Selected Icon preview under it, which opens the editor.
let MAX_PICK = 24;     // the server's limit, from /registry
let candidates = [];   // { el, id, image } per tile, null once the tile has left the tray
let picked = [];       // candidate indexes, in pick order

// The left-panel preview: the first picked candidate, or else the targeted slot's own image.
let previewSrc = null; // { type: 'candidate', index, imageSrc } or { type: 'slot', key, imageSrc }

function updatePreview() {
    const key = $('slot').value.trim();
    const entry = KEY_RE.test(key) && slotEntry(key);
    if (picked.length) previewSrc = { type: 'candidate', index: picked[0], imageSrc: candidates[picked[0]].image };
    else if (entry && entry.type === 'image' && entry.value) previewSrc = { type: 'slot', key, imageSrc: iconEl(entry).src };
    else previewSrc = null;
    const wrap = $('preview-wrap');
    wrap.innerHTML = '';
    if (previewSrc) {
        const img = document.createElement('img');
        img.src = previewSrc.imageSrc;
        img.title = 'Click to edit';
        img.onclick = () => openPreviewInEditor('wand');
        wrap.appendChild(img);
    } else {
        wrap.innerHTML = '<span class="preview-empty">Select a slot or pick an icon</span>';
    }
    document.querySelectorAll('.mini-toolbar button').forEach(b => { b.disabled = !previewSrc; });
}

window.openPreviewInEditor = function(toolName) {
    if (!previewSrc) return;
    const target = previewSrc.type === 'candidate' ? { type: 'candidate', index: previewSrc.index } : { type: 'slot', key: previewSrc.key };
    startEdit(target, previewSrc.imageSrc, toolName);
};

window.openEditor = function(i, toolName) {
    startEdit({ type: 'candidate', index: i }, candidates[i].image, toolName);
};

// Drag and drop: dropped image files become extra candidate tiles, already picked.
let dragDepth = 0;
const hasFiles = e => e.dataTransfer.types.includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    if (!hasFiles(e)) return;
    // .jfif, .pjpeg and friends often arrive with an empty type; the server checks the bytes.
    const files = Array.from(e.dataTransfer.files).filter(f =>
        f.type.startsWith('image/') || (!f.type && /\.(jfif|pjpeg|pjp|jpe|jpg|jpeg|png|webp|gif|bmp|ico|tiff?)$/i.test(f.name)));
    if (!files.length) return setStatus('Drop image files (PNG, JPG, JFIF, WebP…).', true);
    files.forEach(addDroppedFile);
});

// Dropped files are turned into icons by the server, a few at a time.
const uploadQueue = [];
let uploading = 0;

function addDroppedFile(file) {
    const i = candidates.length;
    const el = document.createElement('div');
    el.className = 'candidate checker loading';
    el.title = file.name;
    $('candidates').appendChild(el);
    candidates.push({ el, id: null, image: null });
    uploadQueue.push({ i, file });
    runUploads();
}

function runUploads() {
    while (uploading < 3 && uploadQueue.length) {
        uploading++;
        sendDropped(uploadQueue.shift()).finally(() => { uploading--; runUploads(); });
    }
}

function sendDropped({ i, file }) {
    const c = candidates[i];
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const data = await api('/tray_add', { image: reader.result, name: file.name, removeBg: $('remove-bg').checked });
                showTile(i, data.id, data.image, file.name);
                if (picked.length < MAX_PICK) { picked.push(i); updatePicks(); }
            } catch (err) {
                c.el.className = 'candidate checker failed';
                c.el.textContent = '✕';
                c.el.title = err.message;
            }
            resolve();
        };
        reader.onerror = () => { c.el.className = 'candidate checker failed'; c.el.textContent = '✕'; resolve(); };
        reader.readAsDataURL(file);
    });
}

function showTile(i, id, image, name) {
    const c = candidates[i];
    c.id = id;
    c.image = image;
    c.el.className = 'candidate checker ready';
    c.el.title = name || '';
    c.el.onclick = e => togglePick(i, e.ctrlKey || e.metaKey);
    c.el.innerHTML = '<img src="' + image + '"><button class="edit-btn" onclick="event.stopPropagation(); window.openEditor(' + i + ')">✏️ Edit</button>';
}

// The tray as the server kept it, from before the page was opened.
async function loadTray() {
    const data = await api('/tray');
    data.items.forEach(item => {
        const i = candidates.length;
        const el = document.createElement('div');
        $('candidates').appendChild(el);
        candidates.push({ el, id: item.id, image: item.image });
        showTile(i, item.id, item.image, item.name);
    });
}

// An edited tile is kept as edited.
function trayEdited(i) {
    const c = candidates[i];
    if (c && c.id) api('/tray_edit', { id: c.id, image: c.image }).catch(e => setStatus(e.message, true));
}

// Takes tiles out of the tray, on the server too.
async function removeTiles(indexes) {
    const ids = indexes.map(i => candidates[i].id).filter(Boolean);
    if (ids.length) await api('/tray_remove', { ids });
    indexes.forEach(i => { candidates[i].el.remove(); candidates[i] = null; });
    picked = picked.filter(i => !indexes.includes(i));
}

async function discardPicked() {
    try {
        await removeTiles(picked.slice());
        updatePicks();
        setStatus('');
    } catch (e) {
        setStatus(e.message, true);
    }
}

function togglePick(i, add) {
    const c = candidates[i];
    if (!c || !c.image) return;
    const at = picked.indexOf(i);
    if (!add) {
        picked = at >= 0 && picked.length === 1 ? [] : [i];
    } else if (at >= 0) {
        picked.splice(at, 1);
    } else if (picked.length < MAX_PICK) {
        picked.push(i);
    } else {
        return setStatus('You can pick up to ' + MAX_PICK + '. Unpick one first.', true);
    }
    setStatus('');
    updatePicks();
}

function updatePicks() {
    candidates.forEach((c, i) => {
        if (!c) return;
        const n = picked.indexOf(i);
        c.el.classList.toggle('picked', n >= 0);
        c.el.dataset.pick = n >= 0 ? n + 1 : '';
    });
    const key = $('slot').value.trim();
    $('save-btn').disabled = !picked.length;
    $('discard-btn').disabled = !picked.length;
    $('save-btn').textContent = picked.length ? 'Save ' + picked.length + ' to ' + (key || '…') : 'Save selected';
    updatePreview();
}

// Nothing picked and no slot targeted: the Selected Icon box goes back to empty.
function clearPicks() {
    picked = [];
    $('slot').value = '';
    setStatus('');
    slotChanged();
}

async function saveSelected() {
    const key = $('slot').value.trim();
    if (!KEY_RE.test(key)) return setStatus('Choose an icon slot like taskbar.network (lowercase, one dot).', true);
    const chosen = picked.slice();
    try {
        const data = await api('/save', { key, images: chosen.map(i => candidates[i].image) });
        applyRegistry(data);
        await removeTiles(chosen);
        renderRegistry();
        updatePicks();
        setStatus('✅ Saved ' + data.files.length + ' to ' + key + '. Reload logOS to see it.');
    } catch (e) {
        setStatus(e.message, true);
    }
}
