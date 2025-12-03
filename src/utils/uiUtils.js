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
    "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", 
    "Playfair Display", "Merriweather", "Nunito", "Raleway", "Oswald"
];

export function applySiteFont(fontName) {
    if (!fontName) return;
    const existingLink = document.getElementById('dynamic-font-link');
    if (existingLink && existingLink.dataset.font === fontName) return;
    if (existingLink) existingLink.remove();

    const link = document.createElement('link');
    link.id = 'dynamic-font-link';
    link.dataset.font = fontName;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@300;400;500;700&display=swap`;
    
    document.head.appendChild(link);
    document.documentElement.style.setProperty('--font-family-main-name', fontName);
}

export function setGlobalSpinner(type) {
    const validTypes = ['coffee', 'hammer'];
    const selectedType = validTypes.includes(type) ? type : 'coffee';
    localStorage.setItem('site_spinner_type', selectedType);

    const container = document.querySelector('.initial-app-loader');
    if (container) container.innerHTML = SPINNER_SVGS[selectedType];
    
    const authSpinner = document.querySelector('.auth-loading-spinner');
    if (authSpinner) authSpinner.innerHTML = SPINNER_SVGS[selectedType];
}

export function initGlobalSpinner() {
    const savedType = localStorage.getItem('site_spinner_type') || 'coffee';
    setGlobalSpinner(savedType);
}

// --- 2. TOAST NOTIFICATIONS ---
export function showToast(message, type = 'info', overrideDuration = null, onClick = null) {
    console.group("🍞 Toast Debugger");

    // 1. Setup Container
    let container = document.getElementById('toast-container');
    if (!container) {
        console.log("Creating new toast container...");
        container = document.createElement('div');
        container.id = 'toast-container';
        // Base critical styles
        container.style.position = 'fixed';
        container.style.zIndex = '9999';
        container.style.pointerEvents = 'none'; 
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '10px';
        document.body.appendChild(container);
    } else {
        console.log("Found existing toast container.");
    }

    // 2. Get Settings
    let settings = {};
    try { 
        settings = useAppStore.getState().siteSettings?.settings?.toast || {}; 
    } catch(e) {
        console.warn("Store not ready yet, using defaults");
    }
    
    const duration = overrideDuration || settings.duration || 3000;
    // DEBUG: Log what the database actually says
    console.log("Raw Settings:", settings); 
    
    const position = settings.position || 'bottom-center';
    console.log("Resolved Position:", position);

    // 3. Apply Position (Reset first)
    container.style.left = '';
    container.style.right = '';
    container.style.top = '';
    container.style.bottom = '';
    container.style.transform = '';
    container.style.alignItems = ''; // Reset alignment

    // Vertical Logic
    if (position.includes('bottom')) { 
        container.style.bottom = '20px'; 
        container.style.top = 'auto'; 
    } else { 
        container.style.top = '20px'; 
        container.style.bottom = 'auto'; 
    }
    
    // Horizontal Logic
    if (position.includes('right')) { 
        console.log("Applying RIGHT alignment");
        container.style.right = '20px'; 
        container.style.alignItems = 'flex-end'; 
    } else if (position.includes('left')) { 
        console.log("Applying LEFT alignment");
        container.style.left = '20px'; 
        container.style.alignItems = 'flex-start'; 
    } else { 
        // CENTER
        console.log("Applying CENTER alignment");
        container.style.left = '0'; 
        container.style.right = '0'; 
        container.style.alignItems = 'center'; 
        // Force explicit width to ensure centering works
        container.style.width = '100%'; 
    }

    console.log("Final Container Styles:", container.style.cssText);

    // 4. Create Toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.pointerEvents = 'auto'; 
    
    if (onClick) {
        toast.classList.add('clickable');
        toast.addEventListener('click', () => { onClick(); toast.remove(); });
    }

    container.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            });
        }
    }, duration);
    
    console.groupEnd();
}

// --- 3. MODAL SYSTEM ---
export function showModal(htmlContent) {
    closeModal(); 

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'modal-overlay'; // Add ID for easier selection
    modalOverlay.className = 'modal-overlay';
    
    // FIX: Used correct variable 'htmlContent' inside template
    modalOverlay.innerHTML = `
        <div class="modal-content">
            <button class="modal-close-btn" aria-label="Close">&times;</button>
            ${htmlContent}
        </div>
    `;

    document.body.appendChild(modalOverlay);

    // Attach Listeners
    modalOverlay.querySelector('.modal-close-btn').addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });
}

export function closeModal() {
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay) {
        modalOverlay.classList.add('fade-out'); // Optional CSS class if you have it
        modalOverlay.remove();
    }
}

// --- 4. THEME & LAYOUT UTILS ---

export function updateCssVariable(varName, value) {
    if (varName && value !== undefined) {
        document.documentElement.style.setProperty(varName, value);
    }
}

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
    `;
}

export function applyHeaderLayout(layoutConfig) {
    const header = document.getElementById('main-header');
    if (!header) return;

    const { logoAlignment, hamburgerPosition } = layoutConfig || {};

    header.classList.remove('logo-align-left', 'hamburger-left');

    if (logoAlignment === 'left') {
        header.classList.add('logo-align-left');
    }

    // Handle Hamburger / Mobile Panel logic if needed via CSS classes on body or header
    if (hamburgerPosition === 'left') {
        header.classList.add('hamburger-left');
    }
}

export function hideInitialLoader() {
    const loader = document.querySelector('.initial-app-loader');
    if (!loader) return;
    void loader.offsetWidth; 
    loader.classList.add('fade-out');
    setTimeout(() => {
        loader.remove();
        document.body.classList.add('app-loaded'); 
    }, 400); 
}

export function applyHeaderLogo(config) {
    if (!config) return;
    
    const h1 = document.querySelector('#main-header h1');
    if (!h1) return;

    const svgHTML = generateHeaderSVG(config);
    h1.innerHTML = svgHTML;
    
    // Reset styles to accept SVG
    h1.style.padding = '0';
    h1.style.lineHeight = '0';
    h1.style.display = 'flex';
    h1.style.alignItems = 'center';
    // Remove text content styles if necessary
    h1.style.fontSize = 'unset'; 
}

export function updateSiteTitles(name, logoUrl) {
    if (name) document.title = name;
    if (logoUrl) {
        const favicon = document.getElementById('dynamic-favicon');
        if (favicon) favicon.href = logoUrl;
    }
}

export function generatePatternUrl(text) {
    const svg = `
    <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <pattern id="textPattern" x="0" y="0" width="100" height="100" patternUnits="userSpaceOnUse">
                <text x="0" y="50" font-family="sans-serif" font-weight="bold" font-size="16" 
                      fill="#000" opacity="0.05" transform="rotate(-45 0 50)">
                    ${text}   ${text}
                </text>
            </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#textPattern)" />
    </svg>`;
    return `url('data:image/svg+xml;base64,${btoa(svg)}')`;
}

export function applyGlobalBackground(settings) {
    const style = document.documentElement.style;
    const body = document.body;
    const uiConfig = settings.uiConfig || {};
    const theme = settings.themeVariables || {};
    const bgType = uiConfig.backgroundType || 'color';

    body.classList.remove('bg-parallax', 'bg-animate');

    if (bgType === 'image') {
        let rawUrl = theme['--body-background-image'] || '';
        if (rawUrl === 'none') rawUrl = '';
        style.setProperty('--body-background-image', rawUrl);
        style.setProperty('background-size', 'cover');
        if (uiConfig.bgParallax) body.classList.add('bg-parallax');
    
    } else if (bgType === 'pattern') {
        const text = settings.websiteName || 'Mealmates';
        const patternUrl = generatePatternUrl(text);
        style.setProperty('--body-background-image', patternUrl);
        style.setProperty('background-size', 'auto');
        if (uiConfig.bgAnimation) body.classList.add('bg-animate');
    
    } else {
        style.setProperty('--body-background-image', 'none');
    }
}

export function generateHeaderSVG(config) {
    // Safety Fallback
    if (!config || typeof config !== 'object') {
        console.warn("Header SVG Config is invalid or string:", config);
        return ''; 
    }

    const w = 800; 
    const h = 200; 
    
    // Safe Accessors with Defaults
    const bgColor = config.bgColor || '#263238';
    const accentColor = config.accentColor || '#f57c00';
    const textColor = config.textColor || '#ffffff';
    
    // Helper to safely upper case
    const mainText = (config.mainText || 'MEALMATES').toUpperCase();
    const subText = (config.subText || '').toUpperCase();

    const mx = config.mainX ?? 50;
    const my = config.mainY ?? 45;
    const mFont = config.mainFont || "sans-serif";
    const mSize = config.mainSize || 40;

    const sx = config.subX ?? 50;
    const sy = config.subY ?? 70;
    const sFont = config.subFont || "sans-serif";
    const sSize = config.subSize || 16;

    let defs = '';
    let patternOverlay = '';

    if (config.pattern === 'stripes') {
        defs = `<defs><pattern id="p_stripes" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="20" stroke="${accentColor}" stroke-width="10" opacity="0.1" /></pattern></defs>`;
        patternOverlay = `<rect width="100%" height="100%" fill="url(#p_stripes)" />`;
    } 
    else if (config.pattern === 'circle') {
        defs = `<defs><pattern id="p_circles" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="2" fill="${accentColor}" opacity="0.2" /></pattern></defs>`;
        patternOverlay = `<rect width="100%" height="100%" fill="url(#p_circles)" />`;
    }

    return `
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" 
             style="width:100%; height:100%; display:block; background:${bgColor};">
            ${defs}
            ${patternOverlay}
            <rect x="0" y="${h - 10}" width="${w}" height="10" fill="${accentColor}" />
            
            <text x="${mx}%" y="${my}%" text-anchor="middle" dominant-baseline="middle" 
                  fill="${textColor}" font-family="${mFont}" font-weight="bold" 
                  font-size="${mSize}">
                ${mainText}
            </text>
            
            <text x="${sx}%" y="${sy}%" text-anchor="middle" dominant-baseline="middle" 
                  fill="${textColor}" font-family="${sFont}" font-weight="normal" 
                  font-size="${sSize}" letter-spacing="1">
                ${subText}
            </text>
        </svg>
    `;
}