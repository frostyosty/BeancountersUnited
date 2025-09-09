// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    menuItems: [],
    isMenuLoading: true,
    menuError: null,

    fetchMenu: async () => {
        // We do NOT set the loading state here, as the initial state is already loading.
        // This prevents the infinite loop.
        try {
            const items = await api.getMenu();
            set({ menuItems: items, isMenuLoading: false });
        } catch (error) {
            set({ isMenuLoading: false, menuError: error.message });
        }
    },
});