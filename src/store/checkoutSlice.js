// 1. ADD THIS IMPORT (Critical)
import { supabase } from '@/supabaseClient.js'; 

export const createCheckoutSlice = (set, get) => ({
    isProcessing: false,
    error: null,
    lastSuccessfulOrderId: null,

    // --- VALIDATION HELPER ---
    canPayWithCash: () => {
        // Safely access settings (handle case where settings might not be loaded yet)
        const settings = get().siteSettings.settings || {};
        const { paymentConfig } = settings;
        const { getTotalPrice, items } = get().cart;

        // Default rules if settings haven't loaded or config is missing
        const config = paymentConfig || { enableCash: true, maxCashAmount: 100, maxCashItems: 10 };

        if (!config.enableCash) {
            return { allowed: false, reason: "Pay on Pickup is currently disabled." };
        }

        if (getTotalPrice() > config.maxCashAmount) {
            return { allowed: false, reason: `Orders over $${config.maxCashAmount} require online payment.` };
        }

        const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
        if (totalItems > config.maxCashItems) {
            return { allowed: false, reason: `Orders with more than ${config.maxCashItems} items require online payment.` };
        }

        return { allowed: true };
    },

    submitCashOrder: async () => {
        // 1. Run Validation
        const validation = get().checkout.canPayWithCash();
        if (!validation.allowed) {
            return { success: false, error: validation.reason };
        }

        set(state => ({ checkout: { ...state.checkout, isProcessing: true, error: null } }));

        try {
            const { user } = get().auth;
            const { items, getTotalPrice, clearCart } = get().cart;

            if (!user) throw new Error("You must be logged in to place an order.");

            // 2. Insert Order Header
            const { data: orderData, error: orderError } = await supabase
                .from('orders')
                .insert([{
                    user_id: user.id,
                    total_amount: getTotalPrice(),
                    status: 'pending',
                    payment_status: 'pending', 
                    payment_method: 'cash'
                }])
                .select()
                .single();
                
            if (orderError) throw orderError;

            // 3. Insert Order Items
            const orderItems = items.map(item => ({
                order_id: orderData.id,
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_time: item.price
            }));

            const { error: itemsError } = await supabase
                .from('order_items')
                .insert(orderItems);

            if (itemsError) throw itemsError;

            // 4. Success Cleanup
            clearCart();
            set(state => ({ 
                checkout: { 
                    ...state.checkout, 
                    isProcessing: false, 
                    lastSuccessfulOrderId: orderData.id 
                } 
            }));
            
            // Refresh history so it shows up immediately
            get().orderHistory.refreshOrderHistory();
            
            return { success: true, orderId: orderData.id };

        } catch (error) {
            console.error("Checkout Failed:", error);
            set(state => ({ checkout: { ...state.checkout, isProcessing: false, error: error.message } }));
            return { success: false, error: error.message };
        }
    }
});