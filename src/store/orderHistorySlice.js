import * as api from '@/services/apiService.js';

export const createOrderHistorySlice = (set, get) => ({
    orders: [],
    isLoading: false,
    error: null,

    fetchOrderHistory: async () => {
        const state = get().orderHistory;
        const { getUserRole } = get().auth;
        const role = getUserRole();

        // --- LOOP FIX: Stop if loading OR if data exists ---
        // (Admins might want to force refresh later, but let's stop the crash first)
        if (state.isLoading || state.orders.length > 0) {
            return;
        }

        set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));

        try {
            // Get the token
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            let ordersData;

            // --- BRANCHING LOGIC ---
            if (role === 'manager' || role === 'owner') {
                // Admin sees ALL orders (You might need to ensure api.getAllOrders exists, 
                // or stick to getOrderHistory if your backend handles the role filtering)
                // For now, we assume getOrderHistory returns what the user is allowed to see.
                ordersData = await api.getOrderHistory(session.access_token); 
            } else {
                // Customers see their own
                ordersData = await api.getOrderHistory(session.access_token);
            }

            set(state => ({ 
                orderHistory: { ...state.orderHistory, orders: ordersData || [], isLoading: false } 
            }));
            
            // Trigger UI Update
            if (get().ui && get().ui.triggerPageRender) {
                get().ui.triggerPageRender();
            }

        } catch (error) {
            console.error("Fetch Orders Failed:", error);
            set(state => ({ 
                orderHistory: { ...state.orderHistory, isLoading: false, error: error.message } 
            }));
        }
    }
});