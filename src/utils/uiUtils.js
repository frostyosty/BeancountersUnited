// src/utils/uiUtils.js

/**
 * Displays a short-lived notification message (a "toast").
 * @param {string} message - The message to display.
 * @param {string} [type='info'] - The type of toast ('info', 'success', 'error').
 * @param {number} [duration=3000] - How long to display the toast in milliseconds.
 */
export function showToast(message, type = 'info', duration = 3000) {
    // Check if a toast container exists, if not, create it.
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    // Animate in
    setTimeout(() => {
        toast.classList.add('show');
    }, 100); // Small delay to allow CSS transition

    // Set timeout to remove the toast
    setTimeout(() => {
        toast.classList.remove('show');
        // Remove the element from DOM after transition ends
        toast.addEventListener('transitionend', () => {
            toast.remove();
        });
    }, duration);
}


/**
 * Displays a modal with the provided HTML content.
 * @param {string} htmlContent - HTML to render inside the modal.
 */
export function showModal(htmlContent) {
    // Remove any existing modal first
    closeModal();

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

    // Add event listeners
    const closeBtn = document.getElementById('modal-close-btn');
    closeBtn.addEventListener('click', closeModal);

    modalOverlay.addEventListener('click', (event) => {
        // Close if the click is on the overlay itself, not the content
        if (event.target === modalOverlay) {
            closeModal();
        }
    });
}

/**
 * Closes the currently open modal.
 */
export function closeModal() {
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay) {
        modalOverlay.remove();
    }
    document.body.style.overflow = 'auto'; // Restore scrolling
}




// --- Site Branding & Theming ---
/**
 * Updates all instances of the site title in the DOM.
 * @param {string} newName - The new website name.
 */
export function updateSiteTitles(newName) {
    const siteTitleElement = document.querySelector('#main-header h1');
    const siteTitleFooterElement = document.querySelector('#main-footer p'); // A bit fragile, better with an ID
    const siteTitleTagElement = document.querySelector('title');

    if (siteTitleElement) siteTitleElement.textContent = newName;
    if (siteTitleFooterElement) siteTitleFooterElement.innerHTML = `&copy; ${new Date().getFullYear()} ${newName}`;
    if (siteTitleTagElement) siteTitleTagElement.textContent = newName;
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
 * Generates HTML for theme customization controls (CSS variable pickers).
 * @param {object} [currentThemeSettings={}] - Current theme variables.
 * @returns {string} - HTML string for theme controls.
 */
export function getThemeControlsHTML(currentThemeSettings = {}) {
    let html = '<h3>Theme Customizer (Live CSS Variables)</h3>';
    const editableVars = [
        { name: 'Primary Color', varName: '--primary-color', type: 'color' },
        { name: 'Secondary Color', varName: '--secondary-color', type: 'color' },
        { name: 'Background Color', varName: '--background-color', type: 'color' },
        { name: 'Surface Color', varName: '--surface-color', type: 'color' },
        { name: 'Text Color', varName: '--text-color', type: 'color' },
        { name: 'Border Color', varName: '--border-color', type: 'color' },
    ];

    editableVars.forEach(item => {
        const currentLiveValue = getComputedStyle(document.documentElement).getPropertyValue(item.varName).trim();
        const inputValue = currentThemeSettings[item.varName] || currentLiveValue;
        html += `
            <div style="margin-bottom: 0.5em;">
                <label for="theme-${item.varName}" style="display:inline-block; width:150px;">${item.name}:</label>
                <input type="${item.type}" id="theme-${item.varName}" data-css-var="${item.varName}" value="${inputValue}" style="vertical-align:middle;">
            </div>
        `;
    });
    html += '<button type="button" id="save-theme-settings" class="button-primary" style="margin-top:1em;">Save Theme Settings</button>';
    return html;
}