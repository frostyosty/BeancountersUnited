// src/utils/uiUtils.js
import { useAppStore } from '@/store/appStore.js';

// --- SPINNER ASSETS ---
// --- SPINNER ASSETS ---
const SPINNER_SVGS = {
    coffee: `
        <svg class="loader-icon" viewBox="0 0 100 100">
            <path d="M22 40 H 78 L 72 80 Q 50 90 28 80 Z" fill="transparent" stroke="currentColor" stroke-width="6" />
            <path d="M78 50 C 92 50, 92 70, 78 70" fill="transparent" stroke="currentColor" stroke-width="6" />
            <path class="mini-steam" d="M40 35 L 42 25" fill="none" stroke="currentColor" stroke-width="4" />
            <path class="mini-steam" d="M50 35 L 48 25" fill="none" stroke="currentColor" stroke-width="4" />
            <path class="mini-steam" d="M60 35 L 62 25" fill="none" stroke="currentColor" stroke-width="4" />
        </svg>
    `,
    hammer: `
        <svg class="loader-icon" viewBox="0 0 100 100">
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

/**
 * Returns the HTML for the loading screen based on saved config.
 */
export function getLoaderHTML(loadingText = "Loading...") {
    // Read config from LocalStorage for speed (or default)
    let config = { type: 'coffee', animation: 'pulse', customUrl: '' };
    try {
        const saved = localStorage.getItem('site_loader_config');
        if (saved) config = { ...config, ...JSON.parse(saved) };
    } catch (e) {}

    let iconHTML = '';

    if (config.type === 'custom' && config.customUrl) {
        iconHTML = `<img src="${config.customUrl}" class="loader-icon" alt="Loading">`;
    } else if (SPINNER_SVGS[config.type]) {
        iconHTML = SPINNER_SVGS[config.type];
    } else {
        iconHTML = SPINNER_SVGS['coffee']; // Fallback
    }

    // Wrap in Animation Class
    const animClass = config.animation ? `anim-${config.animation}` : '';

    return `
        <div class="loader-container">
            <div class="${animClass}" style="color:var(--primary-color);">
                ${iconHTML}
            </div>
            ${loadingText ? `<div class="loader-text">${loadingText}</div>` : ''}
        </div>
    `;
}

/**
 * Saves loader config and updates global spinner if visible.
 */
export function setGlobalSpinnerConfig(config) {
    localStorage.setItem('site_loader_config', JSON.stringify(config));
}



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
// --- 2. TOAST NOTIFICATIONS ---
export function showToast(message, type = 'info', overrideDuration = null, onClick = null) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    // DEBUG LOG
    const rect = container.getBoundingClientRect();
    console.log("Toast Container Rect:", rect);
    console.log("Window Width:", window.innerWidth);

    let settings = {};
    try { settings = useAppStore.getState().siteSettings?.settings?.toast || {}; } catch(e) {}
    
    const duration = overrideDuration || settings.duration || 3000;
    const position = settings.position || 'bottom-center';

    // Reset layout styles to let CSS/Logic take over
    container.style.left = '';
    container.style.right = '';
    container.style.top = '';
    container.style.bottom = '';
    container.style.transform = '';
    container.style.alignItems = ''; 

    // Apply Position Logic
    if (position.includes('bottom')) { 
        container.style.bottom = '20px'; 
        container.style.top = 'auto'; 
    } else { 
        container.style.top = '20px'; 
        container.style.bottom = 'auto'; 
    }
    
    if (position.includes('right')) { 
        container.style.right = '20px'; 
        container.style.alignItems = 'flex-end'; 
    } else if (position.includes('left')) { 
        container.style.left = '20px'; 
        container.style.alignItems = 'flex-start'; 
    } else { 
        // CENTER
        container.style.left = '0'; 
        container.style.right = '0'; 
        container.style.alignItems = 'center'; // Flex centering
        container.style.width = '100%';        // Force full width span
        container.style.pointerEvents = 'none'; // Click-through empty space
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    // Interactive settings
    toast.style.pointerEvents = 'auto'; 
    
    if (onClick) {
        toast.classList.add('clickable');
        toast.addEventListener('click', () => { onClick(); toast.remove(); });
    }

    container.appendChild(toast);

    // Trigger Entry Animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto-remove logic
    setTimeout(() => {
        toast.classList.remove('show');
        // Force removal after animation time (300ms) + buffer
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 400); 
    }, duration);
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

    const { logoAlignment, hamburgerPosition, height, bgColor } = layoutConfig || {};

    // Apply Height
    if (height) document.documentElement.style.setProperty('--header-height', height + 'px');
    
    // NEW: Apply Background Color
    if (bgColor) header.style.backgroundColor = bgColor;

    // ... existing alignment classes ...
    header.classList.remove('logo-align-left', 'hamburger-left');
    if (logoAlignment === 'left') header.classList.add('logo-align-left');
    if (hamburgerPosition === 'left') header.classList.add('hamburger-left');
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
    const header = document.getElementById('main-header'); // Select the parent header
    
    if (!h1) return;

    const svgHTML = generateHeaderSVG(config);
    h1.innerHTML = svgHTML;
    
    // Reset H1 styles
    h1.style.padding = '0';
    h1.style.lineHeight = '0';
    h1.style.display = 'flex';
    h1.style.alignItems = 'center';
    h1.style.justifyContent = 'center';
    h1.style.width = '100%';

    // FIX: Apply the Logo's background color to the entire Header Bar
    if (header && config.bgColor) {
        header.style.backgroundColor = config.bgColor;
        // Optional: Remove border if you want a totally seamless look
        // header.style.borderBottom = 'none'; 
    }
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


// src/utils/uiUtils.js

// Helper to build text content from string OR array
function buildTextContent(input, defaultColor, defaultFont, defaultSize, defaultWeight) {
    // Case A: Simple String (Legacy/Default)
    if (typeof input === 'string') {
        return input.toUpperCase();
    }

    // Case B: Advanced Letter Array
    if (Array.isArray(input)) {
        return input.map(l => {
            // Fallback to defaults if letter doesn't have specific override
            const fill = l.color || defaultColor;
            const font = l.font || defaultFont;
            const size = l.size || defaultSize;
            const weight = l.weight || defaultWeight;
            const rotate = l.rotate || 0;
            const dy = l.dy || 0; // Vertical shift
            const dx = l.dx || 0; // Horizontal kerning adjustment

            // SVG <tspan> magic
            return `<tspan fill="${fill}" font-family="${font}" font-size="${size}" font-weight="${weight}" rotate="${rotate}" dy="${dy}" dx="${dx}">${l.char}</tspan>`;
        }).join('');
    }
    return '';
}

export function generateHeaderSVG(config) {
    if (!config || typeof config !== 'object') return '';

    const w = 800; 
    const h = 200; 
    
    const bgColor = config.bgColor || '#263238';
    const accentColor = config.accentColor || '#f57c00';
    
    // Defaults
    const defColor = config.textColor || '#ffffff';
    const mFont = config.mainFont || "sans-serif";
    const mSize = config.mainSize || 40;
    const mWeight = config.mainWeight || 700; 
    const mx = config.mainX ?? 50;
    const my = config.mainY ?? 45;

    const sFont = config.subFont || "sans-serif";
    const sSize = config.subSize || 16;
    const sWeight = config.subWeight || 400;
    const sx = config.subX ?? 50;
    const sy = config.subY ?? 70;

    // Build Content
    const mainContent = buildTextContent(config.mainText, defColor, mFont, mSize, mWeight);
    const subContent = buildTextContent(config.subText, defColor, sFont, sSize, sWeight);

    // Image Logic
    const imgUrl = config.imgUrl || '';
    const imgSize = config.imgSize || 60;
    const imgX = config.imgX ?? 80;
    const imgY = config.imgY ?? 50;
    const imageTag = imgUrl 
        ? `<image href="${imgUrl}" x="${imgX}%" y="${imgY}%" width="${imgSize}" height="${imgSize}" transform="translate(-${imgSize/2}, -${imgSize/2})" preserveAspectRatio="xMidYMid meet" />` 
        : '';

    // Pattern Logic
    let defs = '';
    let patternOverlay = '';
    if (config.pattern === 'stripes') {
        defs = `<defs><pattern id="p_stripes" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="20" stroke="${accentColor}" stroke-width="10" opacity="0.1" /></pattern></defs>`;
        patternOverlay = `<rect width="100%" height="100%" fill="url(#p_stripes)" />`;
    } else if (config.pattern === 'circle') {
        defs = `<defs><pattern id="p_circles" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="2" fill="${accentColor}" opacity="0.2" /></pattern></defs>`;
        patternOverlay = `<rect width="100%" height="100%" fill="url(#p_circles)" />`;
    }

    return `
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" 
             style="width:100%; height:100%; display:block; background:${bgColor};">
            ${defs}
            ${patternOverlay}
            <rect x="0" y="${h - 10}" width="${w}" height="10" fill="${accentColor}" />
            ${imageTag}
            
            <!-- Note: Default properties set on <text> serve as base for <tspans> -->
            <text x="${mx}%" y="${my}%" text-anchor="middle" dominant-baseline="middle" 
                  fill="${defColor}" font-family="${mFont}" font-weight="${mWeight}" font-size="${mSize}">
                ${mainContent}
            </text>
            
            <text x="${sx}%" y="${sy}%" text-anchor="middle" dominant-baseline="middle" 
                  fill="${defColor}" font-family="${sFont}" font-weight="${sWeight}" font-size="${sSize}" letter-spacing="1">
                ${subContent}
            </text>
        </svg>
    `;
}