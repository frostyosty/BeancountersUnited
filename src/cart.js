let cartItems = JSON.parse(localStorage.getItem('restaurantCart')) || [];

function _saveCart() { // Internal helper function
    localStorage.setItem('restaurantCart', JSON.stringify(cartItems));
    // ui.updateCartCount is called by main.js via 'cartUpdated' event
    // Dispatch an event that the cart has changed
    document.dispatchEvent(new CustomEvent('cartUpdated', { detail: { cartItems } }));
}

// --- EXPORTED FUNCTIONS ---
export function addItem(item, quantity = 1) {
    const existingItem = cartItems.find(ci => ci.id === item.id);
    if (existingItem) {
        existingItem.quantity = parseInt(existingItem.quantity, 10) + parseInt(quantity, 10);
    } else {
        cartItems.push({ ...item, quantity: parseInt(quantity, 10) });
    }
    _saveCart();
    console.log(`${item.name} added to cart.`);
    // Optionally show a small notification - this would need uiUtils too
    // if (window.uiUtils && typeof window.uiUtils.showModal === 'function') { // Check if uiUtils is global or pass it in
    //     window.uiUtils.showModal(`<p>${item.name} added to cart!</p><button onclick="window.uiUtils.closeModal()">OK</button>`);
    //     setTimeout(window.uiUtils.closeModal, 1500);
    // }
}

export function removeItem(itemId) {
    cartItems = cartItems.filter(ci => ci.id.toString() !== itemId.toString());
    _saveCart();
}

export function updateQuantity(itemId, quantity) {
    const item = cartItems.find(ci => ci.id.toString() === itemId.toString());
    const newQuantity = parseInt(quantity, 10);
    if (item) {
        if (newQuantity <= 0) {
            removeItem(itemId); // Call the exported removeItem
        } else {
            item.quantity = newQuantity;
            _saveCart();
        }
    }
}

export function getItems() { // <<<< Ensure 'export' keyword is present
    return [...cartItems]; // Return a copy to prevent direct mutation
}

export function getTotal() {
    return cartItems.reduce((sum, item) => sum + (parseFloat(item.price) * parseInt(item.quantity, 10)), 0);
}

export function clearCart() {
    cartItems = [];
    _saveCart();
}

export function isEmpty() {
    return cartItems.length === 0;
}