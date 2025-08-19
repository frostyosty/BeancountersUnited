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
    // --- STATE ---
    // The initial state for everything related to the menu.
    menu: {
        items: [],       // Array to hold the menu items fetched from the API
        isLoading: true, // True when fetching, false otherwise
        error: null,     // Holds any error message if fetching fails
    },

    // --- ACTIONS ---
    // Actions are functions that can be called from the UI to change the state.

    /**
     * Fetches menu items from the API and updates the state.
     */
    fetchMenu: async () => {
        // Set loading state to true immediately
        set(state => ({
            menu: { ...state.menu, isLoading: true, error: null }
        }), false, 'menu/fetchStart'); // The string is a label for Redux DevTools

        try {
            // Call the API function to get the menu data
            const menuItems = await api.getMenu();

            // On success, update the state with the fetched items
            set(state => ({
                menu: { ...state.menu, items: menuItems, isLoading: false }
            }), false, 'menu/fetchSuccess');

        } catch (error) {
            console.error("Error fetching menu:", error);
            // On failure, update the state with the error message
            set(state => ({
                menu: { ...state.menu, isLoading: false, error: error.message }
            }), false, 'menu/fetchError');
        }
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