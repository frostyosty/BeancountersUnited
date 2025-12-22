// src/features/admin/listeners/index.js

// Simply re-export the main function and state from your aggregator
export { 
    attachOwnerDashboardListeners, 
    currentSort, 
    adminState, 
    initializeSortable 
} from './handlers/handlers.js';