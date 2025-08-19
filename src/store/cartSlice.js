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
    items: JSON.parse(localStorage.getItem('restaurantCart')) || [], // Load initial state from localStorage

    // --- INTERNAL HELPERS ---
    // Underscore convention for internal methods not meant to be called directly from UI.
    _saveToLocalStorage: () => {
        try {
            localStorage.setItem('restaurantCart', JSON.stringify(get().items));
        } catch (error) {
            console.error("Could not save cart to localStorage:", error);
        }
    },

    // --- ACTIONS ---

    /**
     * Adds an item to the cart or increments its quantity if it already exists.
     * @param {object} itemToAdd - The full menu item object.
     */
    addItem: (itemToAdd) => {
        const currentItems = get().items;
        const existingItemIndex = currentItems.findIndex(i => i.id === itemToAdd.id);

        let newItems;

        if (existingItemIndex > -1) {
            // Item exists, increment quantity
            newItems = [...currentItems]; // Create a new array
            newItems[existingItemIndex] = {
                ...newItems[existingItemIndex],
                quantity: newItems[existingItemIndex].quantity + 1,
            };
        } else {
            // Item is new, add it with quantity 1
            newItems = [...currentItems, { ...itemToAdd, quantity: 1 }];
        }

        set({ items: newItems }, false, 'cart/addItem');
        get()._saveToLocalStorage();
    },

    /**
     * Removes an item completely from the cart.
     * @param {string} itemIdToRemove - The ID of the item to remove.
     */
    removeItem: (itemIdToRemove) => {
        const newItems = get().items.filter(i => i.id !== itemIdToRemove);
        set({ items: newItems }, false, 'cart/removeItem');
        get()._saveToLocalStorage();
    },

    /**
     * Updates the quantity of a specific item in the cart.
     * If quantity is 0 or less, the item is removed.
     * @param {string} itemIdToUpdate - The ID of the item to update.
     * @param {number} newQuantity - The new quantity for the item.
     */
    updateItemQuantity: (itemIdToUpdate, newQuantity) => {
        const quantity = Math.max(0, newQuantity); // Ensure quantity is not negative

        if (quantity === 0) {
            get().removeItem(itemIdToUpdate); // Use the existing removeItem action
            return;
        }

        const newItems = get().items.map(item =>
            item.id === itemIdToUpdate ? { ...item, quantity: quantity } : item
        );
        set({ items: newItems }, false, 'cart/updateQuantity');
        get()._saveToLocalStorage();
    },

    /**
     * Empties the entire cart.
     */
    clearCart: () => {
        set({ items: [] }, false, 'cart/clear');
        get()._saveToLocalStorage();
    },

    // --- SELECTORS ---
    // Selectors are functions that compute derived data from the state.
    // This is useful for things like totals so we don't have to calculate them in the UI every time.

    /**
     * @returns {number} The total number of individual items in the cart (e.g., 2 pizzas + 1 drink = 3).
     */
    getTotalItemCount: () => {
        return get().items.reduce((total, item) => total + item.quantity, 0);
    },

    /**
     * @returns {number} The total price of all items in the cart.
     */
    getCartTotal: () => {
        return get().items.reduce((total, item) => total + (item.price * item.quantity), 0);
    },
});