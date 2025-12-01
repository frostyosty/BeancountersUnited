// src/store/cartSlice.js

const getInitialState = () => {
    try {
        const savedCart = localStorage.getItem('restaurantCart');
        const parsed = savedCart ? JSON.parse(savedCart) : [];
        // FIX: Filter out corrupt items immediately on load
        return Array.isArray(parsed)
            ? parsed.filter(i => i && i.id && i.name && !isNaN(parseFloat(i.price)))
            : [];
    } catch (error) {
        console.error("Cart Parse Error:", error);
        return [];
    }
};

export const createCartSlice = (set, get) => ({
    items: getInitialState(),
    _saveToLocalStorage: () => localStorage.setItem('restaurantCart', JSON.stringify(get().cart.items)),
    addItem: (itemToAdd) => {
        // FIX: Validate before adding
        if (!itemToAdd || !itemToAdd.id || !itemToAdd.name || isNaN(parseFloat(itemToAdd.price))) {
            console.error("Attempted to add invalid item:", itemToAdd);
            return;
        }

        const currentItems = get().cart.items;
        const existingItem = currentItems.find(i => i.id === itemToAdd.id);
        let newItems = existingItem
            ? currentItems.map(i => i.id === itemToAdd.id ? { ...i, quantity: i.quantity + 1 } : i)
            : [...currentItems, { ...itemToAdd, quantity: 1, price: parseFloat(itemToAdd.price) }]; // Ensure price is number

        set(state => ({ cart: { ...state.cart, items: newItems } }));
        get().cart._saveToLocalStorage();
    },

    removeItem: (itemIdToRemove) => {
        const newItems = get().cart.items.filter(i => i.id !== itemIdToRemove);
        set(state => ({ cart: { ...state.cart, items: newItems } }));
        get().cart._saveToLocalStorage();
    },

    updateItemQuantity: (itemId, newQuantity) => {
        const quantity = Math.max(0, newQuantity);
        if (quantity === 0) {
            get().cart.removeItem(itemId);
            return;
        }
        const newItems = get().cart.items.map(item =>
            item.id === itemId ? { ...item, quantity: quantity } : item
        );
        set(state => ({ cart: { ...state.cart, items: newItems } }));
        get().cart._saveToLocalStorage();
    },

    clearCart: () => {
        set(state => ({ cart: { ...state.cart, items: [] } }));
        get().cart._saveToLocalStorage();
    },

getTotalItemCount: () => get().cart.items.reduce((total, item) => total + (item.quantity || 0), 0),
    getCartTotal: () => get().cart.items.reduce((total, item) => total + (parseFloat(item.price || 0) * (item.quantity || 0)), 0),
});