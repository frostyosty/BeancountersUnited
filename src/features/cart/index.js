import { useAppStore } from '@/store/appStore.js';
import * as templates from './templates.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { handleCashPayment, initializeStripeFlow } from './payment.js';
import { isStoreOpen, calculateTotalPrepTime, calculateDistance, calculateDeliveryCost } from '@/utils/logisticsUtils.js';

// Local state for this session
let isGuestCheckout = false;
let currentOrderType = 'pickup'; // 'pickup' or 'delivery'

export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 1. Get Data
    const { items, getCartTotal } = useAppStore.getState().cart;
    const { isAuthenticated } = useAppStore.getState().auth;
    const { settings } = useAppStore.getState().siteSettings;
    const { canPayWithCash } = useAppStore.getState().checkout;

    // 2. Logistics Config
    const hours = settings.openingHours;
    const deliveryConfig = settings.deliveryConfig || {};

    // 3. Check Open Status (Block access if closed)
    if (!isStoreOpen(hours)) {
        mainContent.innerHTML = `
            <div class="empty-state" style="border-color: #dc3545; color: #dc3545;">
                <h2 style="color:#dc3545">Sorry, we are closed!</h2>
                <p>Please check back during our opening hours.</p>
                <a href="#menu" class="button-secondary">View Menu</a>
            </div>`;
        return;
    }

    // 4. Empty Cart Check
    const validItems = items ? items.filter(i => i && i.id) : [];
    if (validItems.length === 0) {
        mainContent.innerHTML = templates.getEmptyStateHTML();
        return;
    }

    // 5. Calculate Logistics Data
    const prepTime = calculateTotalPrepTime(validItems, currentOrderType === 'delivery');
    const readyTime = new Date(Date.now() + prepTime * 60000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    
    // Prep Time Banner
    const prepTimeHTML = `
        <div style="background:#e3f2fd; padding:10px; border-radius:4px; margin-top:10px; font-size:0.9rem; color:#0d47a1; display:flex; align-items:center; gap:8px;">
            <span>⏱️</span>
            <span>Estimated Prep Time: <strong>${prepTime} mins</strong> (Ready approx ${readyTime})</span>
        </div>
    `;

    // 6. Delivery Toggle HTML
    let deliveryToggleHTML = '';
    if (deliveryConfig.enabled) {
        deliveryToggleHTML = `
            <div style="margin-top:20px; padding:15px; border:1px solid #ddd; border-radius:8px; background:#fff;">
                <label style="font-weight:bold; margin-bottom:10px; display:block;">Order Type</label>
                <div style="display:flex; gap:20px;">
                    <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
                        <input type="radio" name="orderType" value="pickup" ${currentOrderType === 'pickup' ? 'checked' : ''} class="order-type-radio"> 
                        Pickup
                    </label>
                    <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
                        <input type="radio" name="orderType" value="delivery" ${currentOrderType === 'delivery' ? 'checked' : ''} class="order-type-radio"> 
                        Delivery
                    </label>
                </div>
                
                <!-- Hidden Delivery Address Box -->
                <div id="delivery-address-box" style="display:${currentOrderType === 'delivery' ? 'block' : 'none'}; margin-top:15px; padding-top:15px; border-top:1px dashed #eee;">
                    <p style="font-size:0.9rem; color:#666; margin-bottom:10px;">Delivery is available within ${deliveryConfig.maxDistanceKm}km.</p>
                    <button id="btn-locate-me" class="button-secondary small" style="width:100%; margin-bottom:5px;">📍 Calculate Delivery Cost</button>
                    <div id="delivery-calc-result" style="font-size:0.9rem; font-weight:bold; color:var(--primary-color); margin-top:5px;"></div>
                </div>
            </div>
        `;
    }

    // 7. Payment Logic
    const total = getCartTotal(); // Note: Delivery fee logic would need to be added here in future
    const savedGuestName = localStorage.getItem('guest_name');
    const cashRule = canPayWithCash();
    const enableStripe = settings.paymentConfig?.enableStripe !== false;

    // 8. Render HTML
    const itemsHTML = templates.getCartItemsHTML(validItems);
    const paymentHTML = templates.getPaymentSectionHTML(
        isAuthenticated, 
        isGuestCheckout, 
        cashRule, 
        enableStripe, 
        savedGuestName, 
        total
    );

    mainContent.innerHTML = `
        ${templates.CART_CSS}
        <div class="cart-container" style="max-width:800px; margin:0 auto;">
            <h2>Your Order</h2>
            
            <div class="cart-items-wrapper" style="background:white; padding:0 20px; border-radius:8px; box-shadow:0 2px 5px rgba(0,0,0,0.05);">
                ${itemsHTML}
                ${prepTimeHTML} <!-- Added Prep Time Here -->
            </div>
            
            ${deliveryToggleHTML} <!-- Added Delivery Toggle Here -->

            <div class="cart-total-row" style="display:flex; justify-content:flex-end; align-items:center; gap:20px; margin-top:20px; font-size:1.3rem; font-weight:bold;">
                <span>Total:</span>
                <span style="color:var(--primary-color);">$${total.toFixed(2)}</span>
            </div>

            ${paymentHTML}
        </div>
    `;

    attachListeners(deliveryConfig);
}

function attachListeners(deliveryConfig) {
    const container = document.querySelector('.cart-container');
    if (!container) return;

    // A. Radio Button Listeners (Delivery vs Pickup)
    container.querySelectorAll('.order-type-radio').forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentOrderType = e.target.value;
            renderCartPage(); // Re-render to show/hide address box and update prep time
        });
    });

    // B. Main Click Listener
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        // 1. Delivery Location Logic
        if (btn.id === 'btn-locate-me') {
            handleGeolocation(deliveryConfig);
            return;
        }

        // 2. Guest Logic
        if (btn.id === 'guest-start-btn') {
            import('@/utils/uiUtils.js').then(utils => {
                utils.showGuestNameModal((name) => {
                    localStorage.setItem('guest_name', name);
                    isGuestCheckout = true;
                    renderCartPage();
                });
            });
            return;
        }
        if (btn.id === 'guest-continue-btn') {
            isGuestCheckout = true;
            renderCartPage();
            return;
        }

        // 3. Auth Logic
        if (btn.id === 'cart-login-btn') {
            import('@/features/auth/authUI.js').then(m => m.showLoginSignupModal());
            return;
        }

        // 4. Payment Logic
        if (btn.id === 'pay-cash-btn') {
            handleCashPayment(btn);
            return;
        }
        if (btn.id === 'pay-stripe-btn') {
            btn.style.display = 'none'; 
            document.getElementById('stripe-container').style.display = 'block'; 
            initializeStripeFlow(() => { isGuestCheckout = false; });
            return;
        }

        // 5. Item Actions
        const uniqueId = btn.dataset.uniqueId;
        if (uniqueId) {
            const { updateItemQuantity, removeItem, items } = useAppStore.getState().cart;
            const currentItem = items.find(i => (i.cartId || i.id) === uniqueId);
            if (!currentItem) return;

            if (btn.classList.contains('increase-qty')) updateItemQuantity(uniqueId, currentItem.quantity + 1);
            else if (btn.classList.contains('decrease-qty')) updateItemQuantity(uniqueId, currentItem.quantity - 1);
            else if (btn.classList.contains('remove-item-btn')) removeItem(uniqueId);
        }
    });
}

// --- Helper: Geolocation for Delivery ---
function handleGeolocation(config) {
    const resultDiv = document.getElementById('delivery-calc-result');
    if (!resultDiv) return;

    resultDiv.textContent = "Locating...";
    
    if (!navigator.geolocation) {
        resultDiv.textContent = "Geolocation not supported.";
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude, longitude } = pos.coords;
            const cafeLat = config.cafeLat;
            const cafeLng = config.cafeLng;

            if (!cafeLat || !cafeLng) {
                resultDiv.textContent = "Store location not set by Admin.";
                return;
            }

            const dist = calculateDistance(latitude, longitude, cafeLat, cafeLng);
            const calc = calculateDeliveryCost(dist, config);

            if (calc.allowed) {
                resultDiv.innerHTML = `Distance: ${dist.toFixed(1)}km <br> Delivery Fee: $${calc.cost.toFixed(2)}`;
                // Note: To actually ADD this fee to the cart total, we'd need to update the Cart Slice state.
                // For now, this is just a calculator/estimator.
            } else {
                resultDiv.innerHTML = `<span style="color:red">Too far for delivery (${dist.toFixed(1)}km). Max is ${config.maxDistanceKm}km.</span>`;
            }
        },
        (err) => {
            resultDiv.textContent = "Location access denied.";
        }
    );
}