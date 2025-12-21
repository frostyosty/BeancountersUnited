export class ImageWarper {
    constructor() {
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.zIndex = '9999';
        this.canvas.style.transition = 'opacity 0.2s';
    }

    async captureElementToData(element, w, h) {
        const xml = new XMLSerializer().serializeToString(element);
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
                <foreignObject width="100%" height="100%">
                    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:sans-serif; color:${getComputedStyle(element).color}">
                        ${xml}
                    </div>
                </foreignObject>
            </svg>
        `;
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await new Promise(r => img.onload = r);
        this.ctx.clearRect(0, 0, w, h);
        this.ctx.drawImage(img, 0, 0, w, h);
        return this.ctx.getImageData(0, 0, w, h);
    }

    async warp(imgElement, newSrc) {
        if (!imgElement || imgElement.src === newSrc) return;
        const rect = imgElement.getBoundingClientRect();
        if (rect.width === 0) return;

        this.setupCanvas(rect);

        // Draw Old
        try { this.ctx.drawImage(imgElement, 0, 0, rect.width, rect.height); } 
        catch(e) { this.ctx.fillStyle = '#eee'; this.ctx.fillRect(0,0, rect.width, rect.height); }
        const oldData = this.ctx.getImageData(0, 0, rect.width, rect.height);

        // Draw New
        const imgNew = await this.loadImage(newSrc);
        if (!imgNew) { this.canvas.remove(); return; }

        const offCanvas = document.createElement('canvas');
        offCanvas.width = rect.width; offCanvas.height = rect.height;
        const offCtx = offCanvas.getContext('2d');
        offCtx.drawImage(imgNew, 0, 0, rect.width, rect.height);
        const newData = offCtx.getImageData(0, 0, rect.width, rect.height);

        imgElement.src = newSrc;
        await this.animatePixels(oldData.data, newData.data, rect.width, rect.height);
        this.cleanup();
    }

    async warpElement(domElement, newHTML, isImageSource = false) {
        if (!domElement) return;
        const rect = domElement.getBoundingClientRect();
        if (rect.width === 0) return;

        this.setupCanvas(rect);
        const oldData = await this.captureElementToData(domElement, rect.width, rect.height);

        if (isImageSource) domElement.src = newHTML;
        else domElement.innerHTML = newHTML;

        await new Promise(r => requestAnimationFrame(r));
        const newData = await this.captureElementToData(domElement, rect.width, rect.height);

        await this.animatePixels(oldData.data, newData.data, rect.width, rect.height);
        this.cleanup();
    }

    setupCanvas(rect) {
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.canvas.style.top = `${rect.top + window.scrollY}px`;
        this.canvas.style.left = `${rect.left + window.scrollX}px`;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        this.canvas.style.opacity = '1';
        document.body.appendChild(this.canvas);
    }

    cleanup() {
        this.canvas.style.opacity = '0';
        setTimeout(() => this.canvas.remove(), 200);
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

    animatePixels(oldPixels, newPixels, w, h) {
        return new Promise(resolve => {
            let progress = 0;
            const duration = 45; 
            const blockSize = 2; 
            const output = this.ctx.createImageData(w, h);
            
            const renderFrame = () => {
                progress++;
                const ratio = progress / duration;
                const ease = 1 - Math.pow(1 - ratio, 3); 

                for (let y = 0; y < h; y += blockSize) {
                    for (let x = 0; x < w; x += blockSize) {
                        const i = (y * w + x) * 4;
                        const noise = (Math.sin(x * 0.05) + Math.cos(y * 0.05)); 
                        const threshold = (noise + 2) / 4; 

                        let r, g, b, a;
                        if (ease > threshold) {
                            r = newPixels[i]; g = newPixels[i+1]; b = newPixels[i+2]; a = newPixels[i+3];
                        } else {
                            r = oldPixels[i]; g = oldPixels[i+1]; b = oldPixels[i+2]; a = oldPixels[i+3];
                        }

                        for (let by = 0; by < blockSize && y + by < h; by++) {
                            for (let bx = 0; bx < blockSize && x + bx < w; bx++) {
                                const bi = ((y + by) * w + (x + bx)) * 4;
                                output.data[bi] = r; output.data[bi+1] = g; output.data[bi+2] = b; output.data[bi+3] = a;
                            }
                        }
                    }
                }
                this.ctx.putImageData(output, 0, 0);
                if (progress < duration) requestAnimationFrame(renderFrame);
                else resolve();
            };
            requestAnimationFrame(renderFrame);
        });
    }
}

export const warper = new ImageWarper();
export function smoothUpdateImage(imgId, newSrc) {
    const img = document.getElementById(imgId) || document.querySelector(`img[data-item-id="${imgId}"]`);
    if (img) warper.warp(img, newSrc);
}