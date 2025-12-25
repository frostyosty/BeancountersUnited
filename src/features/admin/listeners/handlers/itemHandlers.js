import { useAppStore } from '@/store/appStore.js';
import { supabase } from '@/supabaseClient.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { showEditItemModal } from '@/features/admin/modals/index.js'; 

export async function handleItemClicks(target) {
    // Edit Item
    if (target.closest('.edit-item-btn-table')) {
        const itemId = target.closest('tr').dataset.itemId;
        const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
        if (item) showEditItemModal(item);
    }
    // Add Item
    if (target.closest('#add-new-item-btn')) showEditItemModal(null);
    
    // Delete Item
    if (target.closest('.delete-icon-btn')) {
        const itemId = target.closest('tr').dataset.itemId;
        const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
        if (confirm(`Delete "${item?.name}"?`)) {
            const { data: { session } } = await supabase.auth.getSession();
            await useAppStore.getState().menu.deleteMenuItemOptimistic(itemId, session.access_token);
        }
    }

    // Add Category
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

    // Delete Category
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
}