// ui.js
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
const closeModalButton = document.querySelector('.close-button');
const appContent = document.getElementById('app-content');
const loadingSpinner = document.getElementById('loading-spinner');

const ui = {
    showModal: (content) => {
        modalBody.innerHTML = content;
        modal.style.display = 'block';
    },
    closeModal: () => {
        modal.style.display = 'none';
        modalBody.innerHTML = '';
    },
    renderPage: (htmlContent) => {
        appContent.innerHTML = htmlContent;
    },
    setLoading: (isLoading) => {
        if (isLoading) {
            appContent.innerHTML = ''; // Clear content
            loadingSpinner.style.display = 'block';
        } else {
            loadingSpinner.style.display = 'none';
        }
    },
    updateCartCount: (count) => {
        document.getElementById('cart-count').textContent = count;
    },
    updateSiteTitles: (newName) => {
        document.getElementById('site-title').textContent = newName;
        document.getElementById('site-title-footer').textContent = newName;
        document.title = newName;
    },
    applyTheme: (themeCssFile) => {
        document.getElementById('theme-stylesheet').href = themeCssFile;
    },
    getThemeControlsHTML: (currentSettings) => {
        // currentSettings expected to be like { primaryColor: '#hex', bgColor: '#hex', ... }
        // This is a simplified example. A real theme editor would be more complex.
        let html = '<h3>Theme Customizer (CSS Variables)</h3>';
        const editableVars = [
            { name: 'Primary Color', var: '--primary-color', type: 'color' },
            { name: 'Background Color', var: '--bg-color', type: 'color' },
            { name: 'Text Color', var: '--text-color', type: 'color' },
            { name: 'Accent Color', var: '--accent-color', type: 'color' },
        ];

        editableVars.forEach(item => {
            // Get current computed value for the variable to set as default in color picker
            const currentVal = getComputedStyle(document.documentElement).getPropertyValue(item.var).trim();
            html += `
                <div>
                    <label for="theme-${item.var}">${item.name}:</label>
                    <input type="${item.type}" id="theme-${item.var}" data-css-var="${item.var}" value="${currentSettings?.[item.var.substring(2)] || currentVal}">
                </div>
            `;
        });
        html += '<button id="save-theme-settings">Save Theme Settings</button>';
        html += '<p><em>Note: Theme settings are applied live. Save persists them.</em></p>';
        return html;
    },
    updateCssVariable: (varName, value) => {
        document.documentElement.style.setProperty(varName, value);
    }
};

closeModalButton?.addEventListener('click', ui.closeModal);
window.addEventListener('click', (event) => {
    if (event.target === modal) {
        ui.closeModal();
    }
});



export function generateTextFaviconDataUrl(text = 'R', bgColor = '#3498db', textColor = '#ffffff', size = 32) {
    const firstChar = text.substring(0, 1).toUpperCase();
    const secondChar = text.length > 1 ? text.substring(1, 2).toUpperCase() : '';

    // Adjust font size and positioning based on number of chars
    let fontSize = size * 0.6;
    let yPos = size * 0.65;
    let xPos = size * 0.5;

    if (secondChar) { // Two characters
        fontSize = size * 0.45;
        yPos = size * 0.62;
    }

    const svgContent = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
            <rect width="${size}" height="${size}" fill="${bgColor}"/>
            <text x="${xPos}" y="${yPos}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">
                ${firstChar}${secondChar}
            </text>
        </svg>
    `.trim();
    return `data:image/svg+xml;base64,${btoa(svgContent)}`;
}

/**
 * Updates the website's favicon.
 * @param {string} href - The URL or data URL of the new favicon.
 * @param {string} type - The MIME type (e.g., 'image/svg+xml', 'image/png').
 */
export function updateLiveFavicon(href, type = 'image/svg+xml') {
    let link = document.getElementById('dynamic-favicon');
    if (!link) {
        link = document.createElement('link');
        link.id = 'dynamic-favicon';
        link.rel = 'icon';
        document.head.appendChild(link); // Append if somehow missing
    }
    link.type = type;
    link.href = href;
}

// Function to update the preview image in the admin panel
// This could also be used to update the actual site favicon for live preview
export function updateFaviconPreview(settings) { // settings: { type, text, bgColor, textColor, url }
    const previewImg = document.getElementById('favicon-preview-img');
    if (!previewImg) return;

    if (settings && settings.type === 'text') {
        const dataUrl = generateTextFaviconDataUrl(settings.text, settings.bgColor, settings.textColor);
        previewImg.src = dataUrl;
        previewImg.style.backgroundColor = ''; // Text favicons have own bg
    } else if (settings && settings.type === 'image' && settings.url) {
        previewImg.src = settings.url;
        previewImg.style.backgroundColor = ''; // Clear background for image
    } else { // Default or other
        previewImg.src = '/default-favicon.svg'; // Path to your default SVG
        previewImg.style.backgroundColor = '';
    }
    // Optionally update live site favicon here too for owner to see
    // updateLiveFavicon(previewImg.src, previewImg.src.startsWith('data:image/svg+xml') ? 'image/svg+xml' : 'image/png');
}



// Make ui globally accessible or export as a module
window.ui = ui;
