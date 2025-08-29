// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    menuItems: [],
    isMenuLoading: true,
    menuError: null,

    fetchMenu: async () => {
        console.log("!!! fetchMenu action started.");
        set({ isMenuLoading: true, menuError: null });
        try {
            const items = await api.getMenu();
            console.log("!!! fetchMenu got items:", items);
            set({ menuItems: items, isMenuLoading: false });
        } catch (error) {
            console.error("!!! fetchMenu FAILED:", error);
            set({ isMenuLoading: false, menuError: error.message });
        }
    },
});