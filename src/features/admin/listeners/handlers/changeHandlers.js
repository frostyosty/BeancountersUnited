//src/features/admin/listeners/handlers/changeHandlers.js

import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { uploadLogo } from '../helpers.js';
import { saveFunctions } from '../saveActions.js';

export function attachChangeHandlers(container) {
    container.addEventListener('change', async (e) => {
        const target = e.target;
        const form = target.closest('form');

        // Background Type Toggle (UI Logic)
        if (target.name === 'backgroundType') {
            container.querySelectorAll('.bg-control-group').forEach(el => el.style.display = 'none');
            const type = target.value; 
            const el = document.getElementById(`bg-ctrl-${type}`);
            if (el) el.style.display = 'block';
            saveFunctions.appearanceSettings(form);
            return;
        }
        
        // Delivery Toggle (UI Logic)
        if (target.name === 'deliveryEnabled') {
             const panel = document.getElementById('delivery-config-panel');
             if(panel) panel.style.display = target.checked ? 'block' : 'none';
             // Save handled by form check below
        }

        // Loader Type Toggle (UI Logic)
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

        // --- UPLOADS ---

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
                    const newUiConfig = { ...settings.uiConfig, backgroundType: 'image' };

                    await api.updateSiteSettings({ themeVariables: newTheme, uiConfig: newUiConfig }, session.access_token);
                    document.documentElement.style.setProperty('--body-background-image', `url('${url}')`);
                    
                    document.getElementById('bg-preview').src = url;
                    document.getElementById('bg-preview').style.display = 'block';
                    document.getElementById('clear-bg-btn').style.display = 'inline-block';
                    
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

        // --- DIRECT SAVE TRIGGERS ---
        if (form?.id === 'global-settings-form') saveFunctions.globalSettings(form);
        if (form?.id === 'menu-config-form') saveFunctions.menuConfig(form);
        if (form?.id === 'owner-permissions-form') saveFunctions.ownerPermissions(form);
        if (form?.id === 'header-settings-form') saveFunctions.headerLayout(form);
        if (form?.id === 'payment-settings-form') saveFunctions.paymentSettings(form);
        if (form?.id === 'appearance-settings-form') saveFunctions.appearanceSettings(form);
        if (form?.id === 'about-config-form') saveFunctions.aboutConfig(form);
        if (form?.id === 'operations-form') saveFunctions.operationsConfig(form);
    });
}