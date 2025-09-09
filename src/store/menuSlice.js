// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set) => ({
    menuItems: [],
    isMenuLoading: true,
    menuError: null,
    fetchMenu: async () => {
        console.log("--- menuSlice: fetchMenu() CALLED ---");
        set({ isMenuLoading: true, menuError: null });
        try {
            console.log("menuSlice: About to call api.getMenu()...");
            const items = await api.getMenu();
            console.log("menuSlice: api.getMenu() successful. Received:", items);
            set({ menuItems: items, isMenuLoading: false });
        } catch (error) {
            console.error("--- menuSlice: fetchMenu() FAILED ---", error);
            set({ isMenuLoading: false, menuError: error.message });
        }
    },
});