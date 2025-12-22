import { attachEventHandlers } from './handlers/handlers.js';
import { attachGlobalHandlers } from './globals.js';
import { initializeSortable } from './sortable.js';
export { currentSort, adminState } from './state.js';
export { initializeSortable };

// The main function called by dashboard UI
export function attachOwnerDashboardListeners() {
    const container = document.querySelector('.dashboard-container');
    if (!container) return;

    // Attach DOM events
    attachEventHandlers(container);
    
    // Attach Global Window Handlers
    attachGlobalHandlers();
}