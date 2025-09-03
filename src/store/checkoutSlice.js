// src/store/checkoutSlice.js
import * as api from '@/services/apiService.js';

export const createCheckoutSlice = (set, get) => ({
    // State for the checkout slice
    isSubmitting: false,
    error: null,
    lastSuccessfulOrderId: null,

    // Action to submit the order
    submitOrder: async (customerDetails) => {
        // --- CORRECTED NESTED UPDATE ---
        set(state => ({
            checkout: { ...state.checkout, isSubmitting: true, error: null }
        }), false, 'checkout/submitStart');

        // Get necessary data from other slices using get()
        const { items: cartItems, getCartTotal } = get().cart;
        const { user } = get().auth;

        const orderData = {
            ...customerDetails,
            items: cartItems.map(item => ({
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_order: item.price
            })),
            total_amount: getCartTotal(),
            user_id: user?.id || null,
        };

        try {
            // We need to pass the auth token for this protected API route
            const token = get().auth.user?.token; // Assuming token is on user, better get from session
            const { data: { session } } = await window.supabase.auth.getSession();
            
            const submittedOrder = await api.submitOrder(orderData, session?.access_token);
            if (!submittedOrder || !submittedOrder.id) {
                throw new Error("API did not return a valid order confirmation.");
            }

            // --- CORRECTED NESTED UPDATE ---
            set(state => ({
                checkout: {
                    ...state.checkout,
                    isSubmitting: false,
                    lastSuccessfulOrderId: submittedOrder.id
                }
            }), false, 'checkout/submitSuccess');

            // --- CORRECTED CROSS-SLICE ACTION CALL ---
            // Call the clearCart action from the cart slice
            get().cart.clearCart();

            return true; // Signal success

        } catch (error) {
            console.error("Error submitting order:", error);
            // --- CORRECTED NESTED UPDATE ---
            set(state => ({
                checkout: { ...state.checkout, isSubmitting: false, error: error.message }
            }), false, 'checkout/submitError');
            return false; // Signal failure
        }
    },
});