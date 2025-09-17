// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    // These are the top-level state properties
    menuItems: [],
    isMenuLoading: true,
    menuError: null,

    fetchMenu: async () => {
        // Set the top-level properties
        set({ isMenuLoading: true, menuError: null });
        try {
            const items = await api.getMenu();
            // Set the top-level properties
            set({ menuItems: items, isMenuLoading: false });
        } catch (error) {
            set({ menuError: error.message, isMenuLoading: false });
        }
    },
});