import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { useAppStore } from '@/store/appStore.js';
import { supabase } from '@/supabaseClient.js';
import { showCustomerCRMModal, showEditItemModal,showAddPastOrderModal } from '../modals/index.js';


export function attachGlobalHandlers() {
    window.handleOrderRowClick = (userId, manualNameOverride = null) => {
        const event = window.event; 
        const target = event.target;
        if (target.closest('button')) return;

        if (!userId || userId === 'null' || userId === 'undefined') { 
            uiUtils.showToast("Guest order - no history available.", "info"); 
            return; 
        }
        showCustomerCRMModal(userId, manualNameOverride);
    };

    window.handleItemPhotoClick = (itemId) => {
        import('../modals/index.js').then(m => {
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (item) m.showImageEditorModal(item);
        });
    };

    window.handleMergeClick = (sourceId) => {
        const targetId = prompt("Enter the User ID (UUID) of the CLIENT you want to keep:");
        if (!targetId) return;
        if (sourceId === targetId) { alert("Cannot merge into self."); return; }

        if (confirm("Merge clients? This cannot be undone.")) {
            api.request('/user?type=merge_clients', 'POST', { sourceId, targetId }, useAppStore.getState().auth.session?.access_token)
                .then(() => {
                    uiUtils.showToast("Merged.", "success");
                    useAppStore.getState().admin.fetchClients();
                })
                .catch(err => uiUtils.showToast(err.message, "error"));
        }
    };
    
    // Add Past Order Handler - We import this logic from adminListeners or define it here
    window.showAddPastOrderModal = (prefillProfile = null) => {
        // ... (Paste the showAddPastOrderModal logic here if you want it modular, 
        // OR import it if you defined it elsewhere. 
        // Best to define it in 'adminModals.js' and import/export it from there)
    };
}