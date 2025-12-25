// src/store/siteSettingsSlice.js
import * as api from '@/services/apiService.js';

export const createSiteSettingsSlice = (set, get) => ({
    settings: {},
    isLoading: false,
    error: null,

    fetchSiteSettings: async (forceRefresh = false) => {
        const state = get().siteSettings;
        if (state.isLoading) return;
        if (!forceRefresh && state.settings && Object.keys(state.settings).length > 0) return;
        
        set(state => ({ siteSettings: { ...state.siteSettings, isLoading: true, error: null } }));
        
        try {
            const settingsData = await api.getSiteSettings();
            set(state => ({
                siteSettings: { ...state.siteSettings, settings: settingsData, isLoading: false }
            }));
            if (get().ui?.triggerPageRender) get().ui.triggerPageRender();
        } catch (error) {
            set(state => ({
                siteSettings: { ...state.siteSettings, isLoading: false, error: error.message }
            }));
        }
    },

    updateSiteSettings: async (newSettings, token) => {
        const previousSettings = get().siteSettings.settings;
        const mergedSettings = { ...previousSettings, ...newSettings };
        
        // Optimistic Update
        set(state => ({
            siteSettings: { ...state.siteSettings, settings: mergedSettings }
        }));
        get().ui.triggerPageRender();

        try {
            await api.updateSiteSettings(newSettings, token);
        } catch (error) {
            console.error("Failed to save settings:", error);
            // Revert
            set(state => ({
                siteSettings: { ...state.siteSettings, settings: previousSettings }
            }));
            get().ui.triggerPageRender();
            // Re-throw so caller knows it failed (e.g. for Toasts)
            throw error; 
        }
    },

    // --- THIS IS THE MISSING FUNCTION CAUSING THE CRASH ---
    getMenuCategories: () => {
        const state = get();
        // Defensive check in case state isn't ready
        if (!state.siteSettings || !state.siteSettings.settings) return [];

        const settings = state.siteSettings.settings;
        
        if (settings.menuCategories && Array.isArray(settings.menuCategories)) {
            return settings.menuCategories;
        }
        
        // Fallback: Generate from items if no categories defined in settings
        if (state.menu && state.menu.items) {
            const items = state.menu.items;
            const uniqueCategories = [...new Set(items.map(i => i.category || 'Uncategorized'))];
            return uniqueCategories.sort();
        }
        
        return [];
    }
});