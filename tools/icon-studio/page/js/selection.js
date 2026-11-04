// Selection tools: the wand, the rectangle, the ellipse and the shape (points dropped around an
// area), and what is done to a selection here: erase, invert, deselect. Moving, stretching and
// turning it is in transform.js.
let poly = null;        // the shape being drawn: { points: [[x,y]], add, cursor }
let rectStart = null;   // the Rect or Ellipse tool's drag: { from: [x, y], box, round, mode }
let wandImg = null;     // the pixels the wand reads while the mouse button is down

// The Ink switch, shown by the paint tools and the selection tools (see paint.js). On a selection
// tool, Colour or Erase is applied to the next selection made, then the ink goes back to None.
const INK_PICK = `
    <span class="ink-pick">Ink
        <button data-ink="none" title="Selection tools only select. Draw, Curve and Fill paint with the colour.">None</button>
        <button data-ink="colour" title="Paint with the colour: a selection is filled with it as soon as it is made">Colour</button>
        <button data-ink="erase" title="Rub out: a selection is erased as soon as it is made">Erase</button>
    </span>`;

// Wand: selects the area around a pixel whose colour is within the tolerance of it.
function flood(seed) {
    const d = wandImg.data, w = canvas.width, n = w * canvas.height;
    const maxDiff = val('wand-tolerance') * 2.55;
    const s = seed * 4;
    const stack = [seed];
    const seen = new Uint8Array(n);
    while (stack.length) {
        const idx = stack.pop();
        if (seen[idx]) continue;
        seen[idx] = 1;
        const p = idx * 4;
        // A fully transparent pixel has no colour of its own, so only its transparency counts.
        const diff = !d[s + 3] || !d[p + 3] ? Math.abs(d[p + 3] - d[s + 3]) : Math.max(
            Math.abs(d[p] - d[s]), Math.abs(d[p + 1] - d[s + 1]), Math.abs(d[p + 2] - d[s + 2]), Math.abs(d[p + 3] - d[s + 3]));
        if (diff > maxDiff) continue;
        sel.hard[idx] = 1;
        const x = idx % w;
        if (x > 0) stack.push(idx - 1);
        if (x + 1 < w) stack.push(idx + 1);
        if (idx >= w) stack.push(idx - w);
        if (idx + w < n) stack.push(idx + w);
    }
}

function addSeed(x, y) {
    const idx = y * canvas.width + x;
    if (sel.hard[idx]) return;
    sel.seeds.push(idx);
    flood(idx);
    featherSelection();
}

// Selects again from the same clicks, after the tolerance changed.
function replayWand() {
    if (!sel || !sel.seeds.length) return;
    wandImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
    sel.hard = sel.base ? sel.base.slice() : new Uint8Array(canvas.width * canvas.height);
    for (const idx of sel.seeds) if (!sel.hard[idx]) flood(idx);
    wandImg = null;
    featherSelection();
}

function blurMask(mask, w, h, r) {
    let a = Float32Array.from(mask), b = new Float32Array(a.length);
    const span = 2 * r + 1;
    const pass = (step, count, lines) => {
        for (let line = 0; line < lines; line++) {
            const at = i => (step === 1 ? line * w + i : i * w + line);
            let sum = 0;
            for (let i = -r; i <= r; i++) sum += a[at(Math.max(0, Math.min(count - 1, i)))];
            for (let i = 0; i < count; i++) {
                b[at(i)] = sum / span;
                sum += a[at(Math.min(count - 1, i + r + 1))] - a[at(Math.max(0, i - r))];
            }
        }
        [a, b] = [b, a];
    };
    for (let n = 0; n < 2; n++) { pass(1, w, h); pass(w, h, w); }
    return Uint8Array.from(a, v => Math.round(v));
}

function featherSelection() {
    const r = Math.round(val('wand-feather'));
    sel.mask = sel.hard.map(v => v * 255);
    if (r) sel.mask = blurMask(sel.mask, canvas.width, canvas.height, r);
    drawSelection();
}

// Draws the selection over the icon: a dashed outline, and a blue tint while selecting. The
// shape being drawn goes on top.
function drawSelection() {
    const w = overlay.width = canvas.width, h = overlay.height = canvas.height;
    document.querySelectorAll('[data-needs-sel]').forEach(b => { b.disabled = !sel; });
    if (sel) {
        const img = octx.createImageData(w, h), d = img.data, hard = sel.hard;
        const tint = ['wand', 'shape', 'rect', 'ellipse'].includes(tool), dash = w > 300 ? 3 : 2;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x, p = i * 4;
                if (hard[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !hard[i - 1] || !hard[i + 1] || !hard[i - w] || !hard[i + w])) {
                    d[p] = d[p + 1] = d[p + 2] = ((x + y) >> dash) & 1 ? 255 : 0;
                    d[p + 3] = 255;
                } else if (tint && sel.mask[i]) {
                    d[p] = 90; d[p + 1] = 160; d[p + 2] = 255;
                    d[p + 3] = sel.mask[i] * 0.4;
                }
            }
        }
        octx.putImageData(img, 0, 0);
    }
    if (rectStart && rectStart.box) drawBoxDrag();
    if (!poly) return;
    const pts = poly.cursor ? poly.points.concat([poly.cursor]) : poly.points;
    const line = Math.max(1, w / 300);
    octx.beginPath();
    pts.forEach(([x, y], i) => (i ? octx.lineTo(x + 0.5, y + 0.5) : octx.moveTo(x + 0.5, y + 0.5)));
    octx.lineWidth = line;
    octx.strokeStyle = '#000';
    octx.stroke();
    octx.setLineDash([line * 3, line * 3]);
    octx.strokeStyle = '#fff';
    octx.stroke();
    octx.setLineDash([]);
    octx.fillStyle = '#8ab4f8';
    for (const [x, y] of poly.points) octx.fillRect(x + 0.5 - line * 1.5, y + 0.5 - line * 1.5, line * 3, line * 3);
}

// Shape: the dropped points become a selection when the shape is closed.
function closeShape() {
    const shape = poly;
    poly = null;
    if (shape && shape.points.length > 2) {
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        const x = c.getContext('2d');
        x.beginPath();
        shape.points.forEach(([px, py], i) => (i ? x.lineTo(px + 0.5, py + 0.5) : x.moveTo(px + 0.5, py + 0.5)));
        x.fill();
        const a = x.getImageData(0, 0, c.width, c.height).data;
        const hard = shape.add && sel ? sel.hard.slice() : new Uint8Array(c.width * c.height);
        for (let i = 0; i < hard.length; i++) if (a[i * 4 + 3] > 127) hard[i] = 1;
        floating = null;
        sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: null } : null;
        if (sel) {
            featherSelection();
            return applyInk();
        }
    }
    drawSelection();
}

window.deselect = function() {
    sel = floating = null;
    drawSelection();
};

window.invertSelection = function() {
    floating = null;
    const hard = sel ? sel.hard.map(v => 1 - v) : new Uint8Array(canvas.width * canvas.height).fill(1);
    sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: null } : null;
    if (sel) featherSelection();
    else drawSelection();
};

// Limits a change to the selection: unselected pixels go back to what they were.
function blendSelection(d, before) {
    if (!sel) return;
    for (let i = 0; i < sel.mask.length; i++) {
        const m = sel.mask[i];
        if (m === 255) continue;
        for (let p = i * 4, end = p + 4; p < end; p++) d[p] = before[p] + (d[p] - before[p]) * m / 255;
    }
}

window.eraseSelection = function() {
    if (!sel) return;
    if (floating) {
        // A pasted piece that still floats goes away whole; the icon under it is as it was.
        endLive();
        pushHistory();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(floating.rest, 0, 0);
        return deselect();
    }
    const { hard, mask } = sel;
    const soft = val('wand-feather') > 0;
    changePixels(img => {
        if (soft) for (let i = 0; i < mask.length; i++) img.data[i * 4 + 3] *= (255 - mask[i]) / 255;
        else eraseArea(img, hard);
    });
    deselect();
};

// Erases an area. The pixels along its edge are a blend of the erased colour and the icon:
// they are given the icon's colour at a matching transparency, so no fringe of the erased
// colour is left. The same rule as soften_edge on the server.
function eraseArea(img, erased) {
    const d = img.data, w = img.width, h = img.height;
    const src = new Uint8ClampedArray(d);
    for (let i = 0; i < erased.length; i++) if (erased[i]) d[i * 4 + 3] = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            if (erased[y * w + x] || src[p + 3] < 255) continue;
            const y0 = Math.max(0, y - 2), y1 = Math.min(h - 1, y + 2), x0 = Math.max(0, x - 2), x1 = Math.min(w - 1, x + 2);
            let bg = -1;
            for (let ny = y0; ny <= y1 && bg < 0; ny++) {
                for (let nx = x0; nx <= x1; nx++) {
                    const n = ny * w + nx;
                    if (erased[n] && src[n * 4 + 3]) { bg = n * 4; break; }
                }
            }
            if (bg < 0) continue;
            // The icon's colour here: the opaque pixel within 2 px that is least like the erased colour.
            let far = 0, f = p;
            for (let ny = y0; ny <= y1; ny++) {
                for (let nx = x0; nx <= x1; nx++) {
                    const n = ny * w + nx, q = n * 4;
                    if (erased[n] || src[q + 3] < 255) continue;
                    const dist = (src[q] - src[bg]) ** 2 + (src[q + 1] - src[bg + 1]) ** 2 + (src[q + 2] - src[bg + 2]) ** 2;
                    if (dist > far) { far = dist; f = q; }
                }
            }
            if (far < 256) continue;
            // How far this pixel is from the erased colour towards the icon's colour (0 to 1).
            let dot = 0;
            for (let c = 0; c < 3; c++) dot += (src[p + c] - src[bg + c]) * (src[f + c] - src[bg + c]);
            const alpha = Math.max(0, dot / far);
            if (alpha >= 0.95) continue;
            // A pixel that is not on the line between the two colours is its own colour, not a blend.
            let off = 0;
            for (let c = 0; c < 3; c++) off += (src[p + c] - src[bg + c] - alpha * (src[f + c] - src[bg + c])) ** 2;
            if (off > 900) continue;
            d[p] = src[f];
            d[p + 1] = src[f + 1];
            d[p + 2] = src[f + 2];
            d[p + 3] = Math.round(alpha * 255);
        }
    }
}

const adding = e => e.ctrlKey || e.metaKey || e.shiftKey;

defineTool('wand', {
    label: '🪄 Wand',
    title: 'Select areas by colour, to erase, recolor or move',
    hint: 'Click an area to select it. Hold and drag to add what you drag over, Ctrl+click to add areas that do not touch. Then Erase (Del), Recolor or Move it. Feather softens the edge of what you erase, recolor or move.',
    cursor: 'crosshair',
    keepsSelection: true,
    down(e, [x, y]) {
        floating = null;
        // A plain click starts a new selection; Ctrl (or Shift) adds to the one there is.
        if (!sel || !adding(e)) sel = { seeds: [], base: null, hard: new Uint8Array(canvas.width * canvas.height), mask: null };
        wandImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
        addSeed(Math.min(x, canvas.width - 1), Math.min(y, canvas.height - 1));
    },
    move(e) {
        if (!wandImg) return;
        // Dragging adds every area the pointer passes over.
        const rect = canvas.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) return;
        const [x, y] = canvasPoint(e);
        addSeed(Math.min(x, canvas.width - 1), Math.min(y, canvas.height - 1));
    },
    up() {
        wandImg = null;
        applyInk();
    },
});

// Rect and Ellipse: drag a box. Ctrl adds to the selection there is, Alt takes the box away from
// it, Shift keeps it square (a circle). A drag that leaves the icon stops at its edge.
function boxMode(e) {
    return e.altKey ? 'cut' : e.ctrlKey || e.metaKey ? 'add' : 'new';
}

const inIcon = ([x, y]) => [Math.min(x, canvas.width - 1), Math.min(y, canvas.height - 1)];

// The box between the drag's first pixel and this one, both included: [x0, y0, x1, y1].
function dragBox(e) {
    const [ax, ay] = rectStart.from;
    let [x, y] = inIcon(canvasPoint(e));
    if (e.shiftKey) {
        const dx = x - ax, dy = y - ay;
        const s = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), dx < 0 ? ax : canvas.width - 1 - ax, dy < 0 ? ay : canvas.height - 1 - ay);
        x = ax + (dx < 0 ? -s : s);
        y = ay + (dy < 0 ? -s : s);
    }
    return [Math.min(ax, x), Math.min(ay, y), Math.max(ax, x), Math.max(ay, y)];
}

function boxPath(x, [x0, y0, x1, y1], round) {
    x.beginPath();
    if (round) x.ellipse((x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2, (x1 - x0 + 1) / 2, (y1 - y0 + 1) / 2, 0, 0, Math.PI * 2);
    else x.rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

function drawBoxDrag() {
    const line = Math.max(1, canvas.width / 300);
    boxPath(octx, rectStart.box, rectStart.round);
    octx.lineWidth = line;
    octx.strokeStyle = '#000';
    octx.stroke();
    octx.setLineDash([line * 3, line * 3]);
    octx.strokeStyle = '#fff';
    octx.stroke();
    octx.setLineDash([]);
}

// The pixels of the box (or the ellipse in it) that are selected, then added to, taken away from
// or put in place of the selection.
function selectBox(box, round, mode) {
    const w = canvas.width, h = canvas.height;
    const inside = new Uint8Array(w * h);
    if (round) {
        const a = newCanvas(x => { boxPath(x, box, true); x.fill(); }).getContext('2d').getImageData(0, 0, w, h).data;
        for (let i = 0; i < inside.length; i++) inside[i] = a[i * 4 + 3] > 127 ? 1 : 0;
    } else {
        for (let y = box[1]; y <= box[3]; y++) inside.fill(1, y * w + box[0], y * w + box[2] + 1);
    }
    let hard = inside;
    if (mode !== 'new' && sel) {
        hard = sel.hard.slice();
        for (let i = 0; i < hard.length; i++) if (inside[i]) hard[i] = mode === 'add' ? 1 : 0;
    } else if (mode === 'cut') {
        hard = new Uint8Array(w * h);
    }
    floating = null;
    sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: null } : null;
    if (sel) featherSelection();
    else drawSelection();
}

function boxTool(name, round, spec) {
    defineTool(name, {
        ...spec,
        cursor: 'crosshair',
        keepsSelection: true,
        outside: true,
        down(e, at) {
            rectStart = { from: inIcon(at), box: null, round, mode: boxMode(e) };
        },
        move(e) {
            if (!rectStart) return;
            rectStart.box = dragBox(e);
            drawSelection();
        },
        up() {
            if (!rectStart) return;
            const r = rectStart;
            rectStart = null;
            // A click without a drag selects nothing.
            if (!r.box) return r.mode === 'new' ? deselect() : drawSelection();
            selectBox(r.box, round, r.mode);
            applyInk();
        },
    });
}

boxTool('rect', false, {
    label: '⬚ Rect',
    title: 'Select a rectangle by dragging a box',
    hint: 'Drag a box to select it. Ctrl adds to the selection, Alt takes away from it, Shift keeps it square. The box stops at the edge of the icon, so start outside it to reach the edge. Then Erase (Del), Recolor, Move, Transform or Rotate it.',
});

boxTool('ellipse', true, {
    label: '◯ Ellipse',
    title: 'Select an ellipse or a circle by dragging a box around it',
    hint: 'Drag a box to select the ellipse in it. Ctrl adds to the selection, Alt takes away from it, Shift makes it a circle. Then Erase (Del), Recolor, Move, Transform or Rotate it.',
});

defineTool('shape', {
    label: '📐 Shape',
    title: 'Select an area by dropping points around it',
    hint: 'Click to drop points around an area. Double-click, press Enter or click the first point to close the shape (Backspace removes the last point). Hold Ctrl on the first point to add to the selection there is. Then Erase (Del), Recolor or Move it.',
    cursor: 'crosshair',
    keepsSelection: true,
    outside: true,
    down(e, [x, y]) {
        if (!poly) poly = { points: [], add: adding(e), cursor: null };
        const first = poly.points[0];
        const f = canvas.getBoundingClientRect().width / canvas.width;
        // A double-click or a click on the first point closes the shape.
        if (e.detail > 1 || (poly.points.length > 2 && Math.hypot(x - first[0], y - first[1]) * f < 8)) return closeShape();
        poly.points.push([x, y]);
        poly.cursor = null;
        drawSelection();
    },
    move(e) {
        if (!poly || !poly.points.length) return;
        poly.cursor = canvasPoint(e);
        drawSelection();
    },
    // While a shape is being drawn, keys go to it.
    key(e) {
        if (!poly) return false;
        if (e.key === 'Enter') closeShape();
        else if (e.key === 'Escape') { poly = null; drawSelection(); }
        else if (e.key === 'Backspace') { poly.points.pop(); if (!poly.points.length) poly = null; drawSelection(); }
        else return true;
        e.preventDefault();
        return true;
    },
});

defineOptions('wand rect ellipse shape', `${INK_PICK}
    <input type="color" id="sel-colour" value="#e11d48" title="Colour" hidden>
    <label class="hint" data-only="wand">Tolerance <input type="range" id="wand-tolerance" min="0" max="100" value="10"><input type="number" class="num" min="0" max="100" value="10">%</label>
    <label class="hint">Feather <input type="range" id="wand-feather" min="0" max="12" value="0"><input type="number" class="num" min="0" max="12" value="0">px</label>
    <button data-needs-sel title="Erase the selected area (Del)" onclick="eraseSelection()">Erase</button>
    <button data-needs-sel title="Change the colour of the selected area" onclick="setTool('recolor')">Recolor…</button>
    <button data-needs-sel title="Drag the selected area somewhere else" onclick="setTool('move')">Move…</button>
    <button data-needs-sel title="Stretch, warp, mirror or turn the selected area with handles" onclick="setTool('stretch')">Transform…</button>
    <button data-needs-sel title="Turn the selected area" onclick="setTool('rotate')">Rotate…</button>
    <button title="Select everything that is not selected" onclick="invertSelection()">Invert</button>
    <button data-needs-sel title="Drop the selection (Esc)" onclick="deselect()">Deselect</button>`);

$('wand-tolerance').addEventListener('input', replayWand);
$('wand-feather').addEventListener('input', () => { if (sel) featherSelection(); });

// A tool with outside set (or an outside(e) that says yes) also gets the mouse when it goes down
// next to the icon, so a drag can start outside it and stop at its edge.
$('editor-modal').addEventListener('mousedown', e => {
    if (!editing || e.button || e.target === canvas || e.target.closest('button, input, label, select')) return;
    const spec = TOOLS[tool], view = $('canvas-container').getBoundingClientRect();
    const near = e.clientX >= view.left && e.clientX < view.right && e.clientY >= view.top && e.clientY < view.bottom;
    if (!spec.down || !(typeof spec.outside === 'function' ? spec.outside(e) : spec.outside && near)) return;
    e.preventDefault();
    pressed = spec;
    spec.down(e, canvasPoint(e));
});
