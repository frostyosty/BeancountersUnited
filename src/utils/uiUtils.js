// src/utils/uiUtils.js
import { useAppStore } from '@/store/appStore.js';

// --- 1. FONTS CONFIGURATION ---
export const AVAILABLE_FONTS = [
    "Roboto", 
    "Open Sans", 
    "Lato", 
    "Montserrat", 
    "Poppins", 
    "Playfair Display", 
    "Merriweather", 
    "Nunito", 
    "Raleway", 
    "Oswald"
];

/**
 * Dynamically loads a Google Font and applies it to the document.
 * @param {string} fontName - The name of the font (e.g., "Open Sans").
 */
export function applySiteFont(fontName) {
    if (!fontName) return;

    // Prevent duplicate loading if already active
    const existingLink = document.getElementById('dynamic-font-link');
    if (existingLink && existingLink.dataset.font === fontName) return;
    if (existingLink) existingLink.remove();

    const link = document.createElement('link');
    link.id = 'dynamic-font-link';
    link.dataset.font = fontName;
    link.rel = 'stylesheet';
    // Load weights 300, 400, 500, 700 for versatility
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@300;400;500;700&display=swap`;
    
    document.head.appendChild(link);

    // Apply to CSS Variable and Body
    document.documentElement.style.setProperty('--font-family-main', `'${fontName}', sans-serif`);
    document.body.style.fontFamily = `'${fontName}', sans-serif`;
}


// --- 2. TOAST NOTIFICATIONS ---
/**
 * Displays a short-lived notification message.
 */
export function showToast(message, type = 'info', overrideDuration = null) {
    // Hook into store settings if available
    let settings = {};
    try {
        settings = useAppStore.getState().siteSettings?.toast || {};
    } catch(e) { /* Ignore store errors during startup */ }

    const duration = overrideDuration || settings.duration || 3000;
    const position = settings.position || 'bottom-right'; // e.g., 'bottom-right', 'top-center'

    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        // Add default styles if not present in CSS
        Object.assign(toastContainer.style, {
            position: 'fixed', zIndex: '9999', pointerEvents: 'none',
            display: 'flex', flexDirection: 'column', gap: '10px'
        });
        document.body.appendChild(toastContainer);
    }
    
    // Apply position logic
    if (position.includes('bottom')) toastContainer.style.bottom = '20px';
    else toastContainer.style.top = '20px';
    
    if (position.includes('right')) { toastContainer.style.right = '20px'; toastContainer.style.alignItems = 'flex-end'; }
    else if (position.includes('left')) { toastContainer.style.left = '20px'; toastContainer.style.alignItems = 'flex-start'; }
    else { toastContainer.style.left = '50%'; toastContainer.style.transform = 'translateX(-50%)'; toastContainer.style.alignItems = 'center'; }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    // Ensure toast is clickable/interactive if needed, but container is pass-through
    toast.style.pointerEvents = 'auto';

    toastContainer.appendChild(toast);

    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after duration
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}


// --- 3. MODAL SYSTEM ---
/**
 * Displays a modal with the provided HTML content.
 */
export function showModal(htmlContent) {
    closeModal(); // Ensure only one modal exists

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'modal-overlay';
    modalOverlay.className = 'modal-overlay';

    modalOverlay.innerHTML = `
        <div class="modal-content">
            <button id="modal-close-btn" class="modal-close-btn">&times;</button>
            <div id="modal-body">${htmlContent}</div>
        </div>
    `;

    document.body.appendChild(modalOverlay);
    document.body.style.overflow = 'hidden'; // Prevent background scrolling

    // Force reflow for animation
    requestAnimationFrame(() => modalOverlay.classList.add('open'));

    // Event Listeners
    const closeBtn = document.getElementById('modal-close-btn');
    closeBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (event) => {
        if (event.target === modalOverlay) closeModal();
    });
}

/**
 * Closes the currently open modal.
 */
export function closeModal() {
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay) {
        modalOverlay.classList.remove('open');
        setTimeout(() => modalOverlay.remove(), 300);
    }
    document.body.style.overflow = 'auto';
}


// --- 4. THEME & BRANDING ---
/**
 * Updates all instances of the site title in the DOM.
 */
export function updateSiteTitles(newName) {
    const siteTitleElement = document.querySelector('#main-header h1');
    const siteTitleFooterElement = document.querySelector('#main-footer p');
    const siteTitleTagElement = document.querySelector('title');

    if (siteTitleElement) siteTitleElement.textContent = newName;
    if (siteTitleFooterElement) siteTitleFooterElement.innerHTML = `&copy; ${new Date().getFullYear()} ${newName}`;
    if (siteTitleTagElement) siteTitleTagElement.textContent = newName;
}

/**
 * Updates a CSS custom property on the :root element.
 */
export function updateCssVariable(varName, value) {
    if (varName && value !== undefined) {
        document.documentElement.style.setProperty(varName, value);
    }
}

/**
 * Generates HTML for theme customization controls (Colors + Font).
 */
export function getThemeControlsHTML(currentVars = {}) {
    // Helper to create color inputs
    const createColorInput = (label, varName) => {
        const currentLiveValue = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        const inputValue = currentVars[varName] || currentLiveValue || '#ffffff';
        return `
            <div class="theme-control-group" style="margin-bottom: 10px;">
                <label for="theme-${varName}" style="display:block; font-size:0.9rem; margin-bottom:5px;">${label}</label>
                <input type="color" id="theme-${varName}" data-css-var="${varName}" value="${inputValue}" style="width:100%; height:40px; cursor:pointer;">
            </div>
        `;
    };

    // Font Dropdown Logic
    const currentFont = currentVars['--font-family-main-name'] || 'Roboto';
    const fontOptions = AVAILABLE_FONTS.map(font => 
        `<option value="${font}" ${font === currentFont ? 'selected' : ''}>${font}</option>`
    ).join('');

    return `
        <div class="theme-controls-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
            <!-- Font Selector -->
            <div class="theme-control-group" style="grid-column: 1 / -1;">
                <label style="display:block; font-weight:bold; margin-bottom:5px;">Website Font</label>
                <select id="font-selector" style="width:100%; padding:10px; border-radius:6px; border:1px solid #ccc; font-size:1rem;">
                    ${fontOptions}
                </select>
            </div>

            ${createColorInput('Primary Color', '--primary-color')}
            ${createColorInput('Secondary Color', '--secondary-color')}
            ${createColorInput('Background Color', '--background-color')}
            ${createColorInput('Surface Color', '--surface-color')}
            ${createColorInput('Text Color', '--text-color')}
            ${createColorInput('Border Color', '--border-color')}
        </div>
        
        <div style="margin-top: 20px; text-align: right;">
            <button type="button" id="save-theme-settings" class="button-primary">Save Theme Settings</button>
        </div>
    `;
}


// --- 5. LOADING SPINNER UTILS ---

export function hideInitialLoader() {
    const loader = document.querySelector('.initial-app-loader');
    if (!loader) return;
    loader.style.transition = 'opacity 0.5s ease';
    loader.style.opacity = '0';
    setTimeout(() => loader.remove(), 500);
}

/**
 * Updates the color of the dynamic spinner (if used globally).
 */
export function updateSpinnerColor(newColor) {
    // Assuming the spinner uses 'currentColor' or a specific var
    const spinner = document.querySelector('.dynamic-coffee-spinner');
    if (spinner && newColor) {
        spinner.style.color = newColor; 
    }
}