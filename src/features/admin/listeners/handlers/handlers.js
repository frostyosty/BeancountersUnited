import { attachClickHandlers } from './clickHandlers.js';
import { attachInputHandlers } from './inputHandlers.js';
import { attachChangeHandlers } from './changeHandlers.js';
import { attachSubmitHandlers } from './submitHandlers.js';
import { attachGlobalHandlers } from '../globals.js';
import { initializeSortable } from '../sortable.js';

export { currentSort, adminState } from '../state.js';
export { initializeSortable };

export function attachOwnerDashboardListeners() {
    const container = document.querySelector('.dashboard-container');
    if (!container) return;

    // Attach all event listeners
    attachClickHandlers(container);
    attachInputHandlers(container);
    attachChangeHandlers(container);
    attachSubmitHandlers(container);
    
    // Attach Global Window Handlers
    attachGlobalHandlers();
    
    // Mark as attached
    container.dataset.listenersAttached = 'true';
}