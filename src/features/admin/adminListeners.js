// src/features/admin/adminListeners.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js'; // Added api import
import { supabase } from '@/supabaseClient.js';
import Sortable from 'sortablejs';
import { showCustomerCRMModal, showEditItemModal, showEditUserModal } from './adminModals.js';

export let currentSort = { column: 'category', direction: 'asc' };

// --- HELPER: Logo Upload ---
async function uploadLogo(file) {
    const fileExt = file.name.split('.').pop();
    const fileName = `logos/site-logo-${Date.now()}.${fileExt}`;
    const { error } = await supabase.storage.from('menu-images').upload(fileName, file);
    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from('menu-images').getPublicUrl(fileName);
    return data.publicUrl;
}


// --- MAIN LISTENER FUNCTION ---
export function attachOwnerDashboardListeners() {
    const container = document.querySelector('.dashboard-container');
    if (!container || container.dataset.listenersAttached) return;

    // 1. CLICKS
    container.addEventListener('click', async (e) => {
        const target = e.target;

        // --- User Management: Edit User ---
        if (target.closest('.edit-user-btn')) {
            const tr = target.closest('tr');
            const userId = tr.dataset.userId;
            const user = useAppStore.getState().admin.users.find(u => u.id === userId);
            if (user) showEditUserModal(user);
        }

        // --- Edit Item ---
        if (target.closest('.edit-item-btn-table')) {
            const tr = target.closest('tr');
            const itemId = tr.dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (item) showEditItemModal(item);
        }

        // --- Add Item ---
        if (target.closest('#add-new-item-btn')) {
            showEditItemModal(null);
        }

        // --- Delete Item ---
        if (target.closest('.delete-icon-btn')) {
            const tr = target.closest('tr');
            const itemId = tr.dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);

            if (confirm(`Delete "${item?.name}"?`)) {
                try {
                    const { data: { session } } = await supabase.auth.getSession();
                    if (!session) throw new Error("Not authenticated");
                    await useAppStore.getState().menu.deleteMenuItemOptimistic(itemId, session.access_token);
                    uiUtils.showToast(`${item.name} deleted.`, 'success');
                } catch (error) {
                    uiUtils.showToast("Delete failed.", "error");
                }
            }
        }

        // --- Sorting ---
        if (target.closest('.sortable')) {
            const th = target.closest('.sortable');
            const col = th.dataset.sortCol;
            if (currentSort.column === col) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.column = col;
                currentSort.direction = 'asc';
            }
            useAppStore.getState().ui.triggerPageRender();
        }

        // --- Delete Category ---
        if (target.closest('.delete-category-btn')) {
            const li = target.closest('.category-list-item');
            const catToDelete = li.dataset.categoryName; // Note: Ensure HTML uses this dataset
            
            if (confirm(`Delete category "${catToDelete}"?`)) {
                const { settings } = useAppStore.getState().siteSettings;
                const newCats = (settings.menuCategories || []).filter(c => c !== catToDelete);
                
                const { data: { session } } = await supabase.auth.getSession();
                await useAppStore.getState().siteSettings.updateSiteSettings({ menuCategories: newCats }, session.access_token);
                uiUtils.showToast('Category deleted.', 'success');
            }
        }

        // --- Save Theme ---
        if (target.matches('#save-theme-settings')) {
            const themeVariables = {};
            container.querySelectorAll('[data-css-var]').forEach(input => {
                themeVariables[input.dataset.cssVar] = input.value;
            });
            const fontSelect = document.getElementById('font-selector');
            if (fontSelect) themeVariables['--font-family-main-name'] = fontSelect.value;

            const { data: { session } } = await supabase.auth.getSession();
            await useAppStore.getState().siteSettings.updateSiteSettings({ themeVariables }, session.access_token);
            uiUtils.showToast('Theme saved!', 'success');
        }
    });

    
    // 2. FORM SUBMITS
    container.addEventListener('submit', async (e) => {
        const target = e.target;
        const { data: { session } } = await supabase.auth.getSession();

        // --- NEW: Global Settings (Logo/Name) ---
        if (target.matches('#global-settings-form')) {
            e.preventDefault();
            const btn = target.querySelector('button');
            btn.textContent = "Saving...";
            
            const formData = new FormData(target);
            const logoFile = formData.get('logoFile');
            let finalLogoUrl = formData.get('logoUrl');

            try {
                if (logoFile && logoFile.size > 0) {
                    finalLogoUrl = await uploadLogo(logoFile);
                }
                
                const settingsUpdate = { 
                    websiteName: formData.get('websiteName'), 
                    hamburgerMenuContent: formData.get('hamburgerMenuContent'),
                    logoUrl: finalLogoUrl 
                };

                await api.updateSiteSettings(settingsUpdate, session.access_token);
                uiUtils.updateSiteTitles(settingsUpdate.websiteName, finalLogoUrl);
                uiUtils.showToast('Global settings saved!', 'success');
            } catch(err) {
                uiUtils.showToast("Error: " + err.message, "error");
            }
            btn.textContent = "Save Site Settings";
        }

        // --- NEW: Owner Permissions ---
        if (target.matches('#owner-permissions-form')) {
            e.preventDefault();
            const form = target;
            const permissions = {
                canEditTheme: form.canEditTheme.checked,
                canEditCategories: form.canEditCategories.checked,
            };
            await api.updateSiteSettings({ ownerPermissions: permissions }, session.access_token);
            uiUtils.showToast('Permissions updated.', 'success');
        }


        // --- Header Settings ---
        if (target.matches('#header-settings-form')) {
            e.preventDefault();
            const formData = new FormData(target);
            const headerSettings = {
                logoAlignment: formData.get('logoAlignment'),
                hamburgerPosition: formData.get('hamburgerPosition')
            };
            await useAppStore.getState().siteSettings.updateSiteSettings({ headerSettings }, session.access_token);
            uiUtils.showToast('Header layout saved.', 'success');
            uiUtils.applyHeaderLayout(headerSettings);
        }

        // --- Payment Settings ---
        if (target.matches('#payment-settings-form')) {
            e.preventDefault();
            const formData = new FormData(target);
            const paymentConfig = {
                enableCash: formData.get('enableCash') === 'on',
                maxCashAmount: parseInt(formData.get('maxCashAmount'), 10),
                maxCashItems: parseInt(formData.get('maxCashItems'), 10)
            };
            await useAppStore.getState().siteSettings.updateSiteSettings({ paymentConfig }, session.access_token);
            uiUtils.showToast('Payment rules saved.', 'success');
        }

        // --- Add Category ---
        // Note: I'm attaching this to the button click inside the category manager usually, 
        // but if you wrapped it in a form, this works. 
        // If not, we handle button click in section 1 above.
        // Let's add specific logic for the "Add" button here just in case:
    });
    
    // Explicit Add Category Button Listener (since it might not be a form)
    container.addEventListener('click', async (e) => {
        if(e.target.matches('#add-category-btn')) {
            const input = document.getElementById('new-category-name');
            const newCat = input.value.trim();
            if (!newCat) return;

            const { settings } = useAppStore.getState().siteSettings;
            const currentCats = settings.menuCategories || [];
            if (currentCats.includes(newCat)) {
                uiUtils.showToast('Category exists.', 'error');
                return;
            }
            const { data: { session } } = await supabase.auth.getSession();
            await useAppStore.getState().siteSettings.updateSiteSettings({ menuCategories: [...currentCats, newCat] }, session.access_token);
            input.value = '';
            uiUtils.showToast('Category added.', 'success');
        }
    });

    // 3. LIVE PREVIEWS
    container.addEventListener('input', (e) => {
        if (e.target.matches('[data-css-var]')) {
            document.documentElement.style.setProperty(e.target.dataset.cssVar, e.target.value);
        }
    });
    container.addEventListener('change', (e) => {
         if (e.target.matches('#font-selector')) uiUtils.applySiteFont(e.target.value);
    });

    const logoInput = document.getElementById('logo-upload');
    if (logoInput) {
        logoInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                document.getElementById('logo-preview').src = URL.createObjectURL(file);
                document.getElementById('logo-preview').style.display = 'inline-block';
                document.getElementById('no-logo-text').style.display = 'none';
                document.getElementById('clear-logo-btn').style.display = 'inline-block';
            }
        });
        // Clear logic...
        document.getElementById('clear-logo-btn')?.addEventListener('click', () => {
            logoInput.value = '';
            document.querySelector('input[name="logoUrl"]').value = '';
            document.getElementById('logo-preview').style.display = 'none';
            document.getElementById('no-logo-text').style.display = 'block';
            document.getElementById('clear-logo-btn').style.display = 'none';
        });
    }

    container.dataset.listenersAttached = 'true';
}

// --- SORTABLE (Drag & Drop) ---
export function initializeSortable() {
    const list = document.getElementById('category-list');
    if (!list || list.dataset.sortableInitialized === 'true') return;
    
    new Sortable(list, { 
        animation: 150, 
        handle: '.drag-handle-wrapper', 
        onEnd: async (evt) => {
            // Reorder Logic
            const items = Array.from(list.children);
            const newOrder = items.map(li => li.dataset.categoryName);
            
            const { data: { session } } = await supabase.auth.getSession();
            // Optimistic update handled by Sortable visually, but we save to DB
            await useAppStore.getState().siteSettings.updateSiteSettings({ menuCategories: newOrder }, session.access_token);
        }
    });
    list.dataset.sortableInitialized = 'true';
}

// --- WINDOW GLOBAL CLICK HANDLER (For CRM) ---
window.handleOrderRowClick = (userId, orderId) => {
    const event = window.event; 
    const target = event.target;
    // Don't open CRM if clicking a button (like 'Done' or 'Refund')
    if (target.closest('button')) return;

    if (!userId || userId === 'null' || userId === 'undefined') {
        uiUtils.showToast("Guest order - no history available.", "info");
        return;
    }
    showCustomerCRMModal(userId);
};