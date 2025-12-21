const SPINNER_SVGS = {
    coffee: `
        <svg class="loader-icon" viewBox="0 0 100 100">
            <path d="M22 40 H 78 L 72 80 Q 50 90 28 80 Z" fill="transparent" stroke="currentColor" stroke-width="6" stroke-linejoin="round" />
            <path d="M78 50 C 92 50, 92 70, 78 70" fill="transparent" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
            <path class="mini-steam" d="M38 35 C 34 28, 42 22, 38 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
            <path class="mini-steam" d="M50 35 C 54 28, 46 22, 50 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
            <path class="mini-steam" d="M62 35 C 58 28, 66 22, 62 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
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

export function getLoaderHTML(loadingText = "Loading...") {
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
        iconHTML = SPINNER_SVGS['coffee'];
    }

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

export function setGlobalSpinnerConfig(config) {
    localStorage.setItem('site_loader_config', JSON.stringify(config));
}