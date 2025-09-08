// src/store/checkoutSlice.js
import * as api from '@/services/apiService.js';

export const createCheckoutSlice = (set, get) => ({
    // --- STATE ---
    isSubmitting: false,      // True while the order is being sent to the API
    checkoutError: null,      // Holds any submission error
    lastSuccessfulOrderId: null, // Stores the ID for the confirmation page

    // --- ACTIONS ---
    submitOrder: async (customerDetails) => {
        set(state => ({ checkout: { ...state.checkout, isSubmitting: true, checkoutError: null } }));

        // Get necessary data from other slices
        const { items: cartItems, getCartTotal, clearCart } = get().cart;

        // Construct the order payload for the API
        const orderData = {
            customerDetails,
            items: cartItems,
            totalAmount: getCartTotal(),
        };

        try {
            // Get the session for the auth token
            const { data: { session } } = await window.supabase.auth.getSession();

            // The apiService will add the token to the header if it exists
            const submittedOrder = await api.submitOrder(orderData, session?.access_token);
            if (!submittedOrder || !submittedOrder.id) {
                throw new Error("API did not return a valid order confirmation.");
            }

            set(state => ({
                checkout: {
                    ...state.checkout,
                    isSubmitting: false,
                    lastSuccessfulOrderId: submittedOrder.id
                }
            }), false, 'checkout/submitSuccess');

            // Call the action from the cart slice to clear the cart

get().cart.clearCart();
            return true; // Signal success to the UI

        } catch (error) {
            console.error("Error submitting order:", error);
            set(state => ({
                checkout: { ...state.checkout, isSubmitting: false, checkoutError: error.message }
            }), false, 'checkout/submitError');
            return false; // Signal failure to the UI
        }
    },
});
