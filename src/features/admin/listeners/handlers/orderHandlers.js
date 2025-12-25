import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';

export async function handleOrderClicks(target) {
    // Manual Order Modal
    if (target.id === 'btn-manual-order') {
        import('@/features/user/orderHistoryUI.js').then(m => m.showManualOrderModal());
    }

    // Archive Toggles
    if (target.id === 'toggle-archive-btn') {
        const container = document.getElementById('archive-table-container');
        const isHidden = container.style.display === 'none';
        container.style.display = isHidden ? 'block' : 'none';
        target.textContent = isHidden ? 'Hide Archive' : 'Show Archive';
    }

    // Archive Settings
    if (target.id === 'btn-archive-settings') {
         const { settings } = useAppStore.getState().siteSettings;
         import('@/features/user/orderHistoryUI.js').then(m => m.showArchiveSettingsModal(settings.archiveSettings || {}));
    }

    // Row Actions (Dismiss/Delete)
    if (target.classList.contains('action-btn')) {
        const btn = target;
        const orderId = btn.closest('tr').dataset.orderId;
        const action = btn.dataset.action;
        const name = btn.dataset.name;
        const total = btn.dataset.total;

        if (action === 'dismiss') {
            useAppStore.getState().orderHistory.dismissOrder(orderId);
            uiUtils.showToast(`Dismissed ${name}'s ${total} Order`, "info");
        } 
        else if (action === 'delete') {
             const { error } = await supabase.from('mealmates_orders').delete().eq('id', orderId);
             if (!error) {
                 uiUtils.showToast("Deleted.", "success");
                 useAppStore.getState().orderHistory.fetchOrderHistory(true);
             } else {
                 uiUtils.showToast("Delete failed.", "error");
             }
        }
    }
}