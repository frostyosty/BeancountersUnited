// src/store/cartSlice.js

const getInitialState = () => {
    try {
        const savedCart = localStorage.getItem('restaurantCart');
        return savedCart ? JSON.parse(savedCart) : [];
    } catch (error) {
        console.error("Could not parse cart from localStorage:", error);
        return [];
    }
};

export const createCartSlice = (set, get) => ({
    // --- STATE ---
    cartItems: getInitialState(),

    // --- INTERNAL HELPER ---
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
        const quantity = Math.max(0, newQuantity);
        if (quantity === 0) {
            get().removeItem(itemId);
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
    getCartItemCount: () => {
        return get().cartItems.reduce((total, item) => total + item.quantity, 0);
    },

    getCartTotal: () => {
        return get().cartItems.reduce((total, item) => total + (item.price * item.quantity), 0);
    },
});