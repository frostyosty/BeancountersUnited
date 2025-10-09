// src/store/siteSettingsSlice.js
import { useAppStore } from './appStore';
import * as api from '@/services/apiService.js';


export const createSiteSettingsSlice = (set, get) => ({
    // --- STATE ---
    settings: {}, // Holds { websiteName, themeVariables, menuCategories }
    isLoading: false,
    error: null,

    // --- ACTIONS ---
    fetchSiteSettings: async () => {
        console.log("[SiteSettingsSlice] 1. fetchSiteSettings() CALLED."); // <-- ADD THIS
        // Safety check can be added here if needed
        set(state => ({ siteSettings: { ...state.siteSettings, isLoading: true } }));
        try {
            const settings = await api.getSiteSettings();
            console.log("[SiteSettingsSlice] 2. Fetch successful."); // <-- ADD THIS
            set(state => ({ siteSettings: { ...state.siteSettings, settings, isLoading: false } }));
            useAppStore.getState().triggerPageRender();
        } catch (error) {
             console.error("[SiteSettingsSlice] 3. Fetch FAILED.", error);
            set(state => ({ siteSettings: { ...state.siteSettings, error: error.message, isLoading: false } }));
        }
    },

    updateSiteSettings: async (newSettings) => {
        const originalSettings = get().siteSettings.settings;
        const updatedSettings = { ...originalSettings, ...newSettings };
        set(state => ({ siteSettings: { ...state.siteSettings, settings: updatedSettings } }));

        try {
            await api.updateSiteSettings(newSettings);
        } catch (error) {
            console.error("Failed to save site settings:", error);
            set(state => ({ siteSettings: { ...state.siteSettings, settings: originalSettings, error: error.message } }));
            alert("Failed to save settings. Please try again.");
        }
    },

    // --- NEW SELECTOR ---
    /**
     * Gets the list of menu categories. If not defined in settings, it generates them
     * dynamically from the current menu items.
     * @returns {Array<string>} - An ordered array of category names.
     */
    getMenuCategories: () => {
        const { settings } = get().siteSettings;
        const menuItems = get().menu.items;

        // If categories are explicitly defined and ordered in settings, use that.
        if (settings.menuCategories && Array.isArray(settings.menuCategories)) {
            return settings.menuCategories;
        }

        // Otherwise, generate a unique, sorted list from the menu items themselves.
        const dynamicCategories = [...new Set(menuItems.map(item => item.category || 'Uncategorized'))];
        return dynamicCategories.sort();
    },
    /**
     * Gets the configuration for the hamburger menu content.
     * Defaults to 'main-nav' if not set.
     * @returns {'main-nav' | 'categories'}
     */
    getHamburgerMenuConfig: () => {
        return get().siteSettings.settings.hamburgerMenuContent || 'main-nav';
    }
});