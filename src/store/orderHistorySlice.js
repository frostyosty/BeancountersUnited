import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';

export const createOrderHistorySlice = (set, get) => ({
    orders: [],
    isLoading: false,
    hasLoaded: false,
    error: null,
    notifiedOrderIds: new Set(),

    // --- MAIN FETCH ACTION ---
    // Now accepts a 'silent' parameter to prevent the loading spinner
    fetchOrderHistory: async (silent = false) => {
        const state = get().orderHistory;
        
        // 1. GUARD CLAUSE
        // If already loading, stop. 
        // If loaded and NOT a silent refresh (e.g. initial nav), stop.
        if (state.isLoading) return;
        if (state.hasLoaded && !silent) return;

        // 2. Start Loading (ONLY if not silent)
        if (!silent) {
            set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));
        }

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            // 3. Fetch Data
            const ordersData = await api.getOrderHistory(session.access_token);

            // 4. Update State
            set(state => ({ 
                orderHistory: { 
                    ...state.orderHistory, 
                    orders: ordersData || [], 
                    isLoading: false, // Ensure loading is off
                    hasLoaded: true 
                } 
            }));
            
            // 5. Trigger UI Update
            if (get().ui && get().ui.triggerPageRender) {
                get().ui.triggerPageRender();
            }

        } catch (error) {
            console.error("[OrderHistorySlice] Fetch Failed:", error);
            set(state => ({ 
                orderHistory: { ...state.orderHistory, isLoading: false, error: error.message } 
            }));
        }
    },

    // --- MANUAL ORDER (Uses Silent Refresh) ---
    createManualOrder: async (orderDetails) => {
        try {
            // 1. Optimistic UI Update (Optional but feels instant)
            // We add a temporary "fake" order to the list immediately so the user sees it.
            const tempId = 'temp-' + Date.now();
            const optimisticOrder = {
                id: tempId,
                created_at: new Date().toISOString(),
                total_amount: orderDetails.total,
                status: 'pending',
                profiles: { full_name: 'Walk-in (Saving...)' },
                order_items: orderDetails.items.map(i => ({
                    quantity: i.quantity,
                    menu_items: { name: '...' } // Placeholder
                }))
            };

            // Add to state immediately
            set(state => ({
                orderHistory: {
                    ...state.orderHistory,
                    orders: [...state.orderHistory.orders, optimisticOrder]
                }
            }));
            get().ui.triggerPageRender();


            // 2. Real Backend Call
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            // Update: Ensure we pass the whole object including dueTime
            await api.createManualOrder(orderDetails, session.access_token);

            // 3. Silent Refresh
            await get().orderHistory.fetchOrderHistory(true);
            return true;

        } catch (e) {
            console.error("[OrderHistorySlice] Manual Order Failed:", e);
            alert(`Failed to create order: ${e.message}`);
            get().orderHistory.fetchOrderHistory(true);
            return false;
        }
    },

    // --- DISMISS ORDER (Optimistic) ---
    dismissOrder: async (orderId) => {
        // 1. Optimistic Update: Update local state immediately
        const originalOrders = get().orderHistory.orders;
        const updatedOrders = originalOrders.map(o => 
            o.id === orderId ? { ...o, status: 'cancelled' } : o
        );
        
        set(state => ({ orderHistory: { ...state.orderHistory, orders: updatedOrders } }));
        get().ui.triggerPageRender();

        try {
            // 2. Background DB Update
            const { error } = await supabase
                .from('orders')
                .update({ status: 'cancelled' })
                .eq('id', orderId);
                
            if (error) throw error;
        } catch (e) {
            console.error("Dismiss Failed:", e);
            // 3. Revert on error
            set(state => ({ orderHistory: { ...state.orderHistory, orders: originalOrders } }));
            get().ui.triggerPageRender();
            alert("Failed to dismiss order.");
        }
    },

     checkUrgency: () => {
        const role = get().auth.getUserRole();
        if (role !== 'manager' && role !== 'owner' && role !== 'god') return; // Updated role check
        // ...
        
        orders.forEach(order => {
            if (order.status === 'pending' || order.status === 'preparing') {
                const createdTime = new Date(order.created_at).getTime();
                
                if ((now - createdTime) > URGENCY_THRESHOLD_MS && !notifiedOrderIds.has(order.id)) {
                    
                    // 1. Generate Smart Name
                    const customer = order.customer_name || order.profiles?.full_name || 'Walk-in';
                    const firstItem = order.order_items?.[0]?.menu_items?.name || 'Order';
                    const alertText = `⚠️ ${firstItem} for ${customer} is overdue!`;

                    // 2. Click Action
                    import('@/utils/uiUtils.js').then(utils => {
                        utils.showToast(
                            alertText, 
                            'error', 
                            8000, // Stay longer
                            () => {
                                // On Click: Go to dashboard
                                window.location.hash = '#owner-dashboard';
                                // Optional: You could save a "highlightId" in a store to flash the row later
                            }
                        );
                    });
                }
            }
        });
    }
});