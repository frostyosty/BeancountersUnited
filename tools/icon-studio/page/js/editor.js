// The editor: the canvas, undo, zoom, sliders, and the tools. Each tool file (selection.js,
// transform.js, paint.js) adds its tools with defineTool and their options with defineOptions;
// the editor sends the mouse to the tool that is picked.

// What the editor has open: { type: 'candidate', index } or { type: 'slot', key }. null when closed.
let editing = null;
const canvas = document.getElementById('edit-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const overlay = $('edit-overlay');
const octx = overlay.getContext('2d');
const TOOLS = {};       // name -> the tool's spec, in the order defineTool was called
let tool = 'wand';
let pressed = null;     // the tool the mouse button went down in, until it comes up
let history = [];       // { img, sel } before each change
let zoom = 1;
let lastSlider = null;  // the slider [ and ] step
let live = null;        // what the sliders of scale, stretch and recolor work from: { canvas, img }
// The selection: { seeds: [pixel index], base: Uint8Array or null (kept from an Invert),
// hard: Uint8Array (1 = selected), mask: Uint8Array (0-255, hard after feathering) }.
let sel = null;
// A pasted piece that has not been let go yet: { rest: canvas (the icon under it), piece: canvas }.
// While it floats, moving or turning it leaves the icon under it untouched.
let floating = null;

// A tool: defineTool('name', { label, title, hint, cursor, keepsSelection, down(e, [x, y]),
// move(e), up(e), key(e), enter(), leave(), undone(step) }). Every part but label and title can
// be left out. key returns true when it used the key. enter and leave run as the tool is picked
// and left; undone runs after an undo while the tool is picked, with the step that was undone. The tool gets a button in the editor and one under Selected Icon.
function defineTool(name, spec) {
    TOOLS[name] = spec;
    const button = document.createElement('button');
    button.id = 'tool-' + name;
    button.dataset.tool = name;
    button.title = spec.title;
    button.textContent = spec.label;
    button.addEventListener('click', () => setTool(name));
    $('tool-buttons').appendChild(button);
    const mini = button.cloneNode(true);
    mini.id = 'mt-' + name;
    delete mini.dataset.tool;
    mini.disabled = true;
    mini.addEventListener('click', () => openPreviewInEditor(name));
    $('mini-toolbar').appendChild(mini);
}

// Options shown under the tool buttons while one of the tools named (space-separated) is picked.
// An element in them with data-only="wand ..." shows only for those tools. Returns the options' box.
function defineOptions(tools, html) {
    const box = document.createElement('div');
    box.className = 'tool-opts';
    box.dataset.for = tools;
    box.hidden = true;
    box.innerHTML = html;
    $('tool-options').appendChild(box);
    box.querySelectorAll('input[type=range]').forEach(wireSlider);
    return box;
}

// Every slider has a number box after it, to type an exact value. The tools read the box,
// which for Scale and Stretch may go past the slider's range.
const numOf = range => range.nextElementSibling;

function val(id) {
    const n = numOf($(id));
    return Math.max(Number(n.min), Math.min(Number(n.max), Number(n.value) || 0));
}

function showValue(range) {
    numOf(range).value = range.value;
}

function wireSlider(range) {
    range.addEventListener('input', e => {
        lastSlider = range;
        if (e.detail !== 'typed') showValue(range);
    });
    numOf(range).addEventListener('input', () => {
        if (numOf(range).value === '') return;
        range.value = numOf(range).value;
        range.dispatchEvent(new CustomEvent('input', { detail: 'typed' }));
    });
}

wireSlider($('edit-zoom'));

// [ and ] step the slider used last (or the tool's first one, or the zoom).
function stepSlider(dir, big) {
    const shown = document.querySelector('.tool-opts:not([hidden]) label:not([hidden]) > input[type=range]');
    const range = lastSlider && lastSlider.offsetParent ? lastSlider : shown || $('edit-zoom');
    const n = numOf(range);
    n.value = val(range.id) + dir * (Number(range.step) || 1) * (big ? 10 : 1);
    n.value = val(range.id);
    n.dispatchEvent(new Event('input'));
}

window.setTool = function(name) {
    if (TOOLS[tool] && TOOLS[tool].leave) TOOLS[tool].leave();
    endLive();
    tool = name;
    poly = lastSlider = null;
    if (!TOOLS[name].keepsSelection) sel = floating = null;
    document.querySelectorAll('.toolbar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
    document.querySelectorAll('.tool-opts').forEach(o => { o.hidden = !o.dataset.for.split(' ').includes(name); });
    document.querySelectorAll('.tool-opts [data-only]').forEach(el => { el.hidden = !el.dataset.only.split(' ').includes(name); });
    $('tool-hint').textContent = TOOLS[name].hint || '';
    canvas.style.cursor = TOOLS[name].cursor || 'default';
    drawSelection();
    showPx();
    if (TOOLS[name].enter) TOOLS[name].enter();
};

function pushHistory() {
    const kept = sel && { ...sel, seeds: sel.seeds.slice(), hard: sel.hard.slice(), mask: sel.mask.slice() };
    history.push({ img: ctx.getImageData(0, 0, canvas.width, canvas.height), sel: kept, floating });
    if (history.length > 30) history.shift();
    $('edit-undo').disabled = false;
}

window.undoEdit = function() {
    const prev = history.pop();
    live = null;
    if (prev) {
        ctx.putImageData(prev.img, 0, 0);
        sel = prev.sel;
        floating = prev.floating;
        poly = null;
        drawSelection();
    }
    endLive();
    $('edit-undo').disabled = !history.length;
    if (prev && TOOLS[tool].undone) TOOLS[tool].undone(prev);
};

function copyCanvas() {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    c.getContext('2d').drawImage(canvas, 0, 0);
    return c;
}

// Slider tools redraw from the picture as it was when the slider was first moved, so the whole
// drag is one undo step.
function beginLive() {
    if (live) return;
    pushHistory();
    live = { canvas: copyCanvas(), img: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

function endLive() {
    // A pasted piece that was turned stays afloat as it now looks.
    if (live && live.piece && floating) floating = { rest: floating.rest, piece: live.piece };
    live = baseBox = null;
    document.querySelectorAll('.toolbar input[data-reset]').forEach(i => { i.value = i.dataset.reset; showValue(i); });
    showPx();
}

// Zoom: the icon is shown as large as the editor allows, times the zoom. The point under the
// mouse (or the middle of the view) stays where it is.
function setZoom(value, e) {
    const box = $('canvas-container'), view = box.getBoundingClientRect();
    const at = e ? [e.clientX, e.clientY] : [view.left + box.clientWidth / 2, view.top + box.clientHeight / 2];
    const before = canvas.getBoundingClientRect();
    const fx = (at[0] - before.left) / before.width, fy = (at[1] - before.top) / before.height;
    zoom = Math.max(1, Math.min(16, value));
    canvas.style.width = Math.round((Math.min(box.clientWidth, box.clientHeight) - 4) * zoom) + 'px';
    $('canvas-stack').classList.toggle('pixels', zoom >= 3);
    $('edit-zoom').value = Math.round(zoom * 100);
    if (document.activeElement !== numOf($('edit-zoom'))) showValue($('edit-zoom'));
    const after = canvas.getBoundingClientRect();
    box.scrollLeft += after.left + fx * after.width - at[0];
    box.scrollTop += after.top + fy * after.height - at[1];
}

$('edit-zoom').addEventListener('input', () => setZoom(val('edit-zoom') / 100));
$('canvas-container').addEventListener('wheel', e => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), e);
}, { passive: false });
window.addEventListener('resize', () => { if (editing) setZoom(zoom); });

function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * canvas.width / rect.width);
    const y = Math.floor((e.clientY - rect.top) * canvas.height / rect.height);
    return [Math.max(0, Math.min(canvas.width, x)), Math.max(0, Math.min(canvas.height, y))];
}

// Runs a change on the canvas pixels as one undo step.
function changePixels(change) {
    endLive();
    floating = null;
    pushHistory();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const before = new Uint8ClampedArray(img.data);
    change(img, before);
    ctx.putImageData(img, 0, 0);
}

function newCanvas(draw) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    draw(c.getContext('2d'));
    return c;
}

// The mouse goes to the picked tool. A drag stays with the tool it started in.
canvas.addEventListener('mousedown', e => {
    if (!editing || e.button) return;
    e.preventDefault();
    pressed = TOOLS[tool];
    if (pressed.down) pressed.down(e, canvasPoint(e));
});

window.addEventListener('mousemove', e => {
    const spec = pressed || TOOLS[tool];
    if (spec && spec.move) spec.move(e);
});

window.addEventListener('mouseup', e => {
    const spec = pressed || TOOLS[tool];
    pressed = null;
    if (spec && spec.up) spec.up(e);
});

function startEdit(target, src, toolName) {
    const img = new Image();
    img.onload = () => {
        editing = target;
        // Icons are shown in a square, so a taller or wider image is centred in one.
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        canvas.width = canvas.height = Math.max(iw, ih);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, (canvas.width - iw) / 2, (canvas.height - ih) / 2);
        history = [];
        sel = floating = null;
        $('edit-undo').disabled = true;
        $('edit-apply').textContent = target.type === 'slot' ? 'Save as the icon for ' + target.key : 'Apply Changes';
        setTool(toolName || 'wand');
        $('editor-modal').hidden = false;
        setZoom(1);
    };
    img.src = src;
}

window.closeEditor = function() {
    $('editor-modal').hidden = true;
    editing = null;
    sel = live = poly = floating = rectStart = null;
};

window.saveEdit = async function() {
    const target = editing;
    const dataUrl = canvas.toDataURL('image/png');
    const changed = history.length;
    closeEditor();
    if (!target || !changed) return;
    if (target.type === 'candidate') {
        const c = candidates[target.index];
        c.image = dataUrl;
        c.el.querySelector('img').src = dataUrl;
        trayEdited(target.index);
        updatePreview();
        return;
    }
    // An edited slot icon becomes the slot's icon; the one before stays in its ▾ list.
    try {
        applyRegistry(await api('/save', { key: target.key, images: [dataUrl] }));
        renderRegistry();
        setStatus('✅ Saved the edited icon to ' + target.key + '. The one before is in its ▾ list. Reload the app to see it.');
    } catch (e) {
        setStatus(e.message, true);
    }
};
