// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    menuItems: [],
    isMenuLoading: true,
    menuError: null,

    fetchMenu: async () => {
        console.log("--- menuSlice: fetchMenu() CALLED ---");
        set({ isMenuLoading: true, menuError: null });
        try {
            const items = await api.getMenu();
            console.log("--- menuSlice: fetchMenu() SUCCESS, received items:", items);
            set({ menuItems: items, isMenuLoading: false });
        } catch (error) {
            console.error("--- menuSlice: fetchMenu() FAILED ---", error);
            set({ menuItems: [], isMenuLoading: false, menuError: error.message });
        }
    },
});