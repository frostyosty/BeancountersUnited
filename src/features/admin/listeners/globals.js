import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { useAppStore } from '@/store/appStore.js';
import { supabase } from '@/supabaseClient.js';
import { showCustomerCRMModal, showEditItemModal, showImageEditorModal, showAddPastOrderModal } from '../modals/index.js';


export function attachGlobalHandlers() {
    // --- 1. Order/Client Row Click ---
    window.handleOrderRowClick = (userId, manualNameOverride = null) => {
        const event = window.event; 
        const target = event.target;
        // Don't trigger if clicking a button inside the row
        if (target.closest('button')) return;

        if (!userId || userId === 'null' || userId === 'undefined') { 
            uiUtils.showToast("Guest order - no history available.", "info"); 
            return; 
        }
        showCustomerCRMModal(userId, manualNameOverride);
    };

    // --- 2. Menu Item Row Click (The Missing Fix) ---
    window.handleItemRowClick = (itemId) => {
        const event = window.event;
        const target = event.target;
        // Don't trigger if clicking the image or a button
        if (target.closest('button') || target.closest('img') || target.closest('.admin-item-thumb')) return;

        const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
        if (item) showEditItemModal(item);
    };

    // --- 3. Menu Item Photo Click ---
    window.handleItemPhotoClick = (itemId) => {
        const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
        if (item) showImageEditorModal(item);
    };

    // --- 4. Merge Client ---
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
    
    // --- 5. Add Past Order ---
    window.showAddPastOrderModal = (prefillProfile = null) => {
        showAddPastOrderModal(prefillProfile);
    };
}