import { createOverlayCanvas, loadImage, captureElementAsImage } from './helpers.js';
import * as Effects from '../effects.js';

export class ImageWarper {
    constructor() {
        this.canvas = null;
        this.ctx = null;
    }

    async warp(imgElement, newSrc, config = {}) {
        if (!imgElement || imgElement.src === newSrc) return;

        const rect = imgElement.getBoundingClientRect();
        if (rect.width === 0) return;

        // 1. Setup
        this.canvas = createOverlayCanvas(rect);
        this.ctx = this.canvas.getContext('2d');

        // 2. Capture States
        // Try drawing existing image, fallback to capture if it's complex HTML
        let imgOld;
        try {
            imgOld = await captureElementAsImage(imgElement);
        } catch {
            imgOld = await loadImage(imgElement.src);
        }

        const imgNew = await loadImage(newSrc);
        if (!imgNew) { this.canvas.remove(); return; }

        // 3. Hide DOM
        imgElement.style.opacity = '0';
        imgElement.src = newSrc;

        // 4. Animate
        await this.runAnimation(imgOld, imgNew, rect.width, rect.height, config);

        // 5. Cleanup
        imgElement.style.opacity = '1';
        this.canvas.remove();
    }

    async warpElement(domElement, newHTML, config = {}) {
        // Similar to warp but handles innerHTML replacement
        const rect = domElement.getBoundingClientRect();
        if (rect.width === 0) return;

        this.canvas = createOverlayCanvas(rect);
        this.ctx = this.canvas.getContext('2d');

        const imgOld = await captureElementAsImage(domElement);
        domElement.innerHTML = newHTML;
        
        // Wait for render
        await new Promise(r => requestAnimationFrame(r));
        const imgNew = await captureElementAsImage(domElement);

        await this.runAnimation(imgOld, imgNew, rect.width, rect.height, config);
        
        this.canvas.remove();
    }

    runAnimation(imgOld, imgNew, w, h, config) {
        return new Promise(resolve => {
            let frame = 0;
            const duration = config.duration || 45;
            
            // Get effect strengths (0 to 1)
            const zoomStr = (config.effectZoom || 0) / 100;
            const pixelStr = (config.effectPixel || 0) / 100;
            const slideStr = (config.effectSlide || 0) / 100;

            // Decide primary effect based on highest value
            // (Blending all 3 simultaneously is computationally very heavy and messy)
            let mode = 'zoom';
            if (pixelStr > zoomStr && pixelStr > slideStr) mode = 'pixel';
            if (slideStr > zoomStr && slideStr > pixelStr) mode = 'slide';

            const render = () => {
                frame++;
                const progress = frame / duration;
                
                this.ctx.clearRect(0, 0, w, h);
                this.ctx.imageSmoothingEnabled = true; // Reset

                if (mode === 'pixel') {
                    Effects.drawPixelate(this.ctx, imgOld, imgNew, w, h, progress, pixelStr);
                } else if (mode === 'slide') {
                    Effects.drawSlide(this.ctx, imgOld, imgNew, w, h, progress, slideStr);
                } else {
                    // Default to Zoom/Fade
                    Effects.drawZoom(this.ctx, imgOld, imgNew, w, h, progress, zoomStr || 0.5);
                }

                if (frame < duration) requestAnimationFrame(render);
                else resolve();
            };
            requestAnimationFrame(render);
        });
    }
}