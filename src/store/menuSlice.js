// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    menuItems: [],
    isMenuLoading: true,
    menuError: null,

    fetchMenu: async () => {
        set({ isMenuLoading: true, menuError: null });
        try {
            const items = await api.getMenu();
            set({ menuItems: items, isMenuLoading: false });
        } catch (error) {
            set({ menuError: error.message, isMenuLoading: false });
        }
    },
});