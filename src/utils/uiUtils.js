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
            <!-- Nail -->
            <g class="nail-body">
                <rect x="48" y="55" width="4" height="25" fill="currentColor" />
                <rect x="44" y="55" width="12" height="4" fill="currentColor" />
            </g>
            <!-- Hammer -->
            <g class="hammer-body">
                 <!-- Handle -->
                <rect x="60" y="30" width="8" height="50" fill="currentColor" transform="rotate(-20 64 55)" />
                <!-- Head -->
                <path d="M45 20 H 85 V 35 H 45 Z" fill="currentColor" transform="rotate(-20 64 55)" />
            </g>
        </svg>
    `
};



/**
 * Sets the active spinner type (Coffee or Hammer).
 * Saves to LocalStorage so it persists instantly on reload.
 */
export function setGlobalSpinner(type) {
    const validTypes = ['coffee', 'hammer'];
    const selectedType = validTypes.includes(type) ? type : 'coffee';
    
    // 1. Save for next boot
    localStorage.setItem('site_spinner_type', selectedType);

    // 2. Update DOM immediately if loader is visible or for auth spinner
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

    // 1. Force a tiny reflow to ensure the browser is ready for the transition
    // (This prevents the animation from being skipped by the engine)
    void loader.offsetWidth;

    // 2. Add the class that triggers the CSS transition (opacity: 0)
    loader.classList.add('fade-out');

    // 3. Wait for the CSS transition (0.4s) to finish, then remove from DOM
    setTimeout(() => {
        loader.remove();
        
        // Optional: Trigger a "Content Ready" class on the app if you want 
        // even more control, but the CSS animation on #main-content handles this.
        document.body.classList.add('app-loaded'); 
    }, 400); // Matches the 0.4s CSS transition
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
    // (Default is center, so no class needed for center)

    // 3. Apply Hamburger Position
    if (hamburgerPosition === 'left') {
        header.classList.add('hamburger-left');
        
        // Update Mobile Menu slide direction
        const panel = document.getElementById('mobile-menu-panel');
        if (panel) {
            panel.style.right = 'auto';
            panel.style.left = '0';
            panel.style.transform = 'translateX(-100%)'; // Start off-screen left
            // We need to dynamically update the open state style too
            // or use CSS variables. For simplicity, we stick to the CSS class logic
            // but we might need a specific class on the panel.
            panel.classList.add('slide-from-left');
        }
    } else {
        // Reset to Right
        const panel = document.getElementById('mobile-menu-panel');
        if (panel) {
            panel.style.right = '0';
            panel.style.left = 'auto';
            panel.style.transform = 'translateX(100%)';
            panel.classList.remove('slide-from-left');
        }
    }
}