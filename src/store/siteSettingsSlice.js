import * as api from '@/services/apiService.js';

export const createSiteSettingsSlice = (set, get) => ({
    // --- STATE ---
    settings: {},
    isLoading: false,
    error: null,

    // --- ACTIONS ---
    fetchSiteSettings: async () => {
        const state = get().siteSettings;
        
        // --- LOOP FIX ---
        // If already loading OR we already have settings data, STOP.
        if (state.isLoading || (state.settings && Object.keys(state.settings).length > 0)) {
            return; 
        }
        
        set(state => ({ siteSettings: { ...state.siteSettings, isLoading: true, error: null } }));
        try {
            const settingsData = await api.getSiteSettings();
            
            set(state => ({
                siteSettings: { ...state.siteSettings, settings: settingsData, isLoading: false }
            }));
            
            // Trigger re-render safely
            if (get().ui && get().ui.triggerPageRender) {
                 get().ui.triggerPageRender();
            }
        } catch (error) {
            set(state => ({
                siteSettings: { ...state.siteSettings, isLoading: false, error: error.message }
            }));
        }
    },

    // --- SELECTORS (This was missing!) ---
    getMenuCategories: () => {
        const state = get();
        const settings = state.siteSettings.settings || {};
        
        // 1. If settings has explicit categories, use them
        if (settings.menuCategories && Array.isArray(settings.menuCategories)) {
            return settings.menuCategories;
        }

        // 2. Fallback: Derive unique categories from the menu items themselves
        const items = state.menu.items || [];
        const uniqueCategories = [...new Set(items.map(i => i.category || 'Uncategorized'))];
        
        // Return alphabetical order
        return uniqueCategories.sort();
    }
});