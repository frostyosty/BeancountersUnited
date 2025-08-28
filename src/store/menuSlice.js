// src/store/menuSlice.js
import * as api from '@/services/apiService.js'; // Using the '@' alias for a clean path

/**
 * Creates a Zustand slice for managing menu state.
 *
 * @param {Function} set - Zustand's state setter function.
 * @param {Function} get - Zustand's state getter function.
 * @returns {object} The menu slice of the store.
 */

export const createMenuSlice = (set, get) => ({
    items: [],
    isLoading: true,
    error: null,

    fetchMenu: async () => {
        console.log("!!! MOCK DATA MODE: Bypassing API call.");
        set((state) => ({ menu: { ...state.menu, isLoading: true, error: null } }));

        // Simulate a network delay
        setTimeout(() => {
            const mockMenuItems = [
                { id: 'item-1', name: 'Margherita Pizza', description: 'Classic cheese and tomato', price: 12.99, category: 'Pizzas', image_url: '/placeholder-pizza.jpg' },
                { id: 'item-2', name: 'Cheeseburger', description: 'Juicy beef patty with cheddar cheese', price: 10.50, category: 'Burgers', image_url: '/placeholder-burger.jpg' },
                { id: 'item-3', name: 'Caesar Salad', description: 'Fresh romaine with Caesar dressing', price: 8.75, category: 'Salads', image_url: '/placeholder-salad.jpg' },
            ];
            
            // Set the state with the mock data
            set((state) => ({
                menu: { ...state.menu, items: mockMenuItems, isLoading: false }
            }), false, 'menu/fetchSuccess-MOCK');
            
            console.log("!!! MOCK DATA MODE: Set state to SUCCESS.");

        }, 500); // Wait 0.5 seconds to simulate loading
    },

    /**
     * Updates a single menu item in the local state.
     * This is an "optimistic update" action. The owner's UI would call this
     * *immediately* after a successful API call to update an item, so the
     * UI reflects the change without needing to re-fetch the entire menu.
     * @param {object} updatedItem - The menu item object with updated values.
     */
    updateMenuItemInState: (updatedItem) => {
        set(state => ({
            menu: {
                ...state.menu,
                items: state.menu.items.map(item =>
                    item.id === updatedItem.id ? { ...item, ...updatedItem } : item
                ),
            }
        }), false, 'menu/updateItem');
    },

    // We will add more actions later for adding/deleting items for the owner.
});