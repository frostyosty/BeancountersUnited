import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    // --- STATE ---
    items: [],
    isLoading: false,
    error: null,
    
    // --- ACTIONS ---
    fetchMenu: async () => {
        const state = get().menu;
        
        // --- LOOP FIX: Stop if loading OR if items already exist ---
        if (state.isLoading || (state.items && state.items.length > 0)) {
            return; 
        }

        set(state => ({ menu: { ...state.menu, isLoading: true, error: null } }));
        try {
            const menuItems = await api.getMenu();
            
            set(state => ({ menu: { ...state.menu, items: menuItems, isLoading: false } }));
            
            // Only trigger render if we actually fetched data
            if (get().ui && get().ui.triggerPageRender) {
                get().ui.triggerPageRender();
            }
        } catch (error) {
            set(state => ({ menu: { ...state.menu, isLoading: false, error: error.message } }));
        }
    },
});