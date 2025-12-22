import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { warper } from '@/utils/ui/imageMorph.js';

// --- FIX: Use Absolute Imports (@) to avoid path errors ---
import { showEditItemModal, showEditUserModal } from '@/features/admin/modals/index.js'; 
import { openHeaderLogoEditor } from '@/features/admin/headerEditor/index.js';
// Import siblings from the listeners folder
import { currentSort, adminState } from '@/features/admin/listeners/state.js';

export function attachClickHandlers(container) {
    container.addEventListener('click', async (e) => {
        const target = e.target;

        // --- TABS & NAVIGATION ---
        if (target.classList.contains('admin-tab-btn')) {
            adminState.activeTab = target.dataset.tab;
            useAppStore.getState().ui.triggerPageRender(); 
        }

        // --- MENU ITEM ACTIONS ---
        if (target.closest('.edit-item-btn-table')) {
            const itemId = target.closest('tr').dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (item) showEditItemModal(item);
        }
        if (target.closest('#add-new-item-btn')) showEditItemModal(null);
        
        if (target.closest('.delete-icon-btn')) {
            const itemId = target.closest('tr').dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (confirm(`Delete "${item?.name}"?`)) {
                const { data: { session } } = await supabase.auth.getSession();
                await useAppStore.getState().menu.deleteMenuItemOptimistic(itemId, session.access_token);
            }
        }

        // --- USER ACTIONS ---
        if (target.closest('.edit-user-btn')) {
            const userId = target.closest('tr').dataset.userId;
            const user = useAppStore.getState().admin.users.find(u => u.id === userId);
            if (user) showEditUserModal(user);
        }

        // --- SORTING ---
        if (target.closest('.sortable')) {
            const col = target.closest('.sortable').dataset.sortCol;
            currentSort.direction = (currentSort.column === col && currentSort.direction === 'asc') ? 'desc' : 'asc';
            currentSort.column = col;
            useAppStore.getState().ui.triggerPageRender();
        }

        // --- CATEGORY ACTIONS ---
        if(target.matches('#add-category-btn')) {
            const input = document.getElementById('new-category-name');
            const newCat = input.value.trim();
            if (!newCat) return;
            const { settings } = useAppStore.getState().siteSettings;
            const currentCats = settings.menuCategories || [];
            if (currentCats.includes(newCat)) { uiUtils.showToast('Category exists.', 'error'); return; }
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateSiteSettings({ menuCategories: [...currentCats, newCat] }, session.access_token);
            input.value = '';
            uiUtils.showToast('Category added.', 'success');
        }

        if (target.closest('.delete-category-btn')) {
            const catToDelete = target.closest('.category-list-item').dataset.categoryName;
            if (confirm(`Delete category "${catToDelete}"?`)) {
                const { settings } = useAppStore.getState().siteSettings;
                const newCats = (settings.menuCategories || []).filter(c => c !== catToDelete);
                const { data: { session } } = await supabase.auth.getSession();
                await api.updateSiteSettings({ menuCategories: newCats }, session.access_token);
                uiUtils.showToast('Category deleted.', 'success');
            }
        }
        
        // --- ASSET MANAGEMENT ---
        if (target.matches('#clear-logo-btn')) {
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateSiteSettings({ logoUrl: '' }, session.access_token);
            uiUtils.updateSiteTitles(null, '');
            useAppStore.getState().siteSettings.fetchSiteSettings();
            uiUtils.showToast('Logo removed.', 'success');
        }
        
        if (target.matches('#clear-bg-btn')) {
             const { data: { session } } = await supabase.auth.getSession();
             const { settings } = useAppStore.getState().siteSettings;
             const newTheme = { ...settings.themeVariables, '--body-background-image': 'none' };
             await api.updateSiteSettings({ themeVariables: newTheme }, session.access_token);
             document.documentElement.style.setProperty('--body-background-image', 'none');
             document.getElementById('bg-preview').style.display = 'none';
             target.style.display = 'none';
             uiUtils.showToast("Background removed.", "success");
        }

        // --- TOOLS ---
        if (target.id === 'open-header-creator-btn') {
            openHeaderLogoEditor();
        }
        
        if (target.id === 'btn-test-warp') {
            const img = document.getElementById('warp-test-target');
            const current = img.getAttribute('src');
            const next = current.includes('coffee') ? '/placeholder-burger.jpg' : '/placeholder-coffee.jpg';
            
            const speedInput = document.querySelector('input[name="warpSpeed"]');
            const blockInput = document.querySelector('input[name="warpBlock"]');
            
            const config = {
                duration: speedInput ? parseInt(speedInput.value) : 30,
                blockSize: blockInput ? parseInt(blockInput.value) : 2
            };

            uiUtils.showToast(`Warping...`, "info");
            warper.warp(img, next, config);
        }

        // --- ORDER MANAGEMENT ---
        if (target.id === 'btn-manual-order') {
            import('@/features/user/orderHistoryUI.js').then(m => m.showManualOrderModal());
        }

        if (target.id === 'toggle-archive-btn') {
            const container = document.getElementById('archive-table-container');
            const isHidden = container.style.display === 'none';
            container.style.display = isHidden ? 'block' : 'none';
            target.textContent = isHidden ? 'Hide Archive' : 'Show Archive';
        }

        if (target.id === 'btn-archive-settings') {
             const { settings } = useAppStore.getState().siteSettings;
             import('@/features/user/orderHistoryUI.js').then(m => m.showArchiveSettingsModal(settings.archiveSettings || {}));
        }

        // --- HISTORY & LOCATION ---
        if (target.classList.contains('restore-btn')) {
            const logId = target.dataset.logId;
            if (confirm("Revert settings to this point?")) {
                const { data: { session } } = await supabase.auth.getSession();
                try {
                    await fetch('/api/settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
                        body: JSON.stringify({ logId })
                    });
                    uiUtils.showToast("Restored!", "success");
                    window.location.reload(); 
                } catch(e) { uiUtils.showToast("Restore Error", "error"); }
            }
        }

        if (target.id === 'btn-get-cafe-location') {
             if (!navigator.geolocation) return uiUtils.showToast("Geolocation not supported", "error");
             navigator.geolocation.getCurrentPosition(
                (pos) => {
                    document.getElementById('input-cafe-lat').value = pos.coords.latitude;
                    document.getElementById('input-cafe-lng').value = pos.coords.longitude;
                    document.getElementById('cafe-coords-display').textContent = "Updated. Click Save.";
                }
             );
        }

        // --- ROW ACTIONS ---
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
    });
}