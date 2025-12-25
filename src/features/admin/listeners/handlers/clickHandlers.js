import { useAppStore } from '@/store/appStore.js';
import { showEditUserModal } from '@/features/admin/modals/index.js'; 
import { currentSort, adminState } from '../state.js';

// Import sub-handlers
import { handleItemClicks } from './itemHandlers.js';
import { handleConfigClicks } from './configHandlers.js';
import { handleOrderClicks } from './orderHandlers.js';

export function attachClickHandlers(container) {
    container.addEventListener('click', async (e) => {
        const target = e.target;

        // Core Dashboard Nav (Keep here as it's simple)
        if (target.classList.contains('admin-tab-btn')) {
            adminState.activeTab = target.dataset.tab;
            useAppStore.getState().ui.triggerPageRender(); 
        }

        // Sorting (Keep here)
        if (target.closest('.sortable')) {
            const col = target.closest('.sortable').dataset.sortCol;
            currentSort.direction = (currentSort.column === col && currentSort.direction === 'asc') ? 'desc' : 'asc';
            currentSort.column = col;
            useAppStore.getState().ui.triggerPageRender();
        }

        // User Edit (Simple enough to keep or move)
        if (target.closest('.edit-user-btn')) {
            const userId = target.closest('tr').dataset.userId;
            const user = useAppStore.getState().admin.users.find(u => u.id === userId);
            if (user) showEditUserModal(user);
        }

        // Dispatch to sub-handlers
        await handleItemClicks(target);
        await handleConfigClicks(target);
        await handleOrderClicks(target);
    });
}