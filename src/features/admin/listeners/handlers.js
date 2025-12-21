import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { showEditItemModal, showEditUserModal } from '../modals/index.js'; 
import { openHeaderLogoEditor } from '../headerEditor/index.js';
import { debounce, uploadLogo } from './helpers.js';
import { saveFunctions } from './saveActions.js';
import { currentSort, adminState } from './state.js';
import { warper } from '../../../utils/uiUtils.js';

export function attachEventHandlers(container) {
    
    // --- 1. CLICKS ---
    container.addEventListener('click', async (e) => {
        const target = e.target;

        // Tab Switching
        if (target.classList.contains('admin-tab-btn')) {
            adminState.activeTab = target.dataset.tab;
            useAppStore.getState().ui.triggerPageRender(); 
        }

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
        
        // Logo/BG Clear
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

        // Header Editor
        if (target.id === 'open-header-creator-btn') {
            openHeaderLogoEditor();
        }
        //warp test
        if (target.id === 'btn-test-warp') {
            const img = document.getElementById('warp-test-target');
            const current = img.getAttribute('src');
            const next = current.includes('coffee') ? '/placeholder-burger.jpg' : '/placeholder-coffee.jpg';
            
            // FIX: Grab live values from inputs
            const speedInput = document.querySelector('input[name="warpSpeed"]');
            const blockInput = document.querySelector('input[name="warpBlock"]');
            
            const config = {
                duration: speedInput ? parseInt(speedInput.value) : 30,
                blockSize: blockInput ? parseInt(blockInput.value) : 2
            };

            uiUtils.showToast(`Warping (Speed: ${config.duration}, Block: ${config.blockSize})`, "info");
            
            // Import warper dynamically to ensure we get the instance
            import('@/utils/ui/imageMorph.js').then(m => {
                m.warper.warp(img, next, config);
            });
        }

        // --- Order Management Buttons ---
        
        // Manual Order
        if (target.id === 'btn-manual-order') {
            import('@/features/user/orderHistoryUI.js').then(m => m.showManualOrderModal()); // We can reuse the modal logic
        }

        // Archive Toggle
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
        // Note: The logic for .action-btn in your current listener might be missing, add this:
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

    // --- 2. INPUTS & CHANGES ---
    const debouncedSave = {
        global: debounce(saveFunctions.globalSettings, 800),
        payment: debounce(saveFunctions.paymentSettings, 800),
        theme: debounce(saveFunctions.visualTheme, 800)
    };

    container.addEventListener('input', (e) => {
        const target = e.target;
        const form = target.closest('form');

        if (form?.id === 'global-settings-form' && target.type === 'text') debouncedSave.global(form);
        if (form?.id === 'payment-settings-form' && target.type === 'number') debouncedSave.payment(form);
        
        if (target.matches('[data-css-var]')) {
            document.documentElement.style.setProperty(target.dataset.cssVar, target.value);
            debouncedSave.theme();
        }
        if (e.target.id === 'client-search') {
            const term = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#client-table-body tr');
            rows.forEach(row => {
                const text = row.innerText.toLowerCase();
                row.style.display = text.includes(term) ? '' : 'none';
            });
        }
    });

    container.addEventListener('change', async (e) => {
        const target = e.target;
        const form = target.closest('form');

        // Background Type Toggle
        if (target.name === 'backgroundType') {
            container.querySelectorAll('.bg-control-group').forEach(el => el.style.display = 'none');
            const type = target.value; 
            const el = document.getElementById(`bg-ctrl-${type}`);
            if (el) el.style.display = 'block';
            saveFunctions.appearanceSettings(form);
            return;
        }

        // Loader Type Toggle
        if (target.name === 'loaderType') {
            const customGroup = document.getElementById('loader-custom-group');
            if (customGroup) customGroup.style.display = (target.value === 'custom') ? 'block' : 'none';
            saveFunctions.appearanceSettings(form);
            return;
        }

        // Font
        if (target.id === 'font-selector') {
            uiUtils.applySiteFont(target.value);
            saveFunctions.visualTheme();
            return;
        }

        // Logo Upload
        if (target.id === 'logo-upload') {
            const file = target.files[0];
            if (file) {
                uiUtils.showToast("Uploading...", "info");
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
        if (e.target.id === 'bg-upload') {
            const file = e.target.files[0];
            if (file) {
                uiUtils.showToast("Uploading...", "info");
                try {
                    const url = await uploadLogo(file);
                    const { data: { session } } = await supabase.auth.getSession();
                    const { settings } = useAppStore.getState().siteSettings;
                    const newTheme = { ...settings.themeVariables, '--body-background-image': `url('${url}')` };
                    const newUiConfig = { ...settings.uiConfig, backgroundType: 'image' };

                    await api.updateSiteSettings({ themeVariables: newTheme, uiConfig: newUiConfig }, session.access_token);
                    document.documentElement.style.setProperty('--body-background-image', `url('${url}')`);
                    document.getElementById('bg-preview').src = url;
                    document.getElementById('bg-preview').style.display = 'block';
                    document.getElementById('clear-bg-btn').style.display = 'inline-block';
                    
                    // Update Radio
                    const radio = document.querySelector('input[name="backgroundType"][value="image"]');
                    if (radio) radio.checked = true;
                    const ctrl = document.getElementById('bg-ctrl-image');
                    if (ctrl) ctrl.style.display = 'block';

                    uiUtils.showToast("Background saved.", "success");
                } catch (err) { uiUtils.showToast("Upload failed.", "error"); }
            }
            return;
        }
        
        // Loader Upload
        if (target.id === 'loader-upload') {
            const file = target.files[0];
            if (file) {
                uiUtils.showToast("Uploading...", "info");
                try {
                    const url = await uploadLogo(file);
                    const { data: { session } } = await supabase.auth.getSession();
                    const { settings } = useAppStore.getState().siteSettings;
                    const newLoaderConfig = { ...settings.loaderConfig, customUrl: url, type: 'custom' };
                    
                    await api.updateSiteSettings({ loaderConfig: newLoaderConfig }, session.access_token);
                    uiUtils.setGlobalSpinnerConfig(newLoaderConfig);
                    
                    document.getElementById('loader-preview').src = url;
                    uiUtils.showToast("Loader updated.", "success");
                } catch (e) { uiUtils.showToast("Upload failed.", "error"); }
            }
            return;
        }


        

        // General Form Autosaves
        if (form?.id === 'global-settings-form') saveFunctions.globalSettings(form);
        if (form?.id === 'menu-config-form') saveFunctions.menuConfig(form);
        if (form?.id === 'owner-permissions-form') saveFunctions.ownerPermissions(form);
        if (form?.id === 'header-settings-form') saveFunctions.headerLayout(form);
        if (form?.id === 'payment-settings-form') saveFunctions.paymentSettings(form);
        if (form?.id === 'appearance-settings-form') saveFunctions.appearanceSettings(form);
        if (form?.id === 'about-config-form') saveFunctions.aboutConfig(form);
    });
    
    // --- 3. SUBMIT (Layout) ---
    container.addEventListener('submit', async (e) => {
        if (e.target.id === 'dashboard-layout-form') {
            e.preventDefault();
            saveFunctions.dashboardLayout(e.target);
        }
    });
}