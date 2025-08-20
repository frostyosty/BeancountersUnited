// src/store/checkoutSlice.js
import * as api from '@/services/apiService.js';
import { useAppStore } from './appStore.js'; // We need access to other slices

/**
 * Creates a Zustand slice for managing the checkout process.
 *
 * @param {Function} set - Zustand's state setter function.
 * @param {Function} get - Zustand's state getter function.
 * @returns {object} The checkout slice of the store.
 */
export const createCheckoutSlice = (set, get) => ({
    // --- STATE ---
    isSubmitting: false,      // True while the order is being sent to the API
    error: null,              // Holds any submission error
    lastSuccessfulOrderId: null, // Stores the ID of the last order for the confirmation page

    // --- ACTIONS ---

    /**
     * Submits the current cart as a new order.
     * @param {object} customerDetails - An object with { name, email, phone, pickupTime, specialRequests }.
     * @returns {Promise<boolean>} - True if submission was successful, false otherwise.
     */
    submitOrder: async (customerDetails) => {
        set({ isSubmitting: true, error: null }, false, 'checkout/submitStart');

        // Get necessary data from other slices
        const { items: cartItems, getCartTotal, clearCart } = useAppStore.getState();
        const { user } = useAppStore.getState();

        // Construct the order payload for the API
        const orderData = {
            ...customerDetails,
            items: cartItems.map(item => ({
                menu_item_id: item.id, // Ensure this matches what the API expects
                quantity: item.quantity,
                price_at_order: item.price
            })),
            total_amount: getCartTotal(),
            user_id: user?.id || null,
        };

        try {
            const submittedOrder = await api.submitOrder(orderData);
            if (!submittedOrder || !submittedOrder.id) {
                throw new Error("API did not return a valid order confirmation.");
            }

            set({
                isSubmitting: false,
                lastSuccessfulOrderId: submittedOrder.id
            }, false, 'checkout/submitSuccess');

            clearCart(); // Clear the cart after a successful order
            return true; // Signal success to the UI

        } catch (error) {
            console.error("Error submitting order:", error);
            set({ isSubmitting: false, error: error.message }, false, 'checkout/submitError');
            return false; // Signal failure to the UI
        }
    },
});