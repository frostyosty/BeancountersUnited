// 1. ZOOM EFFECT
// Scales the old image out and the new image in
export function drawZoom(ctx, imgOld, imgNew, w, h, progress, intensity) {
    // Intensity 0-1 determines how much it zooms
    const scale = 1 + (0.5 * intensity); // Max 1.5x zoom
    
    // Ease In-Out
    const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    
    // Fade Logic
    ctx.globalAlpha = 1;
    
    // Draw Old (Fading Out & Zooming In)
    if (progress < 1) {
        const currentScale = 1 + (ease * (scale - 1));
        const dw = w * currentScale;
        const dh = h * currentScale;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;
        
        ctx.globalAlpha = 1 - ease;
        ctx.drawImage(imgOld, dx, dy, dw, dh);
    }

    // Draw New (Fading In & Zooming Out from large)
    if (progress > 0) {
        const currentScale = scale - (ease * (scale - 1));
        const dw = w * currentScale;
        const dh = h * currentScale;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;

        ctx.globalAlpha = ease;
        ctx.drawImage(imgNew, dx, dy, dw, dh);
    }
}

// 2. PIXELATE EFFECT
// Renders the image in blocks that get large then small
export function drawPixelate(ctx, imgOld, imgNew, w, h, progress, intensity) {
    // Intensity defines max block size (e.g., 20px)
    const maxBlockSize = 2 + (50 * intensity);
    
    // Triangle wave for block size (Start 0 -> Max at 50% -> End 0)
    const wave = 1 - Math.abs((progress - 0.5) * 2);
    const blockSize = Math.max(1, Math.floor(maxBlockSize * wave));
    
    if (blockSize === 1) {
        // Just draw normal crossfade if blocks are tiny
        ctx.globalAlpha = 1 - progress;
        ctx.drawImage(imgOld, 0, 0, w, h);
        ctx.globalAlpha = progress;
        ctx.drawImage(imgNew, 0, 0, w, h);
        return;
    }

    // Turn off smoothing for crisp pixels
    ctx.imageSmoothingEnabled = false;

    // Draw Old (Pixelated)
    const wScaled = Math.ceil(w / blockSize);
    const hScaled = Math.ceil(h / blockSize);

    // Use an offscreen canvas to downscale then upscale
    const offCanvas = document.createElement('canvas');
    offCanvas.width = wScaled;
    offCanvas.height = hScaled;
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(progress < 0.5 ? imgOld : imgNew, 0, 0, wScaled, hScaled);

    ctx.globalAlpha = 1;
    ctx.drawImage(offCanvas, 0, 0, wScaled, hScaled, 0, 0, w, h);
}

// 3. WIPE/SLIDE EFFECT
// Slides the new image over the old one
export function drawSlide(ctx, imgOld, imgNew, w, h, progress, intensity) {
    const ease = progress * (2 - progress); // Ease out
    
    // Draw Old
    ctx.globalAlpha = 1;
    ctx.drawImage(imgOld, 0, 0, w, h);

    // Draw New sliding in from bottom
    const yOffset = h * (1 - ease);
    ctx.drawImage(imgNew, 0, yOffset, w, h);
    
    // Draw scanline?
    if (intensity > 0.5) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillRect(0, yOffset, w, 2);
    }
}