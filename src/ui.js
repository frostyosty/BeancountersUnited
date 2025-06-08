// src/ui.js

// --- Modal Management ---
const modalElement = document.getElementById('modal');
const modalBodyElement = document.getElementById('modal-body');
const closeModalButton = document.querySelector('#modal .close-button'); // More specific selector

/**
 * Shows the modal with the provided HTML content.
 * @param {string} htmlContent - HTML string to inject into the modal body.
 */
export function showModal(htmlContent) {
    if (modalElement && modalBodyElement) {
        modalBodyElement.innerHTML = htmlContent;
        modalElement.style.display = 'block';
    } else {
        console.error("Modal elements not found for showModal. Cannot display modal.");
        // Fallback or further error indication might be needed if critical
    }
}

/**
 * Hides the modal.
 */
export function closeModal() {
    if (modalElement) {
        modalElement.style.display = 'none';
        if (modalBodyElement) modalBodyElement.innerHTML = ''; // Clear content
    }
}

// Attach listeners for modal closing (only once)
if (closeModalButton) {
    closeModalButton.addEventListener('click', closeModal);
}
window.addEventListener('click', (event) => { // Click outside modal
    if (event.target === modalElement) {
        closeModal();
    }
});

// --- Page Content & Loading State ---
const appContentElement = document.getElementById('app-content');
const loadingSpinnerElement = document.getElementById('loading-spinner');

/**
 * Renders HTML content into the main application area.
 * @param {string} htmlContent - HTML string to render.
 */
export function renderPage(htmlContent) {
    if (appContentElement) {
        appContentElement.innerHTML = htmlContent;
    } else {
        console.error("App content element (#app-content) not found.");
    }
}

/**
 * Shows or hides the loading spinner and clears/shows app content.
 * @param {boolean} isLoading - True to show loading, false to hide.
 */
export function setLoading(isLoading) {
    if (loadingSpinnerElement && appContentElement) {
        if (isLoading) {
            appContentElement.innerHTML = ''; // Clear previous content
            loadingSpinnerElement.style.display = 'block';
        } else {
            loadingSpinnerElement.style.display = 'none';
        }
    } else {
        console.warn("Loading spinner or app content element not found for setLoading.");
    }
}

// --- Cart UI ---
const cartCountElement = document.getElementById('cart-count');

/**
 * Updates the cart item count display in the header.
 * @param {number} count - The number of items in the cart.
 */
export function updateCartCount(count) { // <<<< Ensure 'export' keyword is present
    const cartCountElement = document.getElementById('cart-count'); // Make sure this element exists in index.html
    if (cartCountElement) {
        cartCountElement.textContent = count;
    } else {
        console.warn("Cart count element (#cart-count) not found in ui.js");
    }
}

// --- Site Branding & Theming ---
const siteTitleElement = document.getElementById('site-title');
const siteTitleFooterElement = document.getElementById('site-title-footer');
const siteTitleTagElement = document.getElementById('site-title-tag'); // The <title> tag in <head>
const themeStylesheetElement = document.getElementById('theme-stylesheet');

/**
 * Updates all instances of the site title.
 * @param {string} newName - The new website name.
 */
export function updateSiteTitles(newName) {
    if (siteTitleElement) siteTitleElement.textContent = newName;
    if (siteTitleFooterElement) siteTitleFooterElement.textContent = newName;
    if (siteTitleTagElement) siteTitleTagElement.textContent = newName; // Updates browser tab title
    else if (document.title !== undefined) document.title = newName; // Fallback to document.title
}

/**
 * Applies a theme by changing the linked CSS stylesheet (legacy theming approach).
 * @param {string} themeCssFile - Path to the new theme CSS file.
 */
export function applyTheme(themeCssFile) {
    if (themeStylesheetElement && themeCssFile) {
        themeStylesheetElement.href = themeCssFile;
    } else if (themeCssFile) { // If stylesheet element doesn't exist, maybe it wasn't needed with CSS vars
        console.warn("Theme stylesheet element not found, but a theme CSS file was provided.");
    }
}

/**
 * Updates a CSS custom property (variable) on the :root element.
 * @param {string} varName - The CSS variable name (e.g., '--primary-color').
 * @param {string} value - The new value for the CSS variable.
 */
export function updateCssVariable(varName, value) {
    if (varName && value !== undefined) {
        document.documentElement.style.setProperty(varName, value);
    }
}

/**
 * Generates HTML for theme customization controls (CSS variable sliders/pickers).
 * Called by admin.js to render manager dashboard UI.
 * @param {object} [currentThemeSettings={}] - Current theme variables (e.g., { '--primary-color': '#hex', ... }).
 * @returns {string} - HTML string for theme controls.
 */
export function getThemeControlsHTML(currentThemeSettings = {}) {
    let html = '<h3>Theme Customizer (Live CSS Variables)</h3>';
    const editableVars = [
        // Name: Label for UI, var: actual CSS var name, type: input type
        { name: 'Primary Color', varName: '--primary-color', type: 'color' },
        { name: 'Secondary Color', varName: '--secondary-color', type: 'color' },
        { name: 'Accent Color', varName: '--accent-color', type: 'color' },
        { name: 'Background Color', varName: '--bg-color', type: 'color' },
        { name: 'Text Color', varName: '--text-color', type: 'color' },
        { name: 'Header Text Color', varName: '--header-text-color', type: 'color' },
        // Add more theme variables here as needed
    ];

    editableVars.forEach(item => {
        // Get current computed value for the variable if not overridden by settings
        const currentLiveValue = getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();
        // Use stored setting if available, otherwise use live computed value
        const inputValue = currentThemeSettings[item.varName] !== undefined ? currentThemeSettings[item.varName] : currentLiveValue;

        html += `
            <div style="margin-bottom: 0.5em;">
                <label for="theme-${item.varName}" style="display:inline-block; width:150px;">${item.name}:</label>
                <input type="${item.type}" id="theme-${item.varName}" data-css-var="${item.varName}" value="${inputValue}" style="vertical-align:middle;">
                <span style="font-size:0.8em; margin-left:5px;">(${item.varName})</span>
            </div>
        `;
    });
    html += '<button id="save-theme-settings" style="margin-top:1em; padding:0.5em 1em;">Save Theme Settings to Database</button>';
    html += '<p style="font-size:0.9em;"><em>Note: Changes apply live. "Save" persists them for all users.</em></p>';
    return html;
}

// --- Favicon Management ---
const dynamicFaviconElement = document.getElementById('dynamic-favicon');

/**
 * Generates an SVG data URL for a text-based favicon.
 * @param {string} [text='R'] - The text for the favicon (1-2 chars recommended).
 * @param {string} [bgColor='#3498db'] - Background color (hex).
 * @param {string} [textColor='#ffffff'] - Text color (hex).
 * @param {number} [size=32] - Size of the favicon.
 * @returns {string} - SVG data URL.
 */
export function generateTextFaviconDataUrl(text = 'R', bgColor = '#3498db', textColor = '#ffffff', size = 32) {
    const char1 = text.substring(0, 1).toUpperCase();
    const char2 = text.length > 1 ? text.substring(1, 2).toUpperCase() : '';

    let fontSize = size * (char2 ? 0.45 : 0.6);
    let yPos = size * (char2 ? 0.62 : 0.65);
    let textContent = char1 + char2;

    // A very simple attempt to slightly adjust for wide vs narrow characters for single char.
    // This is not foolproof. A better way involves measuring text width in canvas.
    if (!char2 && 'MW'.includes(char1)) { // Wide characters
        fontSize *= 0.85;
    } else if (!char2 && 'ILJ'.includes(char1)) { // Narrow characters
        fontSize *= 1.1;
    }


    const svgContent = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
            <rect width="${size}" height="${size}" fill="${bgColor}"/>
            <text x="${size * 0.5}" y="${yPos}" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">
                ${textContent}
            </text>
        </svg>
    `.trim().replace(/\s+/g, ' '); // Minify SVG string slightly
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgContent)))}`; // Ensure proper UTF-8 handling for btoa
}

/**
 * Updates the website's live favicon in the browser tab.
 * @param {string} href - The URL or data URL of the new favicon.
 * @param {string} [type='image/svg+xml'] - The MIME type of the favicon.
 */
export function updateLiveFavicon(href, type = 'image/svg+xml') {
    if (!dynamicFaviconElement) {
        console.error("Dynamic favicon link element not found. Cannot update favicon.");
        // Attempt to create it if missing, though it should be in index.html
        let link = document.createElement('link');
        link.id = 'dynamic-favicon';
        link.rel = 'icon';
        document.head.appendChild(link);
        // Retry setting on newly created link: (less ideal, implies HTML structure issue)
        // dynamicFaviconElement = document.getElementById('dynamic-favicon');
        // if(dynamicFaviconElement) {
        // dynamicFaviconElement.type = type;
        // dynamicFaviconElement.href = href;
        // }
        return;
    }
    dynamicFaviconElement.type = type;
    dynamicFaviconElement.href = href;
}


/**
 * Updates the favicon preview image in an admin panel.
 * @param {object} settings - Favicon configuration: { type, text, bgColor, textColor, url }
 */
export function updateFaviconPreview(settings) {
    const previewImgElement = document.getElementById('favicon-preview-img'); // Assumes this ID exists in admin UI
    if (!previewImgElement) {
        // console.warn("Favicon preview image element not found.");
        return;
    }

    if (settings && settings.type === 'text') {
        const dataUrl = generateTextFaviconDataUrl(settings.text, settings.bgColor, settings.textColor);
        previewImgElement.src = dataUrl;
    } else if (settings && settings.type === 'image' && settings.url) {
        previewImgElement.src = settings.url; // URL to the uploaded image
    } else { // Default or other/unknown types
        previewImgElement.src = '/default-favicon.svg'; // Ensure default-favicon.svg is in Vite's public dir
    }
}