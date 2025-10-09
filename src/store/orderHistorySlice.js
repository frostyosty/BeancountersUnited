// src/store/orderHistorySlice.js
import * as api from '@/services/apiService.js';

export const createOrderHistorySlice = (set, get) => ({
    // --- STATE ---
    orders: [],
    isLoading: false,
    error: null,

    // src/store/orderHistorySlice.js

    // --- ACTIONS ---
    fetchOrderHistory: async () => {
        console.log("[OrderHistorySlice] 1. fetchOrderHistory() CALLED.");
        const { isLoading, orders, error } = get().orderHistory;

        if (isLoading || (orders.length > 0 && !error)) {
            console.log("[OrderHistorySlice] 2. Skipping fetch: already loading or has data.");
            return;
        }

        console.log("[OrderHistorySlice] 3. Setting isLoading: true.");
        set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));

        try {
            console.log("[OrderHistorySlice] 4. Calling api.getOrderHistory()...");
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) throw new Error("Authentication token is missing");
            
            const history = await api.getOrderHistory(session.access_token);
            console.log(`[OrderHistorySlice] 5. Fetch successful. Received ${history.length} orders.`);
            set(state => ({ orderHistory: { ...state.orderHistory, orders: history, isLoading: false } }));
        } catch (error) {
            console.error("[OrderHistorySlice] 6. Fetch FAILED.", error);
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