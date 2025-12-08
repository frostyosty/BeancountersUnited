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
    addItem: (itemToAdd, selectedOptions = []) => {
        // Validation
        if (!itemToAdd || !itemToAdd.id || !itemToAdd.name || isNaN(parseFloat(itemToAdd.price))) return;

        const currentItems = get().cart.items;
        
        // NEW: Create a unique signature for this variation
        // Sort options so "Decaf, Extra Hot" == "Extra Hot, Decaf"
        const optionsList = selectedOptions.sort(); 
        const cartId = `${itemToAdd.id}-${optionsList.join('|')}`;

        const existingItem = currentItems.find(i => i.cartId === cartId);

        let newItems;
        if (existingItem) {
            newItems = currentItems.map(i => 
                i.cartId === cartId ? { ...i, quantity: i.quantity + 1 } : i
            );
        } else {
            newItems = [...currentItems, { 
                ...itemToAdd, 
                quantity: 1, 
                price: parseFloat(itemToAdd.price),
                selectedOptions: optionsList, // Store choices
                cartId: cartId // Store unique ID for cart logic
            }];
        }
        
        set(state => ({ cart: { ...state.cart, items: newItems } }));
        get().cart._saveToLocalStorage();
    },

    // IMPORTANT: Update removeItem to use cartId, NOT database id
    removeItem: (cartIdToRemove) => {
        // If the UI passes simple ID, this might break old cart items. 
        // Best to update UI to pass cartId.
        const newItems = get().cart.items.filter(i => i.cartId !== cartIdToRemove);
        set(state => ({ cart: { ...state.cart, items: newItems } }));
        get().cart._saveToLocalStorage();
    },
    
    // IMPORTANT: Update updateItemQuantity to use cartId
    updateItemQuantity: (cartId, newQuantity) => {
        const quantity = Math.max(0, newQuantity);
        if (quantity === 0) {
            get().cart.removeItem(cartId);
            return;
        }
        const newItems = get().cart.items.map(item =>
            item.cartId === cartId ? { ...item, quantity: quantity } : item
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