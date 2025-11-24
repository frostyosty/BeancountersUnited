// src/utils/uiUtils.js
import { useAppStore } from '@/store/appStore.js';

// --- SPINNER ASSETS ---
const SPINNER_SVGS = {
    coffee: `
        <svg class="dynamic-coffee-spinner" viewBox="0 0 100 100">
            <path d="M22 40 H 78 L 72 80 Q 50 90 28 80 Z" fill="transparent" stroke="currentColor" stroke-width="6" />
            <path d="M78 50 C 92 50, 92 70, 78 70" fill="transparent" stroke="currentColor" stroke-width="6" />
            <path class="mini-steam" d="M40 35 L 42 25" fill="none" stroke="currentColor" stroke-width="4" />
            <path class="mini-steam" d="M50 35 L 48 25" fill="none" stroke="currentColor" stroke-width="4" />
            <path class="mini-steam" d="M60 35 L 62 25" fill="none" stroke="currentColor" stroke-width="4" />
        </svg>
    `,
    hammer: `
        <svg class="dynamic-hammer-spinner" viewBox="0 0 100 100">
            <g class="nail-body">
                <rect x="48" y="55" width="4" height="25" fill="currentColor" />
                <rect x="44" y="55" width="12" height="4" fill="currentColor" />
            </g>
            <g class="hammer-body">
                <rect x="60" y="30" width="8" height="50" fill="currentColor" transform="rotate(-20 64 55)" />
                <path d="M45 20 H 85 V 35 H 45 Z" fill="currentColor" transform="rotate(-20 64 55)" />
            </g>
        </svg>
    `
};

// --- 1. FONTS & BRANDING CONFIG ---
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
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@300;400;500;700&display=swap`;
    
    document.head.appendChild(link);

    // Apply to CSS Variable and Body
    document.documentElement.style.setProperty('--font-family-main', `'${fontName}', sans-serif`);
    document.body.style.fontFamily = `'${fontName}', sans-serif`;
}

/**
 * Sets the active spinner type (Coffee or Hammer).
 * Saves to LocalStorage so it persists instantly on reload.
 */
export function setGlobalSpinner(type) {
    const validTypes = ['coffee', 'hammer'];
    const selectedType = validTypes.includes(type) ? type : 'coffee';
    
    // 1. Save for next boot
    localStorage.setItem('site_spinner_type', selectedType);

    // 2. Update DOM immediately if loader is visible
    const container = document.querySelector('.initial-app-loader');
    if (container) {
        container.innerHTML = SPINNER_SVGS[selectedType];
    }
    
    // 3. Update Auth Status Spinner (if displayed)
    const authSpinner = document.querySelector('.auth-loading-spinner');
    if (authSpinner) {
        authSpinner.innerHTML = SPINNER_SVGS[selectedType];
    }
}

/**
 * Called on app boot to inject the correct SVG based on previous choice.
 */
export function initGlobalSpinner() {
    const savedType = localStorage.getItem('site_spinner_type') || 'coffee';
    setGlobalSpinner(savedType);
}

// --- 2. TOAST NOTIFICATIONS ---
export function showToast(message, type = 'info', overrideDuration = null) {
    // 1. Setup Container
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        // CSS for container handled in style.css now, but force position fixed here just in case
        container.style.position = 'fixed'; 
        container.style.zIndex = '9999';
        document.body.appendChild(container);
    }

    // 2. Get Settings safely
    let settings = {};
    try { settings = useAppStore.getState().siteSettings?.settings?.toast || {}; } catch(e) {}
    
    const duration = overrideDuration || settings.duration || 3000;
    const position = settings.position || 'bottom-right';

    // 3. Apply Position (Dynamic updates)
    if (position.includes('bottom')) { container.style.bottom = '20px'; container.style.top = 'auto'; }
    else { container.style.top = '20px'; container.style.bottom = 'auto'; }
    
    if (position.includes('right')) { container.style.right = '20px'; container.style.left = 'auto'; container.style.alignItems = 'flex-end'; }
    else if (position.includes('left')) { container.style.left = '20px'; container.style.right = 'auto'; container.style.alignItems = 'flex-start'; }
    else { container.style.left = '50%'; container.style.transform = 'translateX(-50%)'; container.style.alignItems = 'center'; }

    // 4. Create Toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    // 5. Add to DOM
    container.appendChild(toast);

    // 6. Removal Logic (CSS Animation based)
    // We assume style.css has the keyframes for 'slideIn' (automatic) and 'fadeOut' (manual)
    setTimeout(() => {
        toast.classList.add('hide'); // Triggers CSS fadeOut
        
        // Wait for CSS animation to finish before removing from DOM
        toast.addEventListener('animationend', () => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        });
    }, duration);
}

// --- 3. MODAL SYSTEM ---
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
    document.body.style.overflow = 'hidden'; 

    requestAnimationFrame(() => modalOverlay.classList.add('open'));

    const closeBtn = document.getElementById('modal-close-btn');
    closeBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (event) => {
        if (event.target === modalOverlay) closeModal();
    });
}

export function closeModal() {
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay) {
        modalOverlay.classList.remove('open');
        setTimeout(() => modalOverlay.remove(), 300);
    }
    document.body.style.overflow = 'auto';
}

// --- 4. THEME & LAYOUT UTILS ---


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

    const currentFont = currentVars['--font-family-main-name'] || 'Roboto';
    const fontOptions = AVAILABLE_FONTS.map(font => 
        `<option value="${font}" ${font === currentFont ? 'selected' : ''}>${font}</option>`
    ).join('');

    return `
        <div class="theme-controls-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
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

/**
 * Applies the Header Layout (Logo Alignment / Hamburger Position)
 */
export function applyHeaderLayout(layoutConfig) {
    const header = document.getElementById('main-header');
    if (!header) return;

    const { logoAlignment, hamburgerPosition } = layoutConfig || {};

    // 1. Reset
    header.classList.remove('logo-align-left', 'hamburger-left');

    // 2. Apply Logo Alignment
    if (logoAlignment === 'left') {
        header.classList.add('logo-align-left');
    }

    // 3. Apply Hamburger Position
    const panel = document.getElementById('mobile-menu-panel');
    if (hamburgerPosition === 'left') {
        header.classList.add('hamburger-left');
        if (panel) {
            panel.style.right = 'auto';
            panel.style.left = '0';
            panel.style.transform = 'translateX(-100%)'; 
            panel.classList.add('slide-from-left');
        }
    } else {
        if (panel) {
            panel.style.right = '0';
            panel.style.left = 'auto';
            panel.style.transform = 'translateX(100%)';
            panel.classList.remove('slide-from-left');
        }
    }
}

// --- 5. LOADING SPINNER UTILS ---

export function hideInitialLoader() {
    const loader = document.querySelector('.initial-app-loader');
    if (!loader) return;

    void loader.offsetWidth; // Force reflow
    loader.classList.add('fade-out');

    setTimeout(() => {
        loader.remove();
        document.body.classList.add('app-loaded'); 
    }, 400); 
}

export function updateSpinnerColor(newColor) {
    const spinner = document.querySelector('.dynamic-coffee-spinner');
    if (spinner && newColor) {
        spinner.style.color = newColor; 
    }
}




/**
 * Updates all instances of the site title/logo in the DOM.
 * @param {string} name - The text name of the website.
 * @param {string} [logoUrl=null] - The URL of the logo image.
 */
export function updateSiteTitles(name, logoUrl = null) {
    const siteTitleElement = document.querySelector('#main-header h1');
    const siteTitleFooterElement = document.querySelector('#main-footer p');
    const siteTitleTagElement = document.querySelector('title');

    // 1. Update Text Elements (Title Tag & Footer)
    if (siteTitleTagElement && name) {
        siteTitleTagElement.textContent = name;
    }
    if (siteTitleFooterElement && name) {
        siteTitleFooterElement.innerHTML = `&copy; ${new Date().getFullYear()} ${name}`;
    }

    // 2. Update Header (Logo vs Text)
    if (siteTitleElement) {
        if (logoUrl) {
            // Render Image
            siteTitleElement.innerHTML = `<img src="${logoUrl}" alt="${name || 'Site Logo'}" class="site-logo" />`;
        } else if (name) {
            // Render Text
            siteTitleElement.textContent = name;
        }
    }
}
