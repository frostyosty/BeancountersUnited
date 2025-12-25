export function createOverlayCanvas(rect) {
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.position = 'absolute';
    canvas.style.top = `${rect.top + window.scrollY}px`;
    canvas.style.left = `${rect.left + window.scrollX}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';
    canvas.style.transition = 'opacity 0.2s';
    document.body.appendChild(canvas);
    return canvas;
}

export function loadImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = src;
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
    });
}

export async function captureElementAsImage(element) {
    const rect = element.getBoundingClientRect();
    const xml = new XMLSerializer().serializeToString(element);
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">
            <foreignObject width="100%" height="100%">
                <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:sans-serif; color:${getComputedStyle(element).color}">
                    ${xml}
                </div>
            </foreignObject>
        </svg>`;
    return await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
}