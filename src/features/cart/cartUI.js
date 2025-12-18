import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY);

// State for Guest Flow
let isGuestCheckout = false;

// --- CSS for Responsive Cart ---
const CART_CSS = `
<style>
    .cart-subtotal-col { display: none; }
    @media (min-width: 768px) {
        .cart-subtotal-col { 
            display: block; 
            font-weight: 600; 
            width: 80px; 
            text-align: right; 
            margin-right: 15px;
        }
    }
</style>
`;

export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { items, getCartTotal } = useAppStore.getState().cart;
    const { isAuthenticated } = useAppStore.getState().auth;
    const { settings } = useAppStore.getState().siteSettings;
    const { canPayWithCash } = useAppStore.getState().checkout;

    // 1. Empty State
    if (items.length === 0) {
        mainContent.innerHTML = `
            <div class="empty-state">
                <h2>Your Cart is Empty</h2>
                <p>Looks like you haven't added anything yet.</p>
                <a href="#menu" class="button-primary">Browse Menu</a>
            </div>`;
        return;
    }

    // 2. Build Items List
    const cartItemsHTML = items.map(item => {
        const price = parseFloat(item.price) || 0;
        const subtotal = price * item.quantity;
        
        const optionsDisplay = (item.selectedOptions && item.selectedOptions.length > 0)
            ? `<div style="font-size:0.8rem; color:#d63384; margin-top:2px; line-height:1.2;">+ ${item.selectedOptions.join(', ')}</div>`
            : '';

        const uniqueId = item.cartId || item.id;

        return `
        <div class="cart-item" data-unique-id="${uniqueId}" style="display:flex; align-items:center; justify-content:space-between; padding:15px 0; border-bottom:1px solid #eee;">
            <div style="display:flex; gap:15px; align-items:center; overflow:hidden;">
                <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" 
                     style="width:60px; height:60px; object-fit:cover; border-radius:6px; flex-shrink:0;">
                <div style="min-width:0;">
                    <h4 style="margin:0; font-size:1rem; line-height:1.2;">${item.name}</h4>
                    ${optionsDisplay}
                    <p style="margin:2px 0 0 0; color:#666; font-size:0.9rem;">$${price.toFixed(2)}</p>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
                <div class="quantity-selector" style="display:flex; align-items:center; border:1px solid #ddd; border-radius:4px;">
                    <button class="quantity-btn decrease-qty" data-unique-id="${uniqueId}" style="padding:5px 10px; background:none; border:none; cursor:pointer;">-</button>
                    <span style="padding:0 5px; min-width:20px; text-align:center;">${item.quantity}</span>
                    <button class="quantity-btn increase-qty" data-unique-id="${uniqueId}" style="padding:5px 10px; background:none; border:none; cursor:pointer;">+</button>
                </div>
                <span class="cart-subtotal-col">$${subtotal.toFixed(2)}</span>
                <button class="delete-icon-btn remove-item-btn" data-unique-id="${uniqueId}" title="Remove">×</button>
            </div>
        </div>`;
    }).join('');

    const total = getCartTotal();

    // 3. Payment Logic (Auth OR Guest Mode)
    let paymentSectionHTML = '';
    const savedGuestName = localStorage.getItem('guest_name');
    
    // Determine if we show payment buttons
    const showPayment = isAuthenticated || isGuestCheckout;

    if (!showPayment) {
        // --- SHOW LOGIN / GUEST OPTIONS ---
        let guestBtn = savedGuestName 
            ? `<button class="button-secondary" id="guest-continue-btn" style="width:100%; margin-bottom:10px;">Continue as ${savedGuestName}</button>`
            : `<button class="button-secondary" id="guest-start-btn" style="width:100%; margin-bottom:10px;">Continue as Guest</button>`;

        paymentSectionHTML = `
            <div style="margin-top:30px; padding:20px; background:#f9f9f9; border-radius:8px; border:1px solid #eee;">
                <h3 style="text-align:center; margin-bottom:15px;">Checkout</h3>
                ${guestBtn}
                <div style="text-align:center; font-size:0.9rem; margin:10px 0;">— OR —</div>
                <button class="button-primary" id="cart-login-btn" style="width:100%;">Login / Sign Up (Save History)</button>
            </div>`;
    } else {
        // --- SHOW PAYMENT BUTTONS ---
        const cashRule = canPayWithCash();
        const enableStripe = settings.paymentConfig?.enableStripe !== false;

        const cashBtn = cashRule.allowed 
            ? `<button id="pay-cash-btn" class="button-secondary" style="width:100%; margin-bottom:10px; padding:15px;">Pay on Pickup (Cash)</button>`
            : `<div style="padding:10px; background:#eee; color:#666; font-size:0.9rem; text-align:center; margin-bottom:10px;">Pay on Pickup Unavailable (${cashRule.reason})</div>`;

        const stripeBtn = enableStripe
            ? `<button id="pay-stripe-btn" class="button-primary" style="width:100%; padding:15px;">Pay with Card</button>`
            : `<button disabled class="button-primary" style="width:100%; padding:15px; opacity:0.6;">Card Payments Offline</button>`;

        paymentSectionHTML = `
            <div class="payment-section" style="margin-top:30px; border-top: 2px solid #eee; padding-top: 20px;">
                <h3 style="text-align:center; margin-bottom: 20px;">Choose Payment Option</h3>
                <div style="display:flex; flex-direction:column; gap:10px; max-width:400px; margin-left:auto; margin-right:auto;">
                    ${cashBtn}
                    ${stripeBtn}
                    
                    <div id="stripe-container" style="display:none; border:1px solid #ddd; padding:15px; border-radius:8px; margin-top:10px; background: #fafafa;">
                        <div id="stripe-element-mount" style="min-height: 200px;"></div>
                        <button id="stripe-submit-btn" class="button-primary" style="width:100%; margin-top:15px;">Confirm Payment ($${total.toFixed(2)})</button>
                        <div id="stripe-error" style="color:red; margin-top:10px; font-size:0.9rem;"></div>
                    </div>
                </div>
            </div>
        `;
    }

    // 4. Final Render
    mainContent.innerHTML = `
        ${CART_CSS}
        <div class="cart-container" style="max-width:800px; margin:0 auto;">
            <h2>Your Order</h2>
            <div class="cart-items-wrapper" style="background:white; padding:0 20px; border-radius:8px; box-shadow:0 2px 5px rgba(0,0,0,0.05);">
                ${cartItemsHTML}
            </div>
            
            <div class="cart-total-row" style="display:flex; justify-content:flex-end; align-items:center; gap:20px; margin-top:20px; font-size:1.3rem; font-weight:bold;">
                <span>Total:</span>
                <span style="color:var(--primary-color);">$${total.toFixed(2)}</span>
            </div>

            ${paymentSectionHTML}
        </div>
    `;

    attachListeners();
}

function attachListeners() {
    const mainContent = document.getElementById('main-content');
    
    mainContent.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        // Guest Flow Logic
if (btn.id === 'guest-start-btn') {
            uiUtils.showGuestNameModal((name) => {
                localStorage.setItem('guest_name', name);
                // We need to access the variable 'isGuestCheckout' from module scope.
                // Assuming you have 'let isGuestCheckout = false;' at the top of cartUI.js
                isGuestCheckout = true; 
                renderCartPage(); 
            });
            return;
        }
        if (btn.id === 'guest-continue-btn') {
            isGuestCheckout = true;
            renderCartPage();
            return;
        }

        // Cart Item Actions
        const uniqueId = btn.dataset.uniqueId;
        if (uniqueId) {
            const { updateItemQuantity, removeItem, items } = useAppStore.getState().cart;
            const currentItem = items.find(i => (i.cartId || i.id) === uniqueId);
            if (!currentItem) return;

            if (btn.classList.contains('increase-qty')) updateItemQuantity(uniqueId, currentItem.quantity + 1);
            else if (btn.classList.contains('decrease-qty')) updateItemQuantity(uniqueId, currentItem.quantity - 1);
            else if (btn.classList.contains('remove-item-btn')) removeItem(uniqueId);
            return;
        }
        
        // Payment Buttons
        if (btn.id === 'cart-login-btn') {
            import('@/features/auth/authUI.js').then(m => m.showLoginSignupModal());
        }
        else if (btn.id === 'pay-cash-btn') {
            handleCashPayment(btn);
        }
        else if (btn.id === 'pay-stripe-btn') {
            btn.style.display = 'none'; 
            document.getElementById('stripe-container').style.display = 'block'; 
            initializeStripeFlow();
        }
    });
}

async function handleCashPayment(btn) {
    btn.disabled = true;
    btn.textContent = "Processing...";
    
    const { submitCashOrder } = useAppStore.getState().checkout;
    const guestName = localStorage.getItem('guest_name'); // Get Guest Name

    const result = await submitCashOrder(guestName); // Pass it

    if (result.success) {
        uiUtils.showToast("Order Placed!", "success");
        // Reset guest state if needed
        isGuestCheckout = false; 
        window.location.hash = '#order-history'; // Will show guest view (empty usually) or just reload
    } else {
        uiUtils.showToast(result.error, "error");
        btn.disabled = false;
        btn.textContent = "Pay on Pickup (Cash)";
    }
}

async function initializeStripeFlow() {
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
                errorDiv.textContent = result.error.message;
                submitBtn.disabled = false;
                submitBtn.textContent = `Confirm Payment ($${total.toFixed(2)})`;
            } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
                const { submitPaidOrder } = useAppStore.getState().checkout;
                const guestName = localStorage.getItem('guest_name');
                const saveRes = await submitPaidOrder(result.paymentIntent, guestName);
                
                if (saveRes.success) {
                    uiUtils.showToast("Payment Successful!", "success");
                    isGuestCheckout = false;
                    window.location.hash = '#order-history';
                } else {
                    errorDiv.textContent = "Payment worked, but database save failed. Contact staff.";
                }
            }
        };
    } catch (e) {
        console.error(e);
        if (errorDiv) errorDiv.textContent = "Payment System Error.";
    }
}