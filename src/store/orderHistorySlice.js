import * as api from '@/services/apiService.js';

export const createOrderHistorySlice = (set, get) => ({
    orders: [],
    isLoading: false,
    hasLoaded: false, // <--- NEW FLAG
    error: null,

    fetchOrderHistory: async () => {
        const state = get().orderHistory;
        
        // --- FIX: Check hasLoaded instead of orders.length ---
        if (state.isLoading || state.hasLoaded) {
            return;
        }

        set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));

        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            const { getUserRole } = get().auth;
            const role = getUserRole();
            
            // Admin sees all, Customer sees theirs.
            // (Assuming API handles the filtering based on token, or you have separate endpoints)
            const ordersData = await api.getOrderHistory(session.access_token);

            set(state => ({ 
                orderHistory: { 
                    ...state.orderHistory, 
                    orders: ordersData || [], 
                    isLoading: false,
                    hasLoaded: true // <--- MARK AS LOADED
                } 
            }));
            
            if (get().ui && get().ui.triggerPageRender) {
                get().ui.triggerPageRender();
            }

        } catch (error) {
            console.error("Fetch Orders Failed:", error);
            set(state => ({ 
                orderHistory: { ...state.orderHistory, isLoading: false, error: error.message } 
            }));
        }
    },
    
    // Optional: Action to force refresh (e.g., pulling down to refresh)
    refreshOrderHistory: () => {
        set(state => ({ orderHistory: { ...state.orderHistory, hasLoaded: false } }));
        get().orderHistory.fetchOrderHistory();
    }
});