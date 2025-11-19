// src/store/menuSlice.js
import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    items: [],
    isLoading: false,
    error: null,
    
    fetchMenu: async () => {
        set(state => ({ menu: { ...state.menu, isLoading: true, error: null } }));
        try {
            const menuItems = await api.getMenu();
            set(state => ({ menu: { ...state.menu, items: menuItems, isLoading: false } }));
            
            // Fix: Use get() instead of useAppStore.getState()
            get().ui.triggerPageRender();
        } catch (error) {
            set(state => ({ menu: { ...state.menu, isLoading: false, error: error.message } }));
        }
    },
});