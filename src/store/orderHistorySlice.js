// src/store/orderHistorySlice.js
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';

export const createOrderHistorySlice = (set, get) => ({
    orders: [],
    isLoading: false,
    hasLoaded: false,
    error: null,
    notifiedOrderIds: new Set(),

    // --- MAIN FETCH ACTION ---
    fetchOrderHistory: async () => {
        const state = get().orderHistory;
        console.log(`%c[OrderHistorySlice] fetchOrderHistory() CALLED. Loading: ${state.isLoading}, HasLoaded: ${state.hasLoaded}`, "color: violet");

        // 1. GUARD CLAUSE: Stop the recursion loop
        if (state.isLoading) {
            console.warn("[OrderHistorySlice] Fetch skipped: Already in progress.");
            return;
        }
        if (state.hasLoaded) {
            console.log("[OrderHistorySlice] Fetch skipped: Data already loaded. Use refreshOrderHistory() to force update.");
            return;
        }

        // 2. Start Loading
        set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            console.log("[OrderHistorySlice] Fetching orders from API...");
            const ordersData = await api.getOrderHistory(session.access_token);
            console.log(`[OrderHistorySlice] Fetch success. Got ${ordersData ? ordersData.length : 0} orders.`);

            set(state => ({ 
                orderHistory: { 
                    ...state.orderHistory, 
                    orders: ordersData || [], 
                    isLoading: false,
                    hasLoaded: true // <--- IMPORTANT: Marks data as fresh
                } 
            }));
            
            // 3. Update UI
            if (get().ui && get().ui.triggerPageRender) {
                console.log("[OrderHistorySlice] Triggering Page Render.");
                get().ui.triggerPageRender();
            }

        } catch (error) {
            console.error("[OrderHistorySlice] Fetch Failed:", error);
            set(state => ({ 
                orderHistory: { ...state.orderHistory, isLoading: false, error: error.message } 
            }));
        }
    },

    // --- FORCE REFRESH ACTION ---
    // Call this when you add/delete an order manually
    refreshOrderHistory: () => {
        console.log("[OrderHistorySlice] Forcing Refresh...");
        // Reset hasLoaded to false, so the next fetch call is allowed to run
        set(state => ({ orderHistory: { ...state.orderHistory, hasLoaded: false } }));
        // Trigger the fetch immediately
        get().orderHistory.fetchOrderHistory();
    },

    // --- UPDATED: Real Manual Order ---
    createManualOrder: async (orderDetails) => {
        console.log("[OrderHistorySlice] createManualOrder() called", orderDetails);
        try {
            const { items, total } = orderDetails;
            const { data: { session } } = await supabase.auth.getSession();

            // 1. Create Order
            const { data: orderData, error: orderError } = await supabase
                .from('orders')
                .insert([{
                    user_id: session.user.id,
                    total_amount: total,
                    status: 'pending'
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

            console.log("[OrderHistorySlice] Manual Order Created Successfully.");
            
            // 3. FORCE REFRESH
            get().orderHistory.refreshOrderHistory();
            return true;
        } catch (e) {
            console.error("[OrderHistorySlice] Manual Order Error:", e);
            alert(`Failed: ${e.message}`);
            return false;
        }
    },

    // --- Dismiss/Cancel Order ---
    dismissOrder: async (orderId) => {
        console.log(`[OrderHistorySlice] dismissOrder(${orderId})`);
        
        // Optimistic update
        const originalOrders = get().orderHistory.orders;
        const updatedOrders = originalOrders.map(o => 
            o.id === orderId ? { ...o, status: 'cancelled' } : o
        );
        
        set(state => ({ orderHistory: { ...state.orderHistory, orders: updatedOrders } }));
        get().ui.triggerPageRender();

        try {
            const { error } = await supabase
                .from('orders')
                .update({ status: 'cancelled' })
                .eq('id', orderId);
                
            if (error) throw error;
            console.log("[OrderHistorySlice] Order dismissed in DB.");
        } catch (e) {
            console.error("[OrderHistorySlice] Dismiss Failed:", e);
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
            if (order.status === 'pending' || order.status === 'preparing') {
                const createdTime = new Date(order.created_at).getTime();
                if ((now - createdTime) > URGENCY_THRESHOLD_MS && !notifiedOrderIds.has(order.id)) {
                    console.log(`[OrderHistorySlice] Urgency Alert for Order #${order.id}`);
                    
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