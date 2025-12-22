import { ensureFontLoaded } from './theme.js';
import { warper } from './morph/index.js';

// --- CONTRAST HELPERS ---
function getLuminance(hex) {
    if (!hex || hex[0] !== '#') return 0;
    const r = parseInt(hex.substr(1, 2), 16) / 255;
    const g = parseInt(hex.substr(3, 2), 16) / 255;
    const b = parseInt(hex.substr(5, 2), 16) / 255;
    const a = [r, g, b].map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function hasGoodContrast(hex1, hex2) {
    const lum1 = getLuminance(hex1) + 0.05;
    const lum2 = getLuminance(hex2) + 0.05;
    const ratio = lum1 > lum2 ? lum1 / lum2 : lum2 / lum1;
    return ratio > 3; 
}

function getContrastColor(hexColor) {
    if (!hexColor || hexColor[0] !== '#') return '#000000';
    const r = parseInt(hexColor.substr(1, 2), 16);
    const g = parseInt(hexColor.substr(3, 2), 16);
    const b = parseInt(hexColor.substr(5, 2), 16);
    const y = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (y >= 128) ? '#000000' : '#ffffff';
}

function getHeaderPatternStyle(patternType, bgColor) {
    const color = getContrastColor(bgColor) === '#ffffff' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
    switch (patternType) {
        case 'stripes': return `repeating-linear-gradient(45deg, transparent, transparent 10px, ${color} 10px, ${color} 20px)`;
        case 'dots': return `radial-gradient(${color} 1px, transparent 1px)`;
        case 'grid': return `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`;
        case 'zigzag': return `linear-gradient(135deg, ${color} 25%, transparent 25%) -10px 0, linear-gradient(225deg, ${color} 25%, transparent 25%) -10px 0, linear-gradient(315deg, ${color} 25%, transparent 25%), linear-gradient(45deg, ${color} 25%, transparent 25%)`;
        default: return 'none';
    }
}

export function updateSiteTitles(name, logoUrl) {
    if (name) document.title = name;
    if (logoUrl) {
        const favicon = document.getElementById('dynamic-favicon');
        if (favicon) favicon.href = logoUrl;
    }
}

export function applyHeaderLayout(layoutConfig) {
    const header = document.getElementById('main-header');
    if (!header) return;

    const { logoAlignment, hamburgerPosition, height, bgColor, bgPattern } = layoutConfig || {};

    if (height) document.documentElement.style.setProperty('--header-height', height + 'px');
    
    if (bgColor) {
        header.style.backgroundColor = bgColor;
        const textColor = getContrastColor(bgColor);
        document.documentElement.style.setProperty('--header-text-color', textColor);
        
        const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#4d2909';
        let activeColor = primaryColor;
        if (!hasGoodContrast(bgColor, primaryColor)) {
            activeColor = textColor;
        }
        document.documentElement.style.setProperty('--header-active-color', activeColor);

        if (bgPattern && bgPattern !== 'none') {
            header.style.backgroundImage = getHeaderPatternStyle(bgPattern, bgColor);
            header.style.backgroundSize = bgPattern === 'dots' ? '20px 20px' : (bgPattern === 'grid' ? '20px 20px' : (bgPattern === 'zigzag' ? '20px 20px' : 'auto'));
        } else {
            header.style.backgroundImage = 'none';
        }
    }

    header.classList.remove('logo-align-left', 'hamburger-left');
    if (logoAlignment === 'left') header.classList.add('logo-align-left');
    if (hamburgerPosition === 'left') header.classList.add('hamburger-left');
}

// Helper to build text content
function buildTextContent(input, defaultColor, defaultFont, defaultSize, defaultWeight) {
    if (typeof input === 'string') return input.toUpperCase();
    if (Array.isArray(input)) {
        return input.map(l => {
            const fill = l.color || defaultColor;
            const font = l.font || defaultFont;
            const size = l.size || defaultSize;
            const weight = l.weight || defaultWeight;
            const rotate = l.rotate || 0;
            const dy = l.dy || 0; 
            const dx = l.dx || 0; 
            return `<tspan fill="${fill}" font-family="${font}" font-size="${size}" font-weight="${weight}" rotate="${rotate}" dy="${dy}" dx="${dx}">${l.char}</tspan>`;
        }).join('');
    }
    return '';
}

export function generateHeaderSVG(config) {
    if (!config || typeof config !== 'object') return '';

    const w = 800; const h = 200; 
    const bgColor = config.bgColor || '#263238';
    const accentColor = config.accentColor || '#f57c00';
    const textColor = config.textColor || '#ffffff';
    
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

    const imgUrl = config.imgUrl || '';
    const imgSize = config.imgSize || 60;
    const imgX = config.imgX ?? 80;
    const imgY = config.imgY ?? 50;

    ensureFontLoaded(mFont);
    ensureFontLoaded(sFont);

    const mainContent = buildTextContent(config.mainText || 'MEALMATES', textColor, mFont, mSize, mWeight);
    const subContent = buildTextContent(config.subText || '', textColor, sFont, sSize, sWeight);

    let defs = '';
    let patternOverlay = '';
    if (config.pattern === 'stripes') {
        defs = `<defs><pattern id="p_stripes" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="20" stroke="${accentColor}" stroke-width="10" opacity="0.1" /></pattern></defs>`;
        patternOverlay = `<rect width="100%" height="100%" fill="url(#p_stripes)" />`;
    } else if (config.pattern === 'circle') {
        defs = `<defs><pattern id="p_circles" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="2" fill="${accentColor}" opacity="0.2" /></pattern></defs>`;
        patternOverlay = `<rect width="100%" height="100%" fill="url(#p_circles)" />`;
    }

    const imageTag = imgUrl 
        ? `<image href="${imgUrl}" x="${imgX}%" y="${imgY}%" width="${imgSize}" height="${imgSize}" transform="translate(-${imgSize/2}, -${imgSize/2})" preserveAspectRatio="xMidYMid meet" />` 
        : '';

    return `
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" style="width:100%; height:100%; display:block; background:${bgColor};">
            ${defs}${patternOverlay}
            <rect x="0" y="${h - 10}" width="${w}" height="10" fill="${accentColor}" />
            ${imageTag}
            <text x="${mx}%" y="${my}%" text-anchor="middle" dominant-baseline="middle" fill="${textColor}" font-family="${mFont}" font-weight="${mWeight}" font-size="${mSize}">${mainContent}</text>
            <text x="${sx}%" y="${sy}%" text-anchor="middle" dominant-baseline="middle" fill="${textColor}" font-family="${sFont}" font-weight="${sWeight}" font-size="${sSize}" letter-spacing="1">${subContent}</text>
        </svg>
    `;
}

export function applyHeaderLogo(config) {
    if (!config) return;
    localStorage.setItem('cached_header_config', JSON.stringify(config));

    const h1 = document.querySelector('#main-header h1');
    const header = document.getElementById('main-header');
    if (!h1) return;

    const newSVG = generateHeaderSVG(config);
    
    // WARP LOGIC
    if (h1.innerHTML.trim() !== '' && h1.getBoundingClientRect().width > 0) {
        warper.warpElement(h1, newSVG);
    } else {
        h1.innerHTML = newSVG;
    }
    
    h1.style.padding = '0';
    h1.style.margin = '0';
    h1.style.width = '100%';
    h1.style.height = '100%';
    h1.style.display = 'flex';
    h1.style.alignItems = 'center';
    h1.style.justifyContent = 'center';

    if (header && config.bgColor) {
        header.style.backgroundColor = config.bgColor;
    }
}