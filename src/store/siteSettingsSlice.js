// src/store/siteSettingsSlice.js
import * as api from '@/services/apiService.js';

export const createSiteSettingsSlice = (set, get) => ({
    settings: {},
    isLoading: false,
    error: null,

    fetchSiteSettings: async () => {
        const state = get().siteSettings;
        // FIX: Stop if loading OR if we already have settings (keys exist)
        if (state.isLoading || Object.keys(state.settings).length > 0) {
            return; 
        }
        
        set(state => ({ siteSettings: { ...state.siteSettings, isLoading: true, error: null } }));
        try {
            const settingsData = await api.getSiteSettings();
            set(state => ({
                siteSettings: { ...state.siteSettings, settings: settingsData, isLoading: false }
            }));
            
            // Safe trigger
            if (get().ui && get().ui.triggerPageRender) {
                 get().ui.triggerPageRender();
            }
        } catch (error) {
            set(state => ({
                siteSettings: { ...state.siteSettings, isLoading: false, error: error.message }
            }));
        }
    },
});
