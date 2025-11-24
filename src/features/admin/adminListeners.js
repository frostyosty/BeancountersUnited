// src/features/admin/adminListeners.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
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

export function attachOwnerDashboardListeners() {
    const container = document.querySelector('.dashboard-container');
    if (!container || container.dataset.listenersAttached) return;

    // 1. CLICK DELEGATION
    container.addEventListener('click', async (e) => {
        const target = e.target;

        // --- Item Management ---
        if (target.closest('.edit-item-btn-table')) {
            const itemId = target.closest('tr').dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (item) showEditItemModal(item);
        }
        if (target.closest('#add-new-item-btn')) {
            showEditItemModal(null);
        }
        if (target.closest('.delete-icon-btn')) {
            const itemId = target.closest('tr').dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (confirm(`Delete "${item?.name}"?`)) {
                const { data: { session } } = await supabase.auth.getSession();
                await useAppStore.getState().menu.deleteMenuItemOptimistic(itemId, session.access_token);
            }
        }

        // --- User Management ---
        if (target.closest('.edit-user-btn')) {
            const userId = target.closest('tr').dataset.userId;
            const user = useAppStore.getState().admin.users.find(u => u.id === userId);
            if (user) showEditUserModal(user);
        }

        // --- Sorting ---
        if (target.closest('.sortable')) {
            const col = target.closest('.sortable').dataset.sortCol;
            currentSort.direction = (currentSort.column === col && currentSort.direction === 'asc') ? 'desc' : 'asc';
            currentSort.column = col;
            useAppStore.getState().ui.triggerPageRender();
        }

        // --- Category Delete ---
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
    });

    // 2. FORM SUBMITS
    container.addEventListener('submit', async (e) => {
        const target = e.target;
        const { data: { session } } = await supabase.auth.getSession();

        // --- A. Global Settings (Logo/Name/Allergens) ---
        if (target.matches('#global-settings-form')) {
            e.preventDefault();
            const btn = target.querySelector('button');
            btn.textContent = "Saving...";
            btn.disabled = true;
            
            const formData = new FormData(target);
            const logoFile = formData.get('logoFile');
            let finalLogoUrl = formData.get('logoUrl'); // Start with existing URL

            try {
                // Upload new logo if provided
                if (logoFile && logoFile.size > 0) {
                    finalLogoUrl = await uploadLogo(logoFile);
                }
                
                // Construct update object AFTER logo logic
                const settingsUpdate = { 
                    websiteName: formData.get('websiteName'), 
                    hamburgerMenuContent: formData.get('hamburgerMenuContent'),
                    showAllergens: formData.get('showAllergens') === 'on', 
                    logoUrl: finalLogoUrl 
                };

                await api.updateSiteSettings(settingsUpdate, session.access_token);
                uiUtils.updateSiteTitles(settingsUpdate.websiteName, finalLogoUrl);
                uiUtils.showToast('Global settings saved!', 'success');
                useAppStore.getState().siteSettings.fetchSiteSettings(); // Refresh state
            } catch(err) {
                console.error(err);
                uiUtils.showToast("Error: " + err.message, "error");
            } finally {
                btn.textContent = "Save Global Settings";
                btn.disabled = false;
            }
        }

        // --- B. Owner Permissions ---
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

        // --- C. Header Settings ---
        if (target.matches('#header-settings-form')) {
            e.preventDefault();
            const formData = new FormData(target);
            const headerSettings = {
                logoAlignment: formData.get('logoAlignment'),
                hamburgerPosition: formData.get('hamburgerPosition')
            };
            await api.updateSiteSettings({ headerSettings }, session.access_token);
            uiUtils.showToast('Header layout saved.', 'success');
            uiUtils.applyHeaderLayout(headerSettings);
        }

        // --- D. Payment Settings ---
        if (target.matches('#payment-settings-form')) {
            e.preventDefault(); // CRITICAL: Must be first
            console.log("[Listeners] Payment Settings Submit caught.");

            const btn = target.querySelector('button');
            btn.textContent = "Saving...";
            btn.disabled = true;

            try {
                const formData = new FormData(target);
                const paymentConfig = {
                    enableCash: true,
                    enableStripe: formData.get('enableStripe') === 'on',
                    maxCashAmount: parseInt(formData.get('maxCashAmount'), 10),
                    maxCashItems: parseInt(formData.get('maxCashItems'), 10)
                };
                
                await api.updateSiteSettings({ paymentConfig }, session.access_token);
                uiUtils.showToast('Payment rules saved.', 'success');
            } catch (error) {
                console.error("Payment Save Failed:", error);
                uiUtils.showToast("Save failed: " + error.message, "error");
            } finally {
                btn.textContent = "Save Payment Rules";
                btn.disabled = false;
            }
        }
    });

    // Add Category Button
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
            await api.updateSiteSettings({ menuCategories: [...currentCats, newCat] }, session.access_token);
            input.value = '';
            uiUtils.showToast('Category added.', 'success');
        }
    });

    // Live Previews
    container.addEventListener('input', (e) => {
        if (e.target.matches('[data-css-var]')) {
            document.documentElement.style.setProperty(e.target.dataset.cssVar, e.target.value);
        }
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

export function initializeSortable() {
    const list = document.getElementById('category-list');
    if (!list || list.dataset.sortableInitialized === 'true') return;
    
    new Sortable(list, { 
        animation: 150, 
        handle: '.drag-handle-wrapper', 
        onEnd: async (evt) => {
            const items = Array.from(list.children);
            const newOrder = items.map(li => li.dataset.categoryName);
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateSiteSettings({ menuCategories: newOrder }, session.access_token);
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