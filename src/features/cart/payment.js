// src/features/cart/payment.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY);

export async function handleCashPayment(btn) {
    btn.disabled = true;
    btn.textContent = "Processing...";
    
    const { submitCashOrder } = useAppStore.getState().checkout;
    const guestName = localStorage.getItem('guest_name'); 

    const result = await submitCashOrder(guestName);

    if (result.success) {
        uiUtils.showToast("Order Placed!", "success");
        // Reset view? usually router handles this
        window.location.hash = '#order-history';
    } else {
        uiUtils.showToast(result.error, "error");
        btn.disabled = false;
        btn.textContent = "Pay on Pickup (Cash)";
    }
}

export async function initializeStripeFlow(onSuccess) {
    const total = useAppStore.getState().cart.getCartTotal();
    const errorDiv = document.getElementById('stripe-error');
    
    try {
        const res = await fetch('/api/create-payment-intent', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ amount: total })
        });
        const { clientSecret, error } = await res.json();
        if (error) throw new Error(error);

        const mountPoint = document.getElementById('stripe-element-mount');
        if (!mountPoint) return; 

        const stripe = await stripePromise;
        const elements = stripe.elements({ clientSecret, appearance: { theme: 'stripe' } });
        const paymentElement = elements.create('payment');
        paymentElement.mount('#stripe-element-mount');

        const submitBtn = document.getElementById('stripe-submit-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = "Loading options...";
        
        paymentElement.on('ready', () => {
             submitBtn.disabled = false;
             submitBtn.textContent = `Confirm Payment ($${total.toFixed(2)})`;
        });

        submitBtn.onclick = async () => {
            submitBtn.disabled = true;
            submitBtn.textContent = "Processing...";
            
            const result = await stripe.confirmPayment({
                elements,
                confirmParams: {
                    return_url: window.location.origin + '/#order-history',
                },
                redirect: 'if_required'
            });

            if (result.error) {
                if (errorDiv) errorDiv.textContent = result.error.message;
                submitBtn.disabled = false;
                submitBtn.textContent = `Confirm Payment ($${total.toFixed(2)})`;
            } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
                const { submitPaidOrder } = useAppStore.getState().checkout;
                const guestName = localStorage.getItem('guest_name');
                const saveRes = await submitPaidOrder(result.paymentIntent, guestName);
                
                if (saveRes.success) {
                    uiUtils.showToast("Payment Successful!", "success");
                    if (onSuccess) onSuccess();
                    window.location.hash = '#order-history';
                } else {
                    if (errorDiv) errorDiv.textContent = "Payment worked, but database save failed. Contact staff.";
                }
            }
        };
    } catch (e) {
        console.error(e);
        if (errorDiv) errorDiv.textContent = "Payment System Error.";
    }
}