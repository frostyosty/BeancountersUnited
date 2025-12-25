// src/store/checkoutSlice.js
import { supabase } from '@/supabaseClient.js'; 
import { TABLES } from '@/config/tenancy.js'; // Ensure this exists

export const createCheckoutSlice = (set, get) => ({
    isProcessing: false,
    error: null,
    lastSuccessfulOrderId: null,

    // --- VALIDATION HELPER ---
    canPayWithCash: () => {
        const settings = get().siteSettings.settings || {};
        const { paymentConfig } = settings;
        const { getCartTotal, items } = get().cart;

        const config = paymentConfig || { enableCash: true, maxCashAmount: 100, maxCashItems: 10 };

        if (!config.enableCash) {
            return { allowed: false, reason: "Pay on Pickup is currently disabled." };
        }

        if (getCartTotal() > config.maxCashAmount) {
            return { allowed: false, reason: `Orders over $${config.maxCashAmount} require online payment.` };
        }

        const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
        if (totalItems > config.maxCashItems) {
            return { allowed: false, reason: `Orders with more than ${config.maxCashItems} items require online payment.` };
        }

        return { allowed: true };
    },

    // --- ACTION: PAY ON PICKUP ---
    submitCashOrder: async (guestName = null) => {
        const validation = get().checkout.canPayWithCash();
        if (!validation.allowed) {
            return { success: false, error: validation.reason };
        }

        set(state => ({ checkout: { ...state.checkout, isProcessing: true, error: null } }));

        try {
            const { user, profile } = get().auth;
            const { items, getCartTotal, clearCart } = get().cart;

            // 1. User/Guest Logic
            if (!user && !guestName) throw new Error("You must be logged in or provide a guest name.");
            
            let finalName = 'Guest';
            let finalEmail = null;
            let userId = null;

            if (user) {
                userId = user.id;
                finalEmail = user.email;
                finalName = profile?.full_name || (user.email.includes('@mealmates.local') ? user.email.split('@')[0] : user.email);
            } else {
                finalName = guestName;
                finalEmail = null;
                userId = null;
            }

            // 2. Insert Order Header
            const { data: orderData, error: orderError } = await supabase
                .from(TABLES.ORDERS)
                .insert([{
                    user_id: userId,
                    total_amount: getCartTotal(),
                    status: 'pending',         
                    payment_status: 'pending', 
                    payment_method: 'cash',
                    customer_name: finalName,
                    customer_email: finalEmail,
                    pickup_time: new Date().toISOString()
                }])
                .select()
                .single();
                
            if (orderError) throw orderError;

            // 3. Insert Order Items
            const orderItems = items.map(item => ({
                order_id: orderData.id,
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_order: parseFloat(item.price),
                selected_options: item.selectedOptions || []
            }));

            const { error: itemsError } = await supabase
                .from(TABLES.ITEMS)
                .insert(orderItems);

            // 4. Rollback if items fail
            if (itemsError) {
                await supabase.from(TABLES.ORDERS).delete().eq('id', orderData.id);

                if (itemsError.code === '23503') {
                    throw new Error("One or more items in your cart no longer exist on the menu. Please clear your cart and try again.");
                }
                throw itemsError;
            }

 // 3. Success Cleanup
            clearCart();
            set(state => ({ 
                checkout: { 
                    ...state.checkout, 
                    isProcessing: false, 
                    lastSuccessfulOrderId: orderData.id 
                } 
            }));
            
            // FIX: Only fetch history if we are actually logged in
            if (user) {
                get().orderHistory.fetchOrderHistory();
            }
            
            return { success: true, orderId: orderData.id };

        } catch (error) {
            console.error("Checkout Failed:", error);
            set(state => ({ checkout: { ...state.checkout, isProcessing: false, error: error.message } }));
            return { success: false, error: error.message };
        }
    },

    // --- ACTION: STRIPE PAYMENT SUCCESS ---
    submitPaidOrder: async (paymentIntent, guestName = null) => {
        set(state => ({ checkout: { ...state.checkout, isProcessing: true, error: null } }));

        try {
            const { user, profile } = get().auth;
            const { items, getCartTotal, clearCart } = get().cart;

            // 1. User/Guest Logic
            if (!user && !guestName) throw new Error("You must be logged in or provide a guest name.");
            
            let finalName = 'Guest';
            let finalEmail = null;
            let userId = null;

            if (user) {
                userId = user.id;
                finalEmail = user.email;
                finalName = profile?.full_name || (user.email.includes('@mealmates.local') ? user.email.split('@')[0] : user.email);
            } else {
                finalName = guestName;
                finalEmail = null; 
                userId = null;
            }

            // 2. Insert Order Header
            const { data: orderData, error: orderError } = await supabase
                .from(TABLES.ORDERS)
                .insert([{
                    user_id: userId,
                    total_amount: getCartTotal(),
                    status: 'pending',        
                    payment_status: 'paid',   
                    payment_method: 'stripe',
                    customer_name: finalName,
                    customer_email: finalEmail,
                    pickup_time: new Date().toISOString()
                }])
                .select()
                .single();

            if (orderError) throw orderError;

            // 3. Insert Order Items
            const orderItems = items.map(item => ({
                order_id: orderData.id,
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_order: parseFloat(item.price),
                selected_options: item.selectedOptions || []
            }));

            const { error: itemsError } = await supabase
                .from(TABLES.ITEMS)
                .insert(orderItems);

            // 4. Rollback if items fail
            if (itemsError) {
                await supabase.from(TABLES.ORDERS).delete().eq('id', orderData.id);

                if (itemsError.code === '23503') {
                    throw new Error("One or more items in your cart no longer exist. Please clear cart and try again.");
                }
                throw itemsError;
            }

 // 3. Success Cleanup
            clearCart();
            set(state => ({ 
                checkout: { 
                    ...state.checkout, 
                    isProcessing: false, 
                    lastSuccessfulOrderId: orderData.id 
                } 
            }));
            
            // FIX: Only fetch history if we are actually logged in
            if (user) {
                get().orderHistory.fetchOrderHistory();
            }
            
            return { success: true, orderId: orderData.id };

        } catch (error) {
            console.error("Stripe Order Save Failed:", error);
            set(state => ({ checkout: { ...state.checkout, isProcessing: false, error: "Order save failed: " + error.message } }));
            return { success: false, error: error.message };
        }
    }
});