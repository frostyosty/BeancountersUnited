import * as api from '@/services/apiService.js';

export const createSiteSettingsSlice = (set, get) => ({
    settings: {},
    isLoading: false,
    error: null,

    // FIX: Added forceRefresh parameter
    fetchSiteSettings: async (forceRefresh = false) => {
        const state = get().siteSettings;
        
        // Prevent loop if already loading
        if (state.isLoading) return;

        // Only skip if we have data AND we are not forcing a refresh
        if (!forceRefresh && state.settings && Object.keys(state.settings).length > 0) {
            return; 
        }
        
        set(state => ({ siteSettings: { ...state.siteSettings, isLoading: true, error: null } }));
        
        try {
            const settingsData = await api.getSiteSettings();
            set(state => ({
                siteSettings: { ...state.siteSettings, settings: settingsData, isLoading: false }
            }));
            
            // Trigger UI Update
            if (get().ui && get().ui.triggerPageRender) get().ui.triggerPageRender();
        } catch (error) {
            set(state => ({
                siteSettings: { ...state.siteSettings, isLoading: false, error: error.message }
            }));
        }
    },

    updateSiteSettings: async (newSettings, token) => {
        const previousSettings = get().siteSettings.settings;
        
        // 1. Optimistic Update
        const mergedSettings = { ...previousSettings, ...newSettings };
        set(state => ({
            siteSettings: { ...state.siteSettings, settings: mergedSettings }
        }));
        get().ui.triggerPageRender();

        try {
            // 2. API Call
            await api.updateSiteSettings(newSettings, token);
        } catch (error) {
            console.error("Failed to save settings:", error);
            alert("Failed to save settings. Reverting.");
            // 3. Revert on Error
            set(state => ({
                siteSettings: { ...state.siteSettings, settings: previousSettings }
            }));
            get().ui.triggerPageRender();
        }
    },

    getMenuCategories: () => {
        const state = get();
        const settings = state.siteSettings.settings || {};
        
        if (settings.menuCategories && Array.isArray(settings.menuCategories)) {
            return settings.menuCategories;
        }
        
        // Fallback: Access menu slice safely
        // We need to check if menu slice exists to prevent crash on early load
        if (!state.menu) return ['All']; 
        
        const items = state.menu.items || [];
        const uniqueCategories = [...new Set(items.map(i => i.category || 'Uncategorized'))];
        return uniqueCategories.sort();
    }
});