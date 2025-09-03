// src/store/cartSlice.js

/**
 * Creates a Zustand slice for managing shopping cart state.
 *
 * @param {Function} set - Zustand's state setter function.
 * @param {Function} get - Zustand's state getter function.
 * @returns {object} The cart slice of the store.
 */

export const createCartSlice = (set, get) => ({
    // --- STATE ---
    cartItems: getInitialState(),

    // --- INTERNAL HELPERS ---
    _saveToLocalStorage: () => {
        try {
            localStorage.setItem('restaurantCart', JSON.stringify(get().cartItems));
        } catch (error) {
            console.error("Could not save cart to localStorage:", error);
        }
    },

    // --- ACTIONS ---
    addItem: (itemToAdd) => {
        const currentItems = get().cartItems;
        const existingItem = currentItems.find(i => i.id === itemToAdd.id);

        let newItems;
        if (existingItem) {
            newItems = currentItems.map(i =>
                i.id === itemToAdd.id ? { ...i, quantity: i.quantity + 1 } : i
            );
        } else {
            newItems = [...currentItems, { ...itemToAdd, quantity: 1 }];
        }
        
        set({ cartItems: newItems });
        get()._saveToLocalStorage();
    },

    removeItem: (itemIdToRemove) => {
        const newItems = get().cartItems.filter(i => i.id !== itemIdToRemove);
        set({ cartItems: newItems });
        get()._saveToLocalStorage();
    },
    
    updateItemQuantity: (itemId, newQuantity) => {
        const quantity = Math.max(0, newQuantity); // Prevent negative numbers

        if (quantity === 0) {
            get().removeItem(itemId); // Use existing action to remove
            return;
        }

        const newItems = get().cartItems.map(item =>
            item.id === itemId ? { ...item, quantity: quantity } : item
        );
        set({ cartItems: newItems });
        get()._saveToLocalStorage();
    },

    clearCart: () => {
        set({ cartItems: [] });
        get()._saveToLocalStorage();
    },

    // --- SELECTORS ---
    // Selectors compute derived data from state
    getCartItemCount: () => {
        return get().cartItems.reduce((total, item) => total + item.quantity, 0);
    },

    getCartTotal: () => {
        return get().cartItems.reduce((total, item) => total + (item.price * item.quantity), 0);
    },
});