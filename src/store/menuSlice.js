// src/store/menuSlice.js
import * as api from '@/services/apiService.js';
export const createMenuSlice = (set) => ({
    items: [], isLoading: true, error: null,
    fetchMenu: async () => {
        set(state => ({ menu: { ...state.menu, isLoading: true, error: null } }));
        try {
            const menuItems = await api.getMenu();
            set(state => ({ menu: { ...state.menu, items: menuItems, isLoading: false } }));
        } catch (error) {
            set(state => ({ menu: { ...state.menu, isLoading: false, error: error.message } }));
        }
    },
});