// src/store/orderHistorySlice.js
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { TABLES } from '@/config/tenancy.js'; // <--- NEW IMPORT

export const createOrderHistorySlice = (set, get) => ({
    orders: [],
    isLoading: false,
    hasLoaded: false,
    error: null,
    notifiedOrderIds: new Set(),

    // --- MAIN FETCH ACTION ---
    fetchOrderHistory: async (silent = false) => {
        const state = get().orderHistory;
        
        if (state.isLoading) return;
        if (state.hasLoaded && !silent) return;

        if (!silent) {
            set(state => ({ orderHistory: { ...state.orderHistory, isLoading: true, error: null } }));
        }

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            // API handles the table names internally, so this call is safe
            const ordersData = await api.getOrderHistory(session.access_token);

            set(state => ({ 
                orderHistory: { 
                    ...state.orderHistory, 
                    orders: ordersData || [], 
                    isLoading: false, 
                    hasLoaded: true 
                } 
            }));
            
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

    // --- MANUAL ORDER ---
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

            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            await api.createManualOrder(orderDetails, session.access_token);

            await get().orderHistory.fetchOrderHistory(true);
            return true;

        } catch (e) {
            console.error("[OrderHistorySlice] Manual Order Failed:", e);
            // alert(`Failed to create order: ${e.message}`); // Optional: Remove alert if you prefer Toasts only
            get().orderHistory.fetchOrderHistory(true);
            return false;
        }
    },

    // --- DISMISS ORDER (Fixing the Crash) ---
    dismissOrder: async (orderId) => {
        // 1. Optimistic Update
        const originalOrders = get().orderHistory.orders;
        const updatedOrders = originalOrders.map(o => 
            o.id === orderId ? { ...o, status: 'cancelled' } : o
        );
        
        set(state => ({ orderHistory: { ...state.orderHistory, orders: updatedOrders } }));
        get().ui.triggerPageRender();

        try {
            // 2. Background DB Update
            // FIX: Use TABLES.ORDERS instead of 'orders'
            const { error } = await supabase
                .from(TABLES.ORDERS) 
                .update({ status: 'cancelled' })
                .eq('id', orderId);
                
            if (error) {
                console.error("Dismiss DB Error:", error); // Log the specific DB error
                throw error;
            }
        } catch (e) {
            console.error("Dismiss Failed:", e);
            // 3. Revert on error
            set(state => ({ orderHistory: { ...state.orderHistory, orders: originalOrders } }));
            get().ui.triggerPageRender();
            // alert("Failed to dismiss order."); // Use toast in UI instead if preferred
        }
    },

    checkUrgency: () => {
        const role = get().auth.getUserRole();
        if (role !== 'manager' && role !== 'owner' && role !== 'god') return;
        
        if (window.location.hash === '#order-history') return;

        const { orders, notifiedOrderIds } = get().orderHistory;
        
        const now = Date.now();
        const URGENCY_THRESHOLD_MS = 15 * 60 * 1000; 
        const MAX_AGE_MS = 24 * 60 * 60 * 1000; 

        const newNotifiedSet = new Set(notifiedOrderIds);
        let hasNewAlerts = false;

        orders.forEach(order => {
            if (order.status === 'pending' || order.status === 'preparing') {
                
                const createdTime = new Date(order.created_at).getTime();
                const pickupTime = new Date(order.pickup_time || order.created_at).getTime();

                if (now - createdTime > MAX_AGE_MS) return;
                if (pickupTime > now) return;

                if ((now - pickupTime) > URGENCY_THRESHOLD_MS && !newNotifiedSet.has(order.id)) {
                    
                    newNotifiedSet.add(order.id);
                    hasNewAlerts = true;

                    const customer = order.customer_name || order.profiles?.full_name || 'Walk-in';
                    const firstItem = order.order_items?.[0]?.menu_items?.name || 'Order';
                    const isImportant = order.profiles?.staff_note_urgency === 'alert';
                    
                    let alertText = `⚠️ ${firstItem} for ${customer} Due`;
                    if (isImportant) alertText = `🚨 VIP: ${firstItem} for ${customer} Due`;

                    import('@/utils/uiUtils.js').then(utils => {
                        utils.showToast(
                            alertText, 
                            'error', 
                            isImportant ? 12000 : 8000, 
                            () => {
                                // Click Action
                                get().ui.setHighlightOrderId(order.id);
                                if (window.location.hash === '#order-history') {
                                    get().ui.triggerPageRender();
                                } else {
                                    window.location.hash = '#order-history';
                                }
                            }
                        );
                    });
                }
            }
        });

        if (hasNewAlerts) {
            set(state => ({ orderHistory: { ...state.orderHistory, notifiedOrderIds: newNotifiedSet } }));
        }
    }
});