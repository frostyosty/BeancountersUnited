export const CART_CSS = `
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

export function getEmptyStateHTML() {
    return `
        <div class="empty-state">
            <h2>Your Cart is Empty</h2>
            <p>Looks like you haven't added anything yet.</p>
            <a href="#menu" class="button-primary">Browse Menu</a>
        </div>`;
}

export function getCartItemsHTML(items) {
    return items.map(item => {
        const price = parseFloat(item.price) || 0;
        const subtotal = price * item.quantity;
        
        const optionsDisplay = (item.selectedOptions && item.selectedOptions.length > 0)
            ? `<div style="font-size:0.8rem; color:#d63384; margin-top:2px; line-height:1.2;">+ ${item.selectedOptions.join(', ')}</div>`
            : '';

        const uniqueId = item.cartId || item.id;

        return `
        <div class="cart-item" data-unique-id="${uniqueId}" style="display:flex; align-items:center; justify-content:space-between; padding:15px 0; border-bottom:1px solid #eee;">
            
            <!-- Left: Image & Info -->
            <div style="display:flex; gap:15px; align-items:center; overflow:hidden;">
                <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" 
                     style="width:60px; height:60px; object-fit:cover; border-radius:6px; flex-shrink:0;">
                
                <div style="min-width:0;">
                    <h4 style="margin:0; font-size:1rem; line-height:1.2;">${item.name}</h4>
                    ${optionsDisplay}
                    <p style="margin:2px 0 0 0; color:#666; font-size:0.9rem;">$${price.toFixed(2)}</p>
                </div>
            </div>

            <!-- Right: Controls -->
            <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
                
                <!-- Qty Stepper -->
                <div class="quantity-selector" style="display:flex; align-items:center; border:1px solid #ddd; border-radius:4px;">
                    <button class="quantity-btn decrease-qty" data-unique-id="${uniqueId}" style="padding:5px 10px; background:none; border:none; cursor:pointer;">-</button>
                    <span style="padding:0 5px; min-width:20px; text-align:center;">${item.quantity}</span>
                    <button class="quantity-btn increase-qty" data-unique-id="${uniqueId}" style="padding:5px 10px; background:none; border:none; cursor:pointer;">+</button>
                </div>

                <!-- Desktop Subtotal -->
                <span class="cart-subtotal-col">$${subtotal.toFixed(2)}</span>

                <!-- Delete Button -->
                <button class="delete-icon-btn remove-item-btn" data-unique-id="${uniqueId}" title="Remove">×</button>
            </div>
        </div>`;
    }).join('');
}

export function getPaymentSectionHTML(isAuthenticated, isGuest, cashRule, enableStripe, savedGuestName, total) {
    if (!isAuthenticated && !isGuest) {
        // Not logged in, and hasn't chosen Guest yet
        let guestBtn = savedGuestName 
            ? `<button class="button-secondary" id="guest-continue-btn" style="width:100%; margin-bottom:10px;">Continue as ${savedGuestName}</button>`
            : `<button class="button-secondary" id="guest-start-btn" style="width:100%; margin-bottom:10px;">Continue as Guest</button>`;

        return `
            <div style="margin-top:30px; padding:20px; background:#f9f9f9; border-radius:8px; border:1px solid #eee;">
                <h3 style="text-align:center; margin-bottom:15px;">Checkout</h3>
                ${guestBtn}
                <div style="text-align:center; font-size:0.9rem; margin:10px 0;">— OR —</div>
                <button class="button-primary" id="cart-login-btn" style="width:100%;">Login / Sign Up (Save History)</button>
            </div>`;
    }

    // Authenticated OR Guest Mode Active
    const cashBtn = cashRule.allowed 
        ? `<button id="pay-cash-btn" class="button-secondary" style="width:100%; margin-bottom:10px; padding:15px;">Pay on Pickup (Cash)</button>`
        : `<div style="padding:10px; background:#eee; color:#666; font-size:0.9rem; text-align:center; margin-bottom:10px;">Pay on Pickup Unavailable (${cashRule.reason})</div>`;

    const stripeBtn = enableStripe
        ? `<button id="pay-stripe-btn" class="button-primary" style="width:100%; padding:15px;">Pay with Card</button>`
        : `<button disabled class="button-primary" style="width:100%; padding:15px; opacity:0.6;">Card Payments Offline</button>`;

    return `
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