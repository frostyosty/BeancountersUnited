// src/store/orderHistorySlice.js
import * as api from '@/services/apiService.js';

export const createOrderHistorySlice = (set, get) => ({
    // --- STATE ---
    orders: [],
    isLoading: true,
    error: null,

    // --- ACTIONS ---
    fetchOrderHistory: async () => {
        set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true } }));
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) {
                // Not logged in, so no order history. This is not an error.
                set(state => ({ orderHistory: { ...state.orderHistory, orders: [], isLoading: false } }));
                return;
            }

            const history = await api.getOrderHistory(session.access_token);
            set(state => ({ orderHistory: { ...state.orderHistory, orders: history, isLoading: false } }));
        } catch (error) {
            set(state => ({ orderHistory: { ...state.orderHistory, error: error.message, isLoading: false } }));
        }
    },
});