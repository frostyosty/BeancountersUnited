// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    items: [],
    isLoading: true,
    error: null,

    fetchMenu: async () => {
        console.log("--- menuSlice.fetchMenu() called ---");
        // Update the 'menu' part of the state
        set(state => ({ menu: { ...state.menu, isLoading: true, error: null } }));
        try {
            const menuItems = await api.getMenu();
            console.log("--- menuSlice.fetchMenu() SUCCESS ---", menuItems);
            // Update the 'menu' part of the state with the data
            set(state => ({ menu: { ...state.menu, items: menuItems, isLoading: false } }));
        } catch (error) {
            console.error("--- menuSlice.fetchMenu() FAILED ---", error);
            set(state => ({ menu: { ...state.menu, isLoading: false, error: error.message } }));
        }
    },
});