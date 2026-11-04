// Transform tools: crop, scale, transform (handles to stretch, warp, mirror and turn), move and
// rotate, and copy and paste. Transform, move and rotate work on the selection when there is one
// (a pasted piece floats until it is let go).
let clip = null;        // what Copy took: a canvas the size of the icon it came from
let baseBox = null;     // size of the icon itself (no empty space) before Scale
let moveStart = null, moveParts = null, moveBy = [0, 0];
let cropStart = null, cropBox = null, cropSnap = null;

defineTool('crop', {
    label: '✂️ Crop',
    title: 'Drag a box around the part to keep',
    hint: 'Drag a box around the part to keep. It is fitted back into the square.',
    cursor: 'crosshair',
    outside: true,
    down(e, [x, y]) {
        cropStart = [x, y];
        cropBox = null;
        cropSnap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    },
    move(e) {
        if (!cropStart) return;
        const [x, y] = canvasPoint(e);
        let w = Math.abs(x - cropStart[0]), h = Math.abs(y - cropStart[1]);
        if (e.shiftKey) {
            // Shift keeps the box square, as large as fits between the start point and the edges.
            const roomX = x < cropStart[0] ? cropStart[0] : canvas.width - cropStart[0];
            const roomY = y < cropStart[1] ? cropStart[1] : canvas.height - cropStart[1];
            w = h = Math.min(Math.max(w, h), roomX, roomY);
        }
        const bx = x < cropStart[0] ? cropStart[0] - w : cropStart[0];
        const by = y < cropStart[1] ? cropStart[1] - h : cropStart[1];
        cropBox = [Math.max(0, bx), Math.max(0, by), w, h];
        drawCropBox();
    },
    up() {
        if (!cropStart) return;
        cropStart = null;
        ctx.putImageData(cropSnap, 0, 0);
        const box = cropBox;
        cropBox = null;
        if (!box || box[2] < 4 || box[3] < 4) return;
        // Fit the kept box into the square canvas, centred, keeping its aspect ratio.
        floating = null;
        pushHistory();
        const src = copyCanvas();
        const [x, y, w, h] = box;
        const f = Math.min(canvas.width / w, canvas.height / h);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, x, y, w, h, (canvas.width - w * f) / 2, (canvas.height - h * f) / 2, w * f, h * f);
    },
});

defineTool('scale', {
    label: '🔍 Scale',
    title: 'Make the icon bigger or smaller inside its square',
    hint: 'Move the Size slider, or type a percentage or the width in pixels. Below 100% adds a margin, above 100% zooms in. [ and ] step the slider (with Shift, 10 at a time).',
});


defineTool('move', {
    label: '✋ Move',
    title: 'Shift the icon inside its square',
    hint: 'Drag the icon to where it should sit. With a selection, only the selected area moves. The arrow buttons and arrow keys move it 1 px (10 px with Shift).',
    cursor: 'move',
    keepsSelection: true,
    down(e) {
        endLive();
        pushHistory();
        moveStart = [e.clientX, e.clientY];
        moveParts = liftParts();
        moveBy = [0, 0];
    },
    move(e) {
        if (!moveStart) return;
        const f = canvas.width / canvas.getBoundingClientRect().width;
        moveBy = [Math.round((e.clientX - moveStart[0]) * f), Math.round((e.clientY - moveStart[1]) * f)];
        drawParts(moveParts, moveBy[0], moveBy[1]);
        // The outline rides along until the mouse is let go.
        overlay.style.transform = 'translate(' + moveBy[0] * 100 / canvas.width + '%, ' + moveBy[1] * 100 / canvas.height + '%)';
    },
    up() {
        if (!moveStart) return;
        const parts = moveParts;
        moveStart = moveParts = null;
        overlay.style.transform = '';
        // A click without a drag changed nothing, so it is not an undo step.
        if (!moveBy[0] && !moveBy[1]) undoEdit();
        else placeParts(parts, moveBy[0], moveBy[1]);
    },
    // The arrow keys move 1 px, 10 with Shift.
    key(e) {
        const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!arrow) return false;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudge(arrow[0] * step, arrow[1] * step);
        return true;
    },
});

defineTool('rotate', {
    label: '🔄 Rotate',
    title: 'Turn the selected area, or the whole icon',
    hint: 'Move the Angle slider or use the quarter-turn buttons. With a selection, only the selected area turns.',
    keepsSelection: true,
});

defineOptions('scale', `
    <label class="hint">Size <input type="range" id="scale-amount" min="20" max="300" value="100" data-reset="100"><input type="number" class="num" min="1" max="1000" value="100">%</label>
    <label class="hint" title="How wide the icon itself is, without the empty space around it">= <input type="number" class="num" id="scale-px" min="1"> px wide</label>`);


defineOptions('move', `
    <button title="Left 1 px" onclick="nudge(-1, 0)">←</button>
    <button title="Right 1 px" onclick="nudge(1, 0)">→</button>
    <button title="Up 1 px" onclick="nudge(0, -1)">↑</button>
    <button title="Down 1 px" onclick="nudge(0, 1)">↓</button>
    <button title="Put the icon (or the selected area) in the middle of the square" onclick="centreIcon()">Centre</button>`);

defineOptions('rotate', `
    <label class="hint">Angle <input type="range" id="rotate-angle" min="-180" max="180" value="0" data-reset="0"><input type="number" class="num" min="-180" max="180" value="0">°</label>
    <button title="A quarter turn to the left" onclick="rotateQuarter(-1)">⟲ 90°</button>
    <button title="A quarter turn to the right" onclick="rotateQuarter(1)">⟳ 90°</button>`);

// Scale also shows the icon's size in pixels, which can be typed.
function contentBox() {
    if (!baseBox) {
        const d = (live ? live.img : ctx.getImageData(0, 0, canvas.width, canvas.height)).data, w = canvas.width;
        let x0 = w, y0 = canvas.height, x1 = -1, y1 = -1;
        for (let p = 3; p < d.length; p += 4) {
            if (!d[p]) continue;
            const x = (p >> 2) % w, y = Math.floor((p >> 2) / w);
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        baseBox = { w: Math.max(0, x1 - x0 + 1), h: Math.max(0, y1 - y0 + 1) };
    }
    return baseBox;
}

const PX_BOXES = [['scale-px', 'scale-amount', 'w']];

function showPx() {
    if (!editing || tool !== 'scale') return;
    const size = contentBox();
    for (const [px, id, side] of PX_BOXES) {
        if (document.activeElement !== $(px)) $(px).value = Math.round(size[side] * val(id) / 100);
    }
}

PX_BOXES.forEach(([px, id, side]) => $(px).addEventListener('input', () => {
    const size = contentBox()[side];
    if (!size || $(px).value === '') return;
    const n = numOf($(id));
    n.value = Math.round($(px).value / size * 10000) / 100;
    n.dispatchEvent(new Event('input'));
}));

function resizeLive(fx, fy) {
    if (!editing) return;
    floating = null;
    beginLive();
    const w = canvas.width * fx, h = canvas.height * fy;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(live.canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    showPx();
}

$('scale-amount').addEventListener('input', () => resizeLive(val('scale-amount') / 100, val('scale-amount') / 100));

// Move: shifts the whole icon, or only the selected area when there is a selection. What
// leaves the square is cut off.
function liftParts() {
    if (floating) return { rest: floating.rest, lifted: floating.piece };
    if (!sel) return { rest: null, lifted: copyCanvas() };
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const part = keep => {
        const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
        for (let i = 0; i < sel.mask.length; i++) out.data[i * 4 + 3] *= (keep ? 255 - sel.mask[i] : sel.mask[i]) / 255;
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').putImageData(out, 0, 0);
        return c;
    };
    return { rest: part(true), lifted: part(false) };
}

function drawParts(parts, dx, dy) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (parts.rest) ctx.drawImage(parts.rest, 0, 0);
    ctx.drawImage(parts.lifted, dx, dy);
}

// The selection follows the pixels it moved.
function shiftSelection(dx, dy) {
    if (!sel) return;
    const w = canvas.width, h = canvas.height;
    const shift = from => {
        const to = new Uint8Array(from.length);
        for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
            for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) to[(y + dy) * w + x + dx] = from[y * w + x];
        }
        return to;
    };
    const hard = shift(sel.hard);
    sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: shift(sel.mask) } : null;
    drawSelection();
}

// Puts the lifted part down dx, dy from where it was. A pasted piece stays afloat there.
function placeParts(parts, dx, dy) {
    drawParts(parts, dx, dy);
    if (floating) floating = { rest: floating.rest, piece: newCanvas(x => x.drawImage(parts.lifted, dx, dy)) };
    shiftSelection(dx, dy);
}

window.nudge = function(dx, dy) {
    if (!editing || (!dx && !dy)) return;
    endLive();
    pushHistory();
    placeParts(liftParts(), dx, dy);
};

// Rotate: turns the selected area (or the whole icon) around its middle. The selection turns with it.
function rotateLive(angle) {
    if (!editing) return;
    beginLive();
    if (!live.parts) {
        const w = canvas.width, h = canvas.height;
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let i = 0; sel && i < sel.hard.length; i++) {
            if (!sel.hard[i]) continue;
            const x = i % w, y = Math.floor(i / w);
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        if (x1 < 0) [x0, y0, x1, y1] = [0, 0, w - 1, h - 1];
        // Half a pixel off when the area is odd by even, so a quarter turn lands on whole pixels.
        live.centre = [(x0 + x1 + 1) / 2 + ((x1 - x0 + y1 - y0) % 2) / 2, (y0 + y1 + 1) / 2];
        live.parts = liftParts();
        live.sel = sel;
    }
    const [cx, cy] = live.centre;
    const turned = src => newCanvas(x => {
        x.translate(cx, cy);
        x.rotate(angle * Math.PI / 180);
        x.translate(-cx, -cy);
        x.imageSmoothingQuality = 'high';
        x.drawImage(src, 0, 0);
    });
    live.piece = turned(live.parts.lifted);
    drawParts({ rest: live.parts.rest, lifted: live.piece }, 0, 0);
    if (!live.sel) return;
    const mask = new ImageData(canvas.width, canvas.height);
    live.sel.mask.forEach((m, i) => { mask.data[i * 4 + 3] = m; });
    const a = turned(newCanvas(x => x.putImageData(mask, 0, 0))).getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const hard = live.sel.hard.map((v, i) => (a[i * 4 + 3] > 127 ? 1 : 0));
    sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: live.sel.mask.map((v, i) => a[i * 4 + 3]) } : null;
    drawSelection();
}

$('rotate-angle').addEventListener('input', () => rotateLive(val('rotate-angle')));

window.rotateQuarter = function(dir) {
    endLive();
    rotateLive(dir * 90);
    endLive();
};

// Copy takes the selected area (or the whole icon). Paste puts it on top of the icon as a
// floating piece: it can be dragged and turned without changing what is under it, until it is
// let go (Deselect, a new selection, or any other change).
window.copySelection = function() {
    if (!editing) return;
    endLive();
    clip = liftParts().lifted;
    $('edit-paste').disabled = false;
    $('tool-hint').textContent = 'Copied. Paste (Ctrl+V) puts it on top of the icon, here or in another icon.';
};

window.pasteClip = function() {
    if (!editing || !clip) return;
    endLive();
    pushHistory();
    const rest = copyCanvas();
    // A piece from an icon of another size goes in the middle.
    const piece = newCanvas(x => x.drawImage(clip, (canvas.width - clip.width) / 2, (canvas.height - clip.height) / 2));
    ctx.drawImage(piece, 0, 0);
    const a = piece.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const hard = new Uint8Array(canvas.width * canvas.height).map((v, i) => (a[i * 4 + 3] ? 1 : 0));
    sel = { seeds: [], base: hard.slice(), hard, mask: hard.map(v => v * 255) };
    floating = { rest, piece };
    setTool('move');
    $('tool-hint').textContent = 'Pasted on top of the icon. Drag it into place (or Rotate it): the icon under it stays whole. Deselect (Esc) lets it go where it is; Del takes it away again.';
};

window.centreIcon = function() {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data, w = canvas.width, h = canvas.height;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!d[(y * w + x) * 4 + 3] || (sel && !sel.hard[y * w + x])) continue;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    }
    if (x1 >= 0) nudge(Math.round((w - 1 - x0 - x1) / 2), Math.round((h - 1 - y0 - y1) / 2));
};

function drawCropBox() {
    ctx.putImageData(cropSnap, 0, 0);
    if (!cropBox) return;
    const [x, y, w, h] = cropBox;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#8ab4f8';
    ctx.lineWidth = Math.max(1, canvas.width / 256);
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
}

// Transform: a box with handles around the selection (or the whole icon), like the free transform
// of Photoshop or Krita. Corners scale, sides stretch, the round handles and anything outside the
// box turn, inside moves. Ctrl+corner moves that corner alone (warping), Ctrl+side slants. A side
// or corner dragged past the opposite one mirrors. The icon shows the result as it is dragged, and
// each drag is one undo step.
// xform: { rest, srcImg, maskImg, box: [x0, y0, x1, y1] (pixel edges), quad: the box's corners
// now (top left, top right, bottom right, bottom left), start, startSel, startFloating, floating,
// sel (the selection it last set), out, outImg, drag }.
let xform = null;
const XF_HANDLE = 6;       // a handle's half width on screen, in px
const XF_TURN_AT = 20;     // how far outside its corner a turn handle sits, in px
const XF_PAD = 18;   // how far past the canvas box handles can still be seen and grabbed

const xformLayer = document.createElement('canvas');
xformLayer.className = 'xform-layer';
xformLayer.hidden = true;
$('editor-modal').appendChild(xformLayer);

const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const vMul = (a, k) => [a[0] * k, a[1] * k];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1];
const vCross = (a, b) => a[0] * b[1] - a[1] * b[0];
const cornerAt = (q, i) => q[((i % 4) + 4) % 4];
const centreOf = q => vMul(q.reduce(vAdd, [0, 0]), 0.25);
const rectQuad = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// The box's own width and height directions (their average over both sides of a warped box).
const axisU = q => vMul(vAdd(vSub(q[1], q[0]), vSub(q[2], q[3])), 0.5);
const axisV = q => vMul(vAdd(vSub(q[3], q[0]), vSub(q[2], q[1])), 0.5);

// Where the mouse is on the icon, in canvas pixels, unrounded and not held inside the icon.
function rawPoint(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
}

function toScreen([x, y]) {
    const r = canvas.getBoundingClientRect();
    return [r.left + x * r.width / canvas.width, r.top + y * r.height / canvas.height];
}

// The pixel edges around every pixel the test picks, or null.
function boundsOf(test) {
    const w = canvas.width, n = w * canvas.height;
    let x0 = w, y0 = canvas.height, x1 = -1, y1 = -1;
    for (let i = 0; i < n; i++) {
        if (!test(i)) continue;
        const x = i % w, y = (i - x) / w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

// The map from the unit square onto a four-cornered shape, and back.
function homography(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    let g = 0, h = 0;
    if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
        const den = dx1 * dy2 - dx2 * dy1;
        if (Math.abs(den) < 1e-9) return null;
        g = (dx3 * dy2 - dx2 * dy3) / den;
        h = (dx1 * dy3 - dx3 * dy1) / den;
    }
    return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function invert3([a, b, c, d, e, f, g, h, i]) {
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-9) return null;
    return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
}

// Draws the box of src onto the quad in out. Each pixel is read back from src between its four
// nearest pixels; those outside the box count as clear, so the edges come out smooth.
function warpQuad(src, box, quad, out) {
    const o = out.data;
    o.fill(0);
    const fwd = homography(quad), inv = fwd && invert3(fwd);
    if (!inv) return;
    const s = src.data, sw = src.width, w = out.width, h = out.height;
    const [bx0, by0, bx1, by1] = box, bw = bx1 - bx0, bh = by1 - by0;
    const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
    const X0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), X1 = Math.min(w, Math.ceil(Math.max(...xs)) + 1);
    const Y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), Y1 = Math.min(h, Math.ceil(Math.max(...ys)) + 1);
    const [a, b, c, d, e, f, g, hh, ii] = inv, mu = 1 / bw, mv = 1 / bh;
    for (let y = Y0; y < Y1; y++) {
        const py = y + 0.5;
        for (let x = X0; x < X1; x++) {
            const px = x + 0.5, W = g * px + hh * py + ii;
            const u = (a * px + b * py + c) / W, v = (d * px + e * py + f) / W;
            if (u < -mu || u > 1 + mu || v < -mv || v > 1 + mv || fwd[6] * u + fwd[7] * v + 1 <= 0) continue;
            const sx = bx0 + u * bw - 0.5, sy = by0 + v * bh - 0.5;
            const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
            let r = 0, gr = 0, bl = 0, al = 0;
            for (let t = 0; t < 4; t++) {
                const tx = ix + (t & 1), ty = iy + (t >> 1);
                if (tx < bx0 || tx >= bx1 || ty < by0 || ty >= by1) continue;
                const p = (ty * sw + tx) * 4;
                const aw = s[p + 3] * ((t & 1) ? fx : 1 - fx) * ((t >> 1) ? fy : 1 - fy);
                r += s[p] * aw; gr += s[p + 1] * aw; bl += s[p + 2] * aw; al += aw;
            }
            if (al < 0.5) continue;
            const q = (y * w + x) * 4;
            o[q] = r / al; o[q + 1] = gr / al; o[q + 2] = bl / al; o[q + 3] = al;
        }
    }
}

// Lifts the selection (or the whole icon) into a new box with handles.
function beginXform() {
    endLive();
    const w = canvas.width, h = canvas.height;
    const icon = ctx.getImageData(0, 0, w, h);
    const box = sel ? boundsOf(i => sel.mask[i]) : boundsOf(i => icon.data[i * 4 + 3]);
    const parts = liftParts();
    let maskImg = null;
    if (sel) {
        maskImg = new ImageData(w, h);
        sel.mask.forEach((m, i) => { maskImg.data.fill(255, i * 4, i * 4 + 3); maskImg.data[i * 4 + 3] = m; });
    }
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    xform = {
        rest: parts.rest, srcImg: parts.lifted.getContext('2d').getImageData(0, 0, w, h), maskImg,
        box: box || [0, 0, w, h], start: icon, startSel: sel, startFloating: floating,
        floating: !!floating, sel, out, outImg: new ImageData(w, h), drag: null,
    };
    xform.quad = rectQuad(xform.box);
    showXformValues();
    drawHandles();
}

// The box is out of date when something else changed the selection since.
function xformReady() {
    if (!editing || tool !== 'stretch') return false;
    if (!xform || xform.sel !== sel) beginXform();
    return true;
}

// Puts the icon together again: what was not lifted, with the lifted part drawn onto the quad.
// When done, the selection takes the new shape too.
function renderXform(done) {
    warpQuad(xform.srcImg, xform.box, xform.quad, xform.outImg);
    xform.out.getContext('2d').putImageData(xform.outImg, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (xform.rest) ctx.drawImage(xform.rest, 0, 0);
    ctx.drawImage(xform.out, 0, 0);
    if (done) {
        if (xform.maskImg) {
            const m = new ImageData(canvas.width, canvas.height);
            warpQuad(xform.maskImg, xform.box, xform.quad, m);
            const mask = new Uint8Array(canvas.width * canvas.height).map((v, i) => m.data[i * 4 + 3]);
            const hard = mask.map(v => (v > 127 ? 1 : 0));
            sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask } : null;
        }
        if (xform.floating) floating = { rest: xform.rest, piece: newCanvas(x => x.drawImage(xform.out, 0, 0)) };
        xform.sel = sel;
        drawSelection();
    }
    showXformValues();
    drawHandles();
}

// One undo step; it remembers the box, so undo puts the handles back too.
function xformStep() {
    pushHistory();
    history[history.length - 1].xform = { owner: xform, quad: xform.quad.map(p => p.slice()) };
}

function setQuad(quad) {
    if (!xformReady()) return;
    xformStep();
    xform.quad = quad;
    renderXform(true);
}

// What is under the mouse: a corner, a side, a turn handle, the inside (move) or the outside (turn).
function xformHit(e) {
    const q = xform.quad.map(toScreen), at = [e.clientX, e.clientY], c = centreOf(q);
    const near = (p, r) => Math.hypot(p[0] - at[0], p[1] - at[1]) <= r;
    for (let i = 0; i < 4; i++) if (near(q[i], XF_HANDLE + 3)) return { kind: 'corner', i };
    for (let i = 0; i < 4; i++) if (near(vMul(vAdd(q[i], cornerAt(q, i + 1)), 0.5), XF_HANDLE + 3)) return { kind: 'side', i };
    for (const p of q) if (near(turnHandle(p, c), XF_HANDLE + 3)) return { kind: 'turn' };
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
        if ((q[i][1] > at[1]) !== (q[j][1] > at[1]) && at[0] < (q[j][0] - q[i][0]) * (at[1] - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) inside = !inside;
    }
    return { kind: inside ? 'move' : 'turn' };
}

function turnHandle(p, c) {
    const d = vSub(p, c), len = Math.hypot(d[0], d[1]) || 1;
    return vAdd(p, vMul(d, XF_TURN_AT / len));
}

// The cursor for a handle: a resize arrow that points the way the handle goes from the middle.
function xformCursor(hit, e) {
    if (hit.kind === 'move') return 'move';
    if (hit.kind === 'turn') return xform.drag ? 'grabbing' : 'grab';
    if (e.ctrlKey || e.metaKey) return 'crosshair';
    const q = xform.quad.map(toScreen), c = centreOf(q);
    const p = hit.kind === 'corner' ? q[hit.i] : vMul(vAdd(q[hit.i], cornerAt(q, hit.i + 1)), 0.5);
    const deg = ((Math.atan2(p[1] - c[1], p[0] - c[0]) * 180 / Math.PI) % 180 + 180) % 180;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4];
}

function setCursor(cursor) {
    canvas.style.cursor = cursor;
    $('canvas-container').style.cursor = cursor;
}

// Writes p as a sum of the two directions u and v: [a, b] with p = a u + b v.
function inAxes(p, u, v) {
    const det = vCross(u, v);
    return Math.abs(det) < 1e-9 ? [0, 0] : [vCross(p, v) / det, vCross(u, p) / det];
}

// The quad for the drag so far.
function draggedQuad(d, e) {
    const q0 = d.quad, at = rawPoint(e);
    let by = vSub(at, d.from);
    if (d.kind === 'move') {
        if (e.shiftKey) by = Math.abs(by[0]) > Math.abs(by[1]) ? [by[0], 0] : [0, by[1]];
        return q0.map(p => vAdd(p, by));
    }
    if (d.kind === 'turn') {
        let turn = Math.atan2(at[1] - d.centre[1], at[0] - d.centre[0]) - Math.atan2(d.from[1] - d.centre[1], d.from[0] - d.centre[0]);
        if (e.shiftKey) turn = Math.round(turn / (Math.PI / 12)) * (Math.PI / 12);
        const cos = Math.cos(turn), sin = Math.sin(turn);
        return q0.map(p => {
            const [x, y] = vSub(p, d.centre);
            return vAdd(d.centre, [x * cos - y * sin, x * sin + y * cos]);
        });
    }
    const ctrl = e.ctrlKey || e.metaKey, i = d.i;
    if (d.kind === 'corner') {
        if (ctrl) return q0.map((p, k) => (k === i ? vAdd(p, by) : p.slice()));
        // Scales the box along its own width and height, so it keeps its shape. The anchor is the
        // opposite corner (the middle with Alt); a factor below 0 mirrors.
        const anchor = e.altKey ? d.centre : cornerAt(q0, i + 2), u = axisU(q0), v = axisV(q0);
        const [a0, b0] = inAxes(vSub(q0[i], anchor), u, v);
        const [a1, b1] = inAxes(vSub(vAdd(q0[i], by), anchor), u, v);
        let fa = Math.abs(a0) > 1e-6 ? a1 / a0 : 1, fb = Math.abs(b0) > 1e-6 ? b1 / b0 : 1;
        if (e.shiftKey) {
            const from = vSub(q0[i], anchor);
            fa = fb = vDot(vSub(vAdd(q0[i], by), anchor), from) / (vDot(from, from) || 1);
        }
        return q0.map(p => {
            const [a, b] = inAxes(vSub(p, anchor), u, v);
            return vAdd(anchor, vAdd(vMul(u, a * fa), vMul(v, b * fb)));
        });
    }
    // A side: its two corners, and the two across from them that they pair with.
    const pa = i, pb = (i + 1) % 4, oa = (i + 3) % 4, ob = (i + 2) % 4;
    const q = q0.map(p => p.slice());
    if (ctrl) {
        q[pa] = vAdd(q0[pa], by);
        q[pb] = vAdd(q0[pb], by);
        return q;
    }
    const axis = vSub(vMul(vAdd(q0[pa], q0[pb]), 0.5), vMul(vAdd(q0[oa], q0[ob]), 0.5));
    const t = 1 + (e.altKey ? 2 : 1) * vDot(by, axis) / (vDot(axis, axis) || 1);
    for (const [p, o] of [[pa, oa], [pb, ob]]) {
        if (e.altKey) {
            const m = vMul(vAdd(q0[p], q0[o]), 0.5);
            q[p] = vAdd(m, vMul(vSub(q0[p], m), t));
            q[o] = vAdd(m, vMul(vSub(q0[o], m), t));
        } else {
            q[p] = vAdd(q0[o], vMul(vSub(q0[p], q0[o]), t));
        }
    }
    return q;
}

// The handles go on a xformLayer over the editor, so they can be seen and grabbed past the icon's edge.
function drawHandles() {
    const view = $('canvas-container').getBoundingClientRect();
    if (!xform || !editing || tool !== 'stretch' || !view.width) {
        xformLayer.hidden = true;
        return;
    }
    xformLayer.hidden = false;
    const dpr = window.devicePixelRatio || 1, left = view.left - XF_PAD, top = view.top - XF_PAD;
    const w = view.width + XF_PAD * 2, h = view.height + XF_PAD * 2;
    Object.assign(xformLayer.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
    xformLayer.width = Math.round(w * dpr);
    xformLayer.height = Math.round(h * dpr);
    const x = xformLayer.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr);
    const q = xform.quad.map(toScreen), c = centreOf(q);
    x.beginPath();
    q.forEach((p, i) => (i ? x.lineTo(...p) : x.moveTo(...p)));
    x.closePath();
    x.lineWidth = 3;
    x.strokeStyle = 'rgba(0,0,0,0.7)';
    x.stroke();
    x.lineWidth = 1;
    x.strokeStyle = '#8ab4f8';
    x.stroke();
    const square = p => {
        x.fillStyle = '#fff';
        x.strokeStyle = '#1a73e8';
        x.fillRect(p[0] - XF_HANDLE, p[1] - XF_HANDLE, XF_HANDLE * 2, XF_HANDLE * 2);
        x.strokeRect(p[0] - XF_HANDLE + 0.5, p[1] - XF_HANDLE + 0.5, XF_HANDLE * 2 - 1, XF_HANDLE * 2 - 1);
    };
    for (const p of q) {
        const t = turnHandle(p, c);
        x.beginPath();
        x.moveTo(...p);
        x.lineTo(...t);
        x.strokeStyle = 'rgba(138,180,248,0.6)';
        x.stroke();
        x.beginPath();
        x.arc(t[0], t[1], XF_HANDLE - 1, 0, Math.PI * 2);
        x.fillStyle = '#fbbc04';
        x.fill();
        x.strokeStyle = '#000';
        x.stroke();
    }
    q.forEach(square);
    q.forEach((p, i) => square(vMul(vAdd(p, cornerAt(q, i + 1)), 0.5)));
}

// Width, height and angle of the box, to read or type. A negative height means it is mirrored.
function showXformValues() {
    if (!xform) return;
    const u = axisU(xform.quad), v = axisV(xform.quad), [x0, y0, x1, y1] = xform.box;
    const flip = vCross(u, v) < 0 ? -1 : 1;
    const values = {
        'xf-w': Math.round(Math.hypot(...u) / (x1 - x0) * 1000) / 10,
        'xf-h': flip * Math.round(Math.hypot(...v) / (y1 - y0) * 1000) / 10,
        'xf-angle': Math.round(Math.atan2(u[1], u[0]) * 1800 / Math.PI) / 10,
    };
    for (const id in values) if (document.activeElement !== $(id)) $(id).value = values[id];
}

function typedQuad() {
    const [x0, y0, x1, y1] = xform.box, turn = Number($('xf-angle').value) * Math.PI / 180;
    const cos = Math.cos(turn), sin = Math.sin(turn), c = centreOf(xform.quad);
    const hu = vMul([cos, sin], (x1 - x0) * Number($('xf-w').value) / 200);
    const hv = vMul([-sin, cos], (y1 - y0) * Number($('xf-h').value) / 200);
    return [vSub(vSub(c, hu), hv), vSub(vAdd(c, hu), hv), vAdd(vAdd(c, hu), hv), vAdd(vSub(c, hu), hv)];
}

window.flipXform = function(sideways) {
    if (!xformReady()) return;
    const [a, b, c, d] = xform.quad;
    setQuad(sideways ? [b, a, d, c] : [d, c, b, a]);
};

window.resetXform = function() {
    if (xformReady()) setQuad(rectQuad(xform.box));
};

// Apply bakes the box in and starts a new one around the result.
window.applyXform = function() {
    if (!xformReady()) return;
    xform = null;
    beginXform();
};

const ownStep = h => h && h.xform && h.xform.owner === xform;

// Cancel puts the icon back as it was before the box, and drops the box's undo steps.
window.cancelXform = function() {
    if (!xformReady()) return;
    while (ownStep(history[history.length - 1])) history.pop();
    $('edit-undo').disabled = !history.length;
    ctx.putImageData(xform.start, 0, 0);
    sel = xform.startSel;
    floating = xform.startFloating;
    xform = null;
    drawSelection();
    beginXform();
};

defineTool('stretch', {
    label: '⤡ Transform',
    title: 'Stretch, warp, mirror or turn the selection (or the whole icon) with handles',
    hint: 'Corners scale (Shift keeps the shape, Alt from the middle), sides stretch, Ctrl+corner warps that corner alone, Ctrl+side slants. Drag a side or corner past the opposite one to mirror it. The round handles, or anywhere outside the box, turn it (Shift: 15° steps); inside moves it, and so do the arrow keys. Enter applies, Esc cancels.',
    cursor: 'default',
    keepsSelection: true,
    outside(e) {
        const v = $('canvas-container').getBoundingClientRect();
        return e.clientX >= v.left - XF_PAD && e.clientX < v.right + XF_PAD && e.clientY >= v.top - XF_PAD && e.clientY < v.bottom + XF_PAD;
    },
    enter() {
        beginXform();
        requestAnimationFrame(drawHandles);
    },
    leave() {
        xform = null;
        xformLayer.hidden = true;
        $('canvas-container').style.cursor = '';
    },
    undone(prev) {
        if (ownStep(prev)) {
            xform.quad = prev.xform.quad;
            xform.sel = sel;
            showXformValues();
            drawHandles();
        } else {
            xform = null;
            beginXform();
        }
    },
    down(e) {
        if (!xformReady()) return;
        const hit = xformHit(e);
        xformStep();
        xform.drag = { ...hit, from: rawPoint(e), quad: xform.quad.map(p => p.slice()), centre: centreOf(xform.quad), moved: false };
        overlay.width = overlay.width;
        setCursor(xformCursor(hit, e));
    },
    move(e) {
        if (!editing || tool !== 'stretch' || !xform) return;
        const d = xform.drag;
        if (!d) {
            xformReady();
            return setCursor(xformCursor(xformHit(e), e));
        }
        xform.quad = draggedQuad(d, e);
        d.moved = true;
        renderXform(false);
    },
    up() {
        if (!xform || !xform.drag) return;
        const d = xform.drag;
        xform.drag = null;
        if (!d.moved) {
            history.pop();
            $('edit-undo').disabled = !history.length;
            return drawSelection();
        }
        renderXform(true);
    },
    key(e) {
        if (!xform) return false;
        const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (arrow) {
            const by = vMul(arrow, e.shiftKey ? 10 : 1);
            setQuad(xform.quad.map(p => vAdd(p, by)));
        } else if (e.key === 'Enter') {
            applyXform();
        } else if (e.key === 'Escape' && history.some(ownStep)) {
            cancelXform();
        } else {
            return false;
        }
        e.preventDefault();
        return true;
    },
});

defineOptions('stretch', `
    <label class="hint" title="Width of the box, in % of what it was">Width <input type="number" class="num" id="xf-w" step="1">%</label>
    <label class="hint" title="Height of the box, in % of what it was. Below 0 is mirrored">Height <input type="number" class="num" id="xf-h" step="1">%</label>
    <label class="hint" title="How far the box is turned">Angle <input type="number" class="num" id="xf-angle" step="1">°</label>
    <button title="Mirror left to right" onclick="flipXform(true)">⇋ Flip</button>
    <button title="Mirror top to bottom" onclick="flipXform(false)">⇅ Flip</button>
    <button title="Put the box back as it was" onclick="resetXform()">Reset</button>
    <button title="Keep the change and start a new box around it (Enter)" onclick="applyXform()">Apply</button>
    <button title="Put the icon back as it was before the box (Esc)" onclick="cancelXform()">Cancel</button>`);

['xf-w', 'xf-h', 'xf-angle'].forEach(id => $(id).addEventListener('change', () => {
    if (xformReady() && $(id).value !== '') setQuad(typedQuad());
}));
$('canvas-container').addEventListener('scroll', drawHandles);
$('canvas-container').addEventListener('wheel', drawHandles);
$('edit-zoom').addEventListener('input', drawHandles);
window.addEventListener('resize', drawHandles);
