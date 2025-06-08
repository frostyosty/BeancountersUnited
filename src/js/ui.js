// ui.js
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
const closeModalButton = document.querySelector('.close-button');
const appContent = document.getElementById('app-content');
const loadingSpinner = document.getElementById('loading-spinner');

const ui = {
    showModal: (content) => {
        modalBody.innerHTML = content;
        modal.style.display = 'block';
    },
    closeModal: () => {
        modal.style.display = 'none';
        modalBody.innerHTML = '';
    },
    renderPage: (htmlContent) => {
        appContent.innerHTML = htmlContent;
    },
    setLoading: (isLoading) => {
        if (isLoading) {
            appContent.innerHTML = ''; // Clear content
            loadingSpinner.style.display = 'block';
        } else {
            loadingSpinner.style.display = 'none';
        }
    },
    updateCartCount: (count) => {
        document.getElementById('cart-count').textContent = count;
    },
    updateSiteTitles: (newName) => {
        document.getElementById('site-title').textContent = newName;
        document.getElementById('site-title-footer').textContent = newName;
        document.title = newName;
    },
    applyTheme: (themeCssFile) => {
        document.getElementById('theme-stylesheet').href = themeCssFile;
    },
    getThemeControlsHTML: (currentSettings) => {
        // currentSettings expected to be like { primaryColor: '#hex', bgColor: '#hex', ... }
        // This is a simplified example. A real theme editor would be more complex.
        let html = '<h3>Theme Customizer (CSS Variables)</h3>';
        const editableVars = [
            { name: 'Primary Color', var: '--primary-color', type: 'color' },
            { name: 'Background Color', var: '--bg-color', type: 'color' },
            { name: 'Text Color', var: '--text-color', type: 'color' },
            { name: 'Accent Color', var: '--accent-color', type: 'color' },
        ];

        editableVars.forEach(item => {
            // Get current computed value for the variable to set as default in color picker
            const currentVal = getComputedStyle(document.documentElement).getPropertyValue(item.var).trim();
            html += `
                <div>
                    <label for="theme-${item.var}">${item.name}:</label>
                    <input type="${item.type}" id="theme-${item.var}" data-css-var="${item.var}" value="${currentSettings?.[item.var.substring(2)] || currentVal}">
                </div>
            `;
        });
        html += '<button id="save-theme-settings">Save Theme Settings</button>';
        html += '<p><em>Note: Theme settings are applied live. Save persists them.</em></p>';
        return html;
    },
    updateCssVariable: (varName, value) => {
        document.documentElement.style.setProperty(varName, value);
    }
};

closeModalButton?.addEventListener('click', ui.closeModal);
window.addEventListener('click', (event) => {
    if (event.target === modal) {
        ui.closeModal();
    }
});

// Make ui globally accessible or export as a module
window.ui = ui;