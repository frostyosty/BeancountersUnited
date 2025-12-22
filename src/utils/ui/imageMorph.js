// src/utils/ui/imageMorph.js

export class ImageWarper {
    constructor() {
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d'); // Removed 'willReadFrequently' as we use drawImage now
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.zIndex = '9999';
    }

    async warp(imgElement, newSrc, options = {}) {
        if (!imgElement || imgElement.src === newSrc) return;

        const rect = imgElement.getBoundingClientRect();
        if (rect.width === 0) return;

        // 1. Setup Canvas
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.canvas.style.top = `${rect.top + window.scrollY}px`;
        this.canvas.style.left = `${rect.left + window.scrollX}px`;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        this.canvas.style.opacity = '1';
        
        document.body.appendChild(this.canvas);

        // 2. Load Images
        const imgOld = await this.loadImage(imgElement.src);
        const imgNew = await this.loadImage(newSrc);
        
        if (!imgNew) { this.canvas.remove(); return; }

        // 3. Swap DOM immediately (Hidden behind canvas)
        imgElement.src = newSrc;
        imgElement.style.opacity = '0';

        // 4. Animate (Morph)
        await this.animateMorph(imgOld, imgNew, rect.width, rect.height, options.duration || 45);

        // 5. Cleanup
        imgElement.style.opacity = '1';
        this.canvas.remove();
    }

    // Helper for Text/HTML elements
    async warpElement(domElement, newHTML) {
        if (!domElement) return;
        const rect = domElement.getBoundingClientRect();
        
        // Snapshot Old
        const oldImg = await this.captureElement(domElement, rect.width, rect.height);
        
        // Update DOM
        domElement.innerHTML = newHTML;
        
        // Snapshot New
        // Wait a tick for rendering
        await new Promise(r => requestAnimationFrame(r));
        const newImg = await this.captureElement(domElement, rect.width, rect.height);
        
        this.setupCanvas(rect); // Re-use setup logic if extracted, or inline here
        
        // (Simplified canvas setup for brevity, assuming standard setup)
        this.canvas.width = rect.width; this.canvas.height = rect.height;
        this.canvas.style.top = `${rect.top + window.scrollY}px`;
        this.canvas.style.left = `${rect.left + window.scrollX}px`;
        document.body.appendChild(this.canvas);

        await this.animateMorph(oldImg, newImg, rect.width, rect.height, 45);
        this.canvas.remove();
    }

    loadImage(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.src = src;
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
        });
    }

    async captureElement(el, w, h) {
        const xml = new XMLSerializer().serializeToString(el);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:sans-serif;color:${getComputedStyle(el).color}">${xml}</div></foreignObject></svg>`;
        return this.loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    }

    animateMorph(imgOld, imgNew, w, h, duration) {
        return new Promise(resolve => {
            let frame = 0;
            
            const render = () => {
                frame++;
                const progress = frame / duration;
                const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2; // Ease InOut

                this.ctx.clearRect(0, 0, w, h);

                // Draw Old (Shrinking & Fading Out)
                // Scale goes 1.0 -> 0.8
                if (imgOld) {
                    const scaleOld = 1 - (ease * 0.2); 
                    const wOld = w * scaleOld;
                    const hOld = h * scaleOld;
                    const xOld = (w - wOld) / 2;
                    const yOld = (h - hOld) / 2;
                    
                    this.ctx.globalAlpha = 1 - ease;
                    this.ctx.drawImage(imgOld, xOld, yOld, wOld, hOld);
                }

                // Draw New (Growing & Fading In)
                // Scale goes 0.8 -> 1.0
                if (imgNew) {
                    const scaleNew = 0.8 + (ease * 0.2);
                    const wNew = w * scaleNew;
                    const hNew = h * scaleNew;
                    const xNew = (w - wNew) / 2;
                    const yNew = (h - hNew) / 2;

                    this.ctx.globalAlpha = ease;
                    this.ctx.drawImage(imgNew, xNew, yNew, wNew, hNew);
                }

                if (frame < duration) {
                    requestAnimationFrame(render);
                } else {
                    resolve();
                }
            };
            requestAnimationFrame(render);
        });
    }
}

export const warper = new ImageWarper();