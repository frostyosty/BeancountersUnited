import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js'; // Needed for manual insert

export const createOrderHistorySlice = (set, get) => ({
    orders: [],
    isLoading: false,
    hasLoaded: false,
    error: null,
    notifiedOrderIds: new Set(),

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

    createManualOrder: async () => {
        try {
            // 1. Get a random item from the menu to simulate a real order
            const menuItems = get().menu.items;
            if (menuItems.length === 0) await get().menu.fetchMenu(); // Ensure menu is loaded

            const randomItem = get().menu.items[Math.floor(Math.random() * get().menu.items.length)];
            if (!randomItem) throw new Error("Menu is empty");

            const { data: { session } } = await supabase.auth.getSession();

            // 2. Insert a "Pending" order directly via Supabase
            // (In a real app, you'd use a specific API endpoint, but this works for the requested "Manual/Test" feature)
            const { data: orderData, error: orderError } = await supabase
                .from('orders')
                .insert([{
                    user_id: session.user.id,
                    total_amount: randomItem.price,
                    status: 'pending',
                    is_manual: true // Optional: if you add this column later
                }])
                .select()
                .single();

            if (orderError) throw orderError;

            // 3. Add the item to the order
            const { error: itemError } = await supabase
                .from('order_items')
                .insert([{
                    order_id: orderData.id,
                    menu_item_id: randomItem.id,
                    quantity: 1,
                    price_at_time: randomItem.price
                }]);

            if (itemError) throw itemError;

            // 4. Refresh list
            get().orderHistory.refreshOrderHistory();
            return true;
        } catch (e) {
            console.error("Manual Order Error:", e);
            alert("Failed to create walk-in order.");
            return false;
        }
    },

    refreshOrderHistory: () => {
        set(state => ({ orderHistory: { ...state.orderHistory, hasLoaded: false } }));
        get().orderHistory.fetchOrderHistory();
    },

    // --- NEW: Urgency Checker ---
    checkUrgency: () => {
        // Only run if user is manager/owner
        const role = get().auth.getUserRole();
        if (role !== 'manager' && role !== 'owner') return;

        // Don't notify if we are ON the order page
        if (window.location.hash === '#order-history') return;

        const { orders, notifiedOrderIds } = get().orderHistory;
        const now = Date.now();
        const URGENCY_THRESHOLD_MS = 15 * 60 * 1000; // 15 Minutes (Average of 10 and 20)

        orders.forEach(order => {
            if (order.status === 'pending' || order.status === 'preparing') {
                const createdTime = new Date(order.created_at).getTime();
                const elapsed = now - createdTime;

                // If it's been waiting too long AND we haven't notified yet
                if (elapsed > URGENCY_THRESHOLD_MS && !notifiedOrderIds.has(order.id)) {

                    // Notify!
                    import('@/utils/uiUtils.js').then(utils => {
                        utils.showToast(`⚠️ Order #${order.id.slice(0, 4)} is overdue!`, 'error');
                    });

                    // Mark as notified so we don't spam
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