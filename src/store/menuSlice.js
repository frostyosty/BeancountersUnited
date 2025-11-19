import * as api from '@/services/apiService.js';

export const createMenuSlice = (set, get) => ({
    items: [],
    isLoading: false,
    error: null,
    
    fetchMenu: async () => {
        const state = get().menu;
        if (state.isLoading || (state.items && state.items.length > 0)) return;

        set(state => ({ menu: { ...state.menu, isLoading: true, error: null } }));
        try {
            const menuItems = await api.getMenu();
            set(state => ({ menu: { ...state.menu, items: menuItems, isLoading: false } }));
            get().ui.triggerPageRender();
        } catch (error) {
            set(state => ({ menu: { ...state.menu, isLoading: false, error: error.message } }));
        }
    },

    // --- OPTIMISTIC ADD ---
    addMenuItemOptimistic: async (itemData, token) => {
        const tempId = 'temp-' + Date.now();
        const newItem = { ...itemData, id: tempId };
        
        // 1. Update Local State Immediately
        set(state => ({
            menu: { ...state.menu, items: [...state.menu.items, newItem] }
        }));
        get().ui.triggerPageRender(); // Update UI immediately

        try {
            // 2. Call API
            await api.addMenuItem(itemData, token);
            
            // 3. Re-fetch to get the real ID and data from DB
            // (We reset the list so fetchMenu will actually run)
            set(state => ({ menu: { ...state.menu, items: [] } })); 
            await get().menu.fetchMenu();
            
        } catch (error) {
            // Revert on error
            console.error("Add Item Failed:", error);
            alert("Failed to add item. Reverting.");
            set(state => ({
                menu: { ...state.menu, items: state.menu.items.filter(i => i.id !== tempId) }
            }));
            get().ui.triggerPageRender();
        }
    },

    // --- OPTIMISTIC DELETE ---
    deleteMenuItemOptimistic: async (itemId, token) => {
        const originalItems = get().menu.items;
        const itemToDelete = originalItems.find(i => i.id === itemId);

        // 1. Update Local State Immediately
        set(state => ({
            menu: { ...state.menu, items: state.menu.items.filter(i => i.id !== itemId) }
        }));
        get().ui.triggerPageRender();

        try {
            // 2. Call API
            await api.deleteMenuItem(itemId, token);
        } catch (error) {
            console.error("Delete Item Failed:", error);
            alert("Failed to delete item. Reverting.");
            // Revert
            set(state => ({ menu: { ...state.menu, items: originalItems } }));
            get().ui.triggerPageRender();
        }
    }
});