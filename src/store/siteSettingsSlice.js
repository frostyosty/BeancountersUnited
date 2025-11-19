// src/store/siteSettingsSlice.js
import * as api from '@/services/apiService.js';

export const createSiteSettingsSlice = (set, get) => ({
    // --- STATE ---
    settings: {},
    isLoading: false,
    error: null,

    // --- ACTIONS ---
    fetchSiteSettings: async () => {
        // Prevent duplicate fetches if already loaded
        if (get().siteSettings.isLoading) return;
        
        set(state => ({ siteSettings: { ...state.siteSettings, isLoading: true, error: null } }));
        try {
            const settingsData = await api.getSiteSettings();
            console.log("[SiteSettingsSlice] Fetch successful.");
            
            set(state => ({
                siteSettings: { ...state.siteSettings, settings: settingsData, isLoading: false }
            }));

            // --- CRITICAL FIX: Trigger the UI to re-render ---
            if (get().ui && get().ui.triggerPageRender) {
                 get().ui.triggerPageRender();
            }

        } catch (error) {
            console.error("[SiteSettingsSlice] Fetch failed.", error);
            set(state => ({
                siteSettings: { ...state.siteSettings, isLoading: false, error: error.message }
            }));
        }
    },
});