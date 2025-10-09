// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    // --- STATE for the 'menu' slice ---
    items: [],
    isLoading: false,
    error: null,

    // --- ACTIONS for the 'menu' slice ---
    fetchMenu: async () => {
        // This set call correctly updates properties within its own slice
        set(state => ({
            menu: { ...state.menu, isLoading: true, error: null }
        }));
        try {
            const menuItems = await api.getMenu();
            // This set call correctly updates properties within its own slice
            set(state => ({
                menu: { ...state.menu, items: menuItems, isLoading: false }
            }
            ));
            useAppStore.getState().ui.triggerPageRender();
        } catch (error) {
            set(state => ({
                menu: { ...state.menu, isLoading: false, error: error.message }
            }));
        }
    },
});