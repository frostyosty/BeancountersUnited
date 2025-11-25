// src/features/admin/adminListeners.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import Sortable from 'sortablejs';
import { showCustomerCRMModal, showEditItemModal, showEditUserModal } from './adminModals.js';

export let currentSort = { column: 'category', direction: 'asc' };

// --- UTILITY: Debounce ---
function debounce(func, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, delay);
    };
}

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

    // =========================================================
    // 1. CLICK DELEGATION
    // =========================================================
    container.addEventListener('click', async (e) => {
        const target = e.target;

        // Item Actions
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

        // User Actions
        if (target.closest('.edit-user-btn')) {
            const userId = target.closest('tr').dataset.userId;
            const user = useAppStore.getState().admin.users.find(u => u.id === userId);
            if (user) showEditUserModal(user);
        }

        // Sorting
        if (target.closest('.sortable')) {
            const col = target.closest('.sortable').dataset.sortCol;
            currentSort.direction = (currentSort.column === col && currentSort.direction === 'asc') ? 'desc' : 'asc';
            currentSort.column = col;
            useAppStore.getState().ui.triggerPageRender();
        }

        // Category Actions
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
        
        // Clear Logo/BG Buttons
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
    });

    // =========================================================
    // 2. AUTOSAVE LOGIC
    // =========================================================
    
  const saveFunctions = {
        globalSettings: async (form) => {
            const formData = new FormData(form);
            const { data: { session } } = await supabase.auth.getSession();
            
            // Need current settings to preserve existing About Us content (title/text)
            const currentSettings = useAppStore.getState().siteSettings.settings;
            const currentAbout = currentSettings.aboutUs || {};

            const settingsUpdate = { 
                websiteName: formData.get('websiteName'), 
                hamburgerMenuContent: formData.get('hamburgerMenuContent'),
                showAllergens: formData.get('showAllergens') === 'on',
                logoUrl: currentSettings.logoUrl, // Preserve unless changed via upload handler
                
                // NEW: Merge enabled status with existing content
                aboutUs: {
                    ...currentAbout,
                    enabled: formData.get('enableAboutUs') === 'on'
                }
            };
            
            await api.updateSiteSettings(settingsUpdate, session.access_token); uiUtils.updateSiteTitles(settingsUpdate.websiteName, null);
            uiUtils.showToast('Settings saved.', 'success', 1000);
        },
        
        ownerPermissions: async (form) => {
            const permissions = {
                canEditTheme: form.canEditTheme.checked,
                canEditCategories: form.canEditCategories.checked,
            };
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateSiteSettings({ ownerPermissions: permissions }, session.access_token);
            uiUtils.showToast('Permissions saved.', 'success', 1000);
        },

        headerLayout: async (form) => {
            const formData = new FormData(form);
            const headerSettings = {
                logoAlignment: formData.get('logoAlignment'),
                hamburgerPosition: formData.get('hamburgerPosition')
            };
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateSiteSettings({ headerSettings }, session.access_token);
            uiUtils.applyHeaderLayout(headerSettings);
            uiUtils.showToast('Header saved.', 'success', 1000);
        },

        paymentSettings: async (form) => {
            const formData = new FormData(form);
            const paymentConfig = {
                enableCash: true,
                enableStripe: formData.get('enableStripe') === 'on',
                maxCashAmount: parseInt(formData.get('maxCashAmount'), 10) || 0,
                maxCashItems: parseInt(formData.get('maxCashItems'), 10) || 0
            };
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateSiteSettings({ paymentConfig }, session.access_token);
            uiUtils.showToast('Payment saved.', 'success', 1000);
        },

        visualTheme: async () => {
            const themeVariables = {};
            container.querySelectorAll('[data-css-var]').forEach(input => {
                themeVariables[input.dataset.cssVar] = input.value;
            });
            const fontSelect = document.getElementById('font-selector');
            if (fontSelect) themeVariables['--font-family-main-name'] = fontSelect.value;

            const { data: { session } } = await supabase.auth.getSession();
            await useAppStore.getState().siteSettings.updateSiteSettings({ themeVariables }, session.access_token);
            uiUtils.showToast('Theme saved.', 'success', 1000);
        },

        appearanceSettings: async (form) => {
            const formData = new FormData(form);
            const { data: { session } } = await supabase.auth.getSession();
            const { settings } = useAppStore.getState().siteSettings;

            const uiConfig = {
                pageTransition: formData.get('pageTransition'),
                staggerMenu: formData.get('staggerMenu') === 'on',
                // New BG Settings
                backgroundType: formData.get('backgroundType'),
                bgParallax: formData.get('bgParallax') === 'on',
                bgAnimation: formData.get('bgAnimation') === 'on'
            };
            
            // Save Theme Variables (Color)
            const themeVariables = { ...settings.themeVariables };
            container.querySelectorAll('[data-css-var]').forEach(input => {
                themeVariables[input.dataset.cssVar] = input.value;
            });

            // Save
            await api.updateSiteSettings({ uiConfig, themeVariables }, session.access_token);
            
            // Update Live View
            // We merge the new settings locally to apply them immediately
            const updatedSettings = { ...settings, uiConfig, themeVariables };
            uiUtils.applyGlobalBackground(updatedSettings);
            
            uiUtils.showToast('Appearance saved.', 'success', 1000);
        }
    };

    const debouncedSave = {
        global: debounce(saveFunctions.globalSettings, 800),
        payment: debounce(saveFunctions.paymentSettings, 800),
        theme: debounce(saveFunctions.visualTheme, 800)
    };

    // --- INPUT LISTENER ---
    container.addEventListener('input', (e) => {
        const target = e.target;
        const form = target.closest('form');

        if (form?.id === 'global-settings-form' && target.type === 'text') debouncedSave.global(form);
        if (form?.id === 'payment-settings-form' && target.type === 'number') debouncedSave.payment(form);
        
        if (target.matches('[data-css-var]')) {
            document.documentElement.style.setProperty(target.dataset.cssVar, target.value);
            debouncedSave.theme();
        }
    });

    // --- CHANGE LISTENER ---
 container.addEventListener('change', async (e) => {
        const target = e.target;
        const form = target.closest('form');

        // 1. Background Type Switching (Show/Hide Inputs)
        if (target.name === 'backgroundType') {
            // Hide all
            container.querySelectorAll('.bg-control-group').forEach(el => el.style.display = 'none');
            // Show selected
            const type = target.value; // color, image, pattern
            const el = document.getElementById(`bg-ctrl-${type}`);
            if (el) el.style.display = 'block';
            
            // Auto-save logic handled below
        }

        // Logo Upload
        if (target.id === 'logo-upload') {
            const file = target.files[0];
            if (file) {
                uiUtils.showToast("Uploading logo...", "info");
                try {
                    const url = await uploadLogo(file);
                    const { data: { session } } = await supabase.auth.getSession();
                    await api.updateSiteSettings({ logoUrl: url }, session.access_token);
                    document.getElementById('logo-preview').src = url;
                    document.getElementById('logo-preview').style.display = 'inline-block';
                    document.getElementById('no-logo-text').style.display = 'none';
                    document.getElementById('clear-logo-btn').style.display = 'inline-block';
                    uiUtils.showToast("Logo saved.", "success");
                } catch (err) { uiUtils.showToast("Upload failed.", "error"); }
            }
            return;
        }

        // BG Upload
        if (target.id === 'bg-upload') {
            const file = target.files[0];
            if (file) {
                uiUtils.showToast("Uploading background...", "info");
                try {
                    const url = await uploadLogo(file);
                    const { data: { session } } = await supabase.auth.getSession();
                    const { settings } = useAppStore.getState().siteSettings;
                    const newTheme = { ...settings.themeVariables, '--body-background-image': `url('${url}')` };
                    await api.updateSiteSettings({ themeVariables: newTheme }, session.access_token);
                    document.documentElement.style.setProperty('--body-background-image', `url('${url}')`);
                    document.getElementById('bg-preview').src = url;
                    document.getElementById('bg-preview').style.display = 'block';
                    document.getElementById('clear-bg-btn').style.display = 'inline-block';
                    uiUtils.showToast("Background saved.", "success");
                } catch (err) { uiUtils.showToast("Upload failed.", "error"); }
            }
            return;
        }

        // Font Selection
        if (target.id === 'font-selector') {
            uiUtils.applySiteFont(target.value);
            saveFunctions.visualTheme();
            return;
        }

        // Form Autosaves
        if (form?.id === 'global-settings-form') saveFunctions.globalSettings(form);
        if (form?.id === 'owner-permissions-form') saveFunctions.ownerPermissions(form);
        if (form?.id === 'header-settings-form') saveFunctions.headerLayout(form);
        if (form?.id === 'payment-settings-form') saveFunctions.paymentSettings(form);
        if (form?.id === 'appearance-settings-form') saveFunctions.appearanceSettings(form);
    
    });

    container.dataset.listenersAttached = 'true';
}

// --- SORTABLE ---
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

// --- GLOBAL CLICK HANDLER ---
window.handleOrderRowClick = (userId) => {
    const event = window.event; 
    const target = event.target;
    if (target.closest('button')) return;
    if (!userId || userId === 'null' || userId === 'undefined') { uiUtils.showToast("Guest order - no history available.", "info"); return; }
    showCustomerCRMModal(userId);
};