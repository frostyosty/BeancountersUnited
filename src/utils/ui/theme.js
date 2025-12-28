export const AVAILABLE_FONTS = [
    "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", 
    "Playfair Display", "Merriweather", "Nunito", "Raleway", "Oswald",
    "Bebas Neue", "Dancing Script", "Pacifico", "Righteous", "Ubuntu"
];

export function ensureFontLoaded(fontName) {
    if (!fontName) return;
    const cleanName = fontName.split(',')[0].replace(/['"]/g, '').trim();
    const id = `font-${cleanName.toLowerCase().replace(/\s+/g, '-')}`;
    if (document.getElementById(id)) return;

    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${cleanName.replace(/\s+/g, '+')}:wght@300;400;500;700&display=swap`;
    document.head.appendChild(link);
}

export function applySiteFont(fontName) {
    if (!fontName) return;
    ensureFontLoaded(fontName);
    const cleanName = fontName.split(',')[0].replace(/['"]/g, '').trim();
    document.documentElement.style.setProperty('--font-family-main-name', cleanName);
}

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
        const text = settings.websiteName || 'BeancountersUnited';
        const patternUrl = generatePatternUrl(text);
        style.setProperty('--body-background-image', patternUrl);
        style.setProperty('background-size', 'auto');
        if (uiConfig.bgAnimation) body.classList.add('bg-animate');
    
    } else {
        style.setProperty('--body-background-image', 'none');
    }
}