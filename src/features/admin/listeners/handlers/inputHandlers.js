import { debounce } from './helpers.js';
import { saveFunctions } from './saveActions.js';

export function attachInputHandlers(container) {
    
    // Create debounced instances once per load
    const debouncedSave = {
        global: debounce(saveFunctions.globalSettings, 800),
        payment: debounce(saveFunctions.paymentSettings, 800),
        theme: debounce(saveFunctions.visualTheme, 800)
    };

    container.addEventListener('input', (e) => {
        const target = e.target;
        const form = target.closest('form');

        // Debounced Saves
        if (form?.id === 'global-settings-form' && target.type === 'text') debouncedSave.global(form);
        if (form?.id === 'payment-settings-form' && target.type === 'number') debouncedSave.payment(form);
        
        // Live Theme Preview
        if (target.matches('[data-css-var]')) {
            document.documentElement.style.setProperty(target.dataset.cssVar, target.value);
            debouncedSave.theme();
        }

        // Client Search (Immediate)
        if (e.target.id === 'client-search') {
            const term = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#client-table-body tr');
            rows.forEach(row => {
                const text = row.innerText.toLowerCase();
                row.style.display = text.includes(term) ? '' : 'none';
            });
        }
    });
}