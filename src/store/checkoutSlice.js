// src/store/checkoutSlice.js
import { supabase } from '@/supabaseClient.js'; 

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
    submitCashOrder: async () => {
        const validation = get().checkout.canPayWithCash();
        if (!validation.allowed) {
            return { success: false, error: validation.reason };
        }

        set(state => ({ checkout: { ...state.checkout, isProcessing: true, error: null } }));

        try {
            const { user, profile } = get().auth;
            const { items, getCartTotal, clearCart } = get().cart;

            if (!user) throw new Error("You must be logged in to place an order.");
            
            const customerName = profile?.full_name || profile?.email || 'Customer';

            // 1. Insert Order Header
            const { data: orderData, error: orderError } = await supabase
                .from('orders')
                .insert([{
                    user_id: user.id,
                    total_amount: getCartTotal(),
                    status: 'pending',         
                    payment_status: 'pending', 
                    payment_method: 'cash',
                    customer_name: customerName,
                    customer_email: user.email,
                    pickup_time: new Date().toISOString() 
                }])
                .select()
                .single();
                
            if (orderError) throw orderError;

            // 2. Insert Order Items
            const orderItems = items.map(item => ({
                order_id: orderData.id,
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_order: parseFloat(item.price),
                selected_options: item.selectedOptions || []
            }));

            const { error: itemsError } = await supabase
                .from('order_items')
                .insert(orderItems);

            // FIX: Handle "Item Deleted" error and Rollback
            if (itemsError) {
                // Rollback: Delete the header we just made so we don't have empty ghost orders
                await supabase.from('orders').delete().eq('id', orderData.id);

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
            
            get().orderHistory.fetchOrderHistory();
            
            return { success: true, orderId: orderData.id };

        } catch (error) {
            console.error("Checkout Failed:", error);
            set(state => ({ checkout: { ...state.checkout, isProcessing: false, error: error.message } }));
            return { success: false, error: error.message };
        }
    },

    // --- ACTION: STRIPE PAYMENT SUCCESS ---
    submitPaidOrder: async (paymentIntent) => {
        set(state => ({ checkout: { ...state.checkout, isProcessing: true, error: null } }));

        try {
            const { user, profile } = get().auth;
            const { items, getCartTotal, clearCart } = get().cart;

            if (!user) throw new Error("User session missing during payment finalization.");
            
            const customerName = profile?.full_name || profile?.email || 'Customer';

            // 1. Insert Order Header
            const { data: orderData, error: orderError } = await supabase
                .from('orders')
                .insert([{
                    user_id: user.id,
                    total_amount: getCartTotal(),
                    status: 'pending',        
                    payment_status: 'paid',   
                    payment_method: 'stripe',
                    customer_name: customerName,
                    customer_email: user.email,
                    pickup_time: new Date().toISOString()
                }])
                .select()
                .single();

            if (orderError) throw orderError;

            // 2. Insert Order Items
            const orderItems = items.map(item => ({
                order_id: orderData.id,
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_order: parseFloat(item.price),
                selected_options: item.selectedOptions || []
            }));

            const { error: itemsError } = await supabase
                .from('order_items')
                .insert(orderItems);

            // FIX: Handle "Item Deleted" error and Rollback
            if (itemsError) {
                // Rollback: Delete the header
                await supabase.from('orders').delete().eq('id', orderData.id);

                if (itemsError.code === '23503') {
                    throw new Error("Item no longer available. Please update your cart.");
                }
                throw itemsError;
            }

            // 3. Cleanup
            clearCart();
            set(state => ({ 
                checkout: { 
                    ...state.checkout, 
                    isProcessing: false, 
                    lastSuccessfulOrderId: orderData.id 
                } 
            }));

            get().orderHistory.fetchOrderHistory();

            return { success: true, orderId: orderData.id };

        } catch (error) {
            console.error("Stripe Order Save Failed:", error);
            set(state => ({ checkout: { ...state.checkout, isProcessing: false, error: "Order save failed: " + error.message } }));
            return { success: false, error: error.message };
        }
    }
});