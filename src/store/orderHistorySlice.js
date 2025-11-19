import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';

export const createOrderHistorySlice = (set, get) => ({
    orders: [],
    isLoading: false,
    hasLoaded: false,
    error: null,
    notifiedOrderIds: new Set(),

    fetchOrderHistory: async () => {
        const state = get().orderHistory;
        // FIX: Removed loop check here so manual refreshes work reliably
        if (state.isLoading) return; 

        set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            const { getUserRole } = get().auth;
            const role = getUserRole();
            
            const ordersData = await api.getOrderHistory(session.access_token);

            set(state => ({ 
                orderHistory: { 
                    ...state.orderHistory, 
                    orders: ordersData || [], 
                    isLoading: false,
                    hasLoaded: true
                } 
            }));
            
            if (get().ui && get().ui.triggerPageRender) get().ui.triggerPageRender();

        } catch (error) {
            console.error("Fetch Orders Failed:", error);
            set(state => ({ 
                orderHistory: { ...state.orderHistory, isLoading: false, error: error.message } 
            }));
        }
    },

    // --- UPDATED: Real Manual Order ---
    createManualOrder: async (orderDetails) => {
        try {
            const { customerName, items, total } = orderDetails;
            const { data: { session } } = await supabase.auth.getSession();

            // 1. Create Order
            const { data: orderData, error: orderError } = await supabase
                .from('orders')
                .insert([{
                    user_id: session.user.id, // Admin creates it, so it's attached to admin account
                    total_amount: total,
                    status: 'pending'
                    // Removed 'is_manual' to fix 400 Error
                }])
                .select()
                .single();

            if (orderError) throw orderError;

            // 2. Add Items
            const orderItemsData = items.map(item => ({
                order_id: orderData.id,
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_time: item.price
            }));

            const { error: itemError } = await supabase
                .from('order_items')
                .insert(orderItemsData);

            if (itemError) throw itemError;

            // 3. Refresh
            get().orderHistory.fetchOrderHistory();
            return true;
        } catch (e) {
            console.error("Manual Order Error:", e);
            alert(`Failed: ${e.message}`);
            return false;
        }
    },

    // --- NEW: Dismiss/Cancel Order ---
    dismissOrder: async (orderId) => {
        // Optimistic update: Mark as cancelled locally
        const originalOrders = get().orderHistory.orders;
        const updatedOrders = originalOrders.map(o => 
            o.id === orderId ? { ...o, status: 'cancelled' } : o
        );
        
        set(state => ({ orderHistory: { ...state.orderHistory, orders: updatedOrders } }));
        get().ui.triggerPageRender();

        try {
            const { data: { session } } = await supabase.auth.getSession();
            // We use the Supabase client directly for specific status updates to avoid API overhead
            const { error } = await supabase
                .from('orders')
                .update({ status: 'cancelled' })
                .eq('id', orderId);
                
            if (error) throw error;
        } catch (e) {
            console.error("Dismiss Failed:", e);
            // Revert
            set(state => ({ orderHistory: { ...state.orderHistory, orders: originalOrders } }));
            get().ui.triggerPageRender();
            alert("Failed to dismiss order.");
        }
    },

    checkUrgency: () => {
        const role = get().auth.getUserRole();
        if (role !== 'manager' && role !== 'owner') return;
        if (window.location.hash === '#order-history') return;

        const { orders, notifiedOrderIds } = get().orderHistory;
        const now = Date.now();
        const URGENCY_THRESHOLD_MS = 15 * 60 * 1000;

        orders.forEach(order => {
            // Cancelled/Completed orders are ignored
            if (order.status === 'pending' || order.status === 'preparing') {
                const createdTime = new Date(order.created_at).getTime();
                if ((now - createdTime) > URGENCY_THRESHOLD_MS && !notifiedOrderIds.has(order.id)) {
                    import('@/utils/uiUtils.js').then(utils => {
                        utils.showToast(`⚠️ Order #${order.id.slice(0,4)} is overdue!`, 'error');
                    });
                    set(state => {
                        const newSet = new Set(state.orderHistory.notifiedOrderIds);
                        newSet.add(order.id);
                        return { orderHistory: { ...state.orderHistory, notifiedOrderIds: newSet } };
                    });
                }
            }
        });
    }
});