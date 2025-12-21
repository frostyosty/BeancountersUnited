import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { adminState } from './state.js';

export const saveFunctions = {
    globalSettings: async (form) => {
        const formData = new FormData(form);
        const { data: { session } } = await supabase.auth.getSession();
        const currentSettings = useAppStore.getState().siteSettings.settings;

        const settingsUpdate = { 
            websiteName: formData.get('websiteName'), 
            hamburgerMenuContent: formData.get('hamburgerMenuContent'),
            logoUrl: currentSettings.logoUrl
        };
        
        await api.updateSiteSettings(settingsUpdate, session.access_token);
        uiUtils.updateSiteTitles(settingsUpdate.websiteName, null);
        uiUtils.showToast('Settings saved.', 'success', 1000);
    },

    menuConfig: async (form) => {
        const formData = new FormData(form);
        const { data: { session } } = await supabase.auth.getSession();
        const settingsUpdate = { showAllergens: formData.get('showAllergens') === 'on' };
        await api.updateSiteSettings(settingsUpdate, session.access_token);
        uiUtils.showToast('Menu settings saved.', 'success', 1000);
        useAppStore.getState().siteSettings.fetchSiteSettings();
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
            hamburgerPosition: formData.get('hamburgerPosition'),
            height: parseInt(formData.get('headerHeight')) || 60,
            bgColor: formData.get('headerBgColor'),
            bgPattern: formData.get('headerPattern')
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
        uiUtils.showToast('Payment settings updated.', 'success', 1000);
    },

    visualTheme: async () => {
        const container = document.querySelector('.dashboard-container');
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
            backgroundType: formData.get('backgroundType'),
            bgParallax: formData.get('bgParallax') === 'on',
            bgAnimation: formData.get('bgAnimation') === 'on'
        };
        
        // Loader Config
        const currentLoader = settings.loaderConfig || {};
        const loaderConfig = {
            type: formData.get('loaderType'),
            animation: formData.get('loaderAnimation'),
            customUrl: currentLoader.customUrl 
        };

        const container = document.querySelector('.dashboard-container');
        const themeVariables = { ...settings.themeVariables };
        container.querySelectorAll('[data-css-var]').forEach(input => {
            themeVariables[input.dataset.cssVar] = input.value;
        });

        await api.updateSiteSettings({ uiConfig, loaderConfig, themeVariables }, session.access_token);
        uiUtils.setGlobalSpinnerConfig(loaderConfig);
        
        const currentSettings = useAppStore.getState().siteSettings.settings;
        const newSettings = { ...currentSettings, uiConfig, themeVariables: { ...currentSettings.themeVariables, ...themeVariables } };
        
        uiUtils.applyGlobalBackground(newSettings);
        uiUtils.showToast('Appearance saved.', 'success', 1000);
    },

    aboutConfig: async (form) => {
        const formData = new FormData(form);
        const { data: { session } } = await supabase.auth.getSession();
        const currentSettings = useAppStore.getState().siteSettings.settings;
        const currentAbout = currentSettings.aboutUs || {};

        const settingsUpdate = {
            aboutUs: {
                ...currentAbout,
                enabled: formData.get('enableAboutUs') === 'on'
            }
        };
        await api.updateSiteSettings(settingsUpdate, session.access_token);
        uiUtils.showToast('About settings saved.', 'success', 1000);
        useAppStore.getState().siteSettings.fetchSiteSettings(); 
    },

    dashboardLayout: async (form) => {
        const formData = new FormData(form);
        
        const newLayout = [];
        const listItems = document.querySelectorAll('.tab-config-item');
        listItems.forEach(li => {
            const id = li.dataset.id;
            const visible = li.querySelector('input[type="checkbox"]').checked;
            const original = adminState.layout.find(t => t.id === id);
            newLayout.push({ id, label: original.label, hidden: !visible });
        });

        const dashboardConfig = {
            enabled: formData.get('enableTabs') === 'on',
            position: formData.get('tabPosition'),
            layout: newLayout
        };

        const { data: { session } } = await supabase.auth.getSession();
        await api.updateSiteSettings({ dashboardConfig }, session.access_token);
        
        // Update local state
        adminState.tabsEnabled = dashboardConfig.enabled;
        adminState.tabPosition = dashboardConfig.position;
        adminState.layout = newLayout;
        
        uiUtils.showToast("Layout saved.", "success");
        useAppStore.getState().ui.triggerPageRender();
    }
};