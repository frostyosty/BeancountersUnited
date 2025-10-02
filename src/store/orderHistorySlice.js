// src/store/orderHistorySlice.js
import * as api from '@/services/apiService.js';

export const createOrderHistorySlice = (set, get) => ({
    // --- STATE ---
    orders: [],
    isLoading: true,
    error: null,

    // src/store/orderHistorySlice.js

    // --- ACTIONS ---
    fetchOrderHistory: async () => {
        // --- THIS IS THE FIX ---
        // 1. Get the current state.
        const { isLoading, orders, error } = get().orderHistory;

        // 2. Safety Check: If we are already loading, or if we have successfully
        //    fetched data before (and there's no error), then do nothing.
        if (isLoading || (orders.length > 0 && !error)) {
            return; // Return immediately, DO NOT set state again.
        }
        // --- END OF FIX ---

        // ONLY set loading state if a fetch is about to happen.
        set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));
        
        try {
            // Your apiService should handle auth automatically now.
            const history = await api.getOrderHistory();
            set(state => ({ orderHistory: { ...state.orderHistory, orders: history, isLoading: false } }));
        } catch (error) {
            // If the user is not logged in, apiService will throw an error.
            // We can treat this as an empty history rather than a critical failure.
            if (error.message.includes("Authentication token is missing")) {
                set(state => ({ orderHistory: { ...state.orderHistory, orders: [], isLoading: false } }));
            } else {
                // For all other errors, record them.
                set(state => ({ orderHistory: { ...state.orderHistory, error: error.message, isLoading: false } }));
            }
        }
    },
});