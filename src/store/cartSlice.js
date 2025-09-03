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
    items: JSON.parse(localStorage.getItem('restaurantCart')) || [],
    _saveToLocalStorage: () => localStorage.setItem('restaurantCart', JSON.stringify(get().cart.items)),
    addItem: (itemToAdd) => {
        const currentItems = get().cart.items;
        const existingItem = currentItems.find(i => i.id === itemToAdd.id);
        let newItems = existingItem
            ? currentItems.map(i => i.id === itemToAdd.id ? { ...i, quantity: i.quantity + 1 } : i)
            : [...currentItems, { ...itemToAdd, quantity: 1 }];
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

    getTotalItemCount: () => get().cart.items.reduce((total, item) => total + item.quantity, 0),
    getCartTotal: () => get().cart.items.reduce((total, item) => total + (item.price * item.quantity), 0),
});