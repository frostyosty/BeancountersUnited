import { saveFunctions } from '../saveActions.js';

export function attachSubmitHandlers(container) {
    container.addEventListener('submit', async (e) => {
        if (e.target.id === 'dashboard-layout-form') {
            e.preventDefault();
            saveFunctions.dashboardLayout(e.target);
        }
    });
}