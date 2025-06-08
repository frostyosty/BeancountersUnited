// cart.js
let cartItems = JSON.parse(localStorage.getItem('restaurantCart')) || [];

function saveCart() {
    localStorage.setItem('restaurantCart', JSON.stringify(cartItems));
    ui.updateCartCount(cartItems.reduce((sum, item) => sum + item.quantity, 0));
    // Dispatch an event that the cart has changed
    document.dispatchEvent(new CustomEvent('cartUpdated', { detail: { cartItems } }));
}

const cart = {
    addItem: (item, quantity = 1) => {
        const existingItem = cartItems.find(ci => ci.id === item.id);
        if (existingItem) {
            existingItem.quantity += quantity;
        } else {
            cartItems.push({ ...item, quantity });
        }
        saveCart();
        console.log(`${item.name} added to cart.`);
        // Optionally show a small notification
        ui.showModal(`<p>${item.name} added to cart!</p><button onclick="ui.closeModal()">OK</button>`);
        setTimeout(ui.closeModal, 1500);
    },
    removeItem: (itemId) => {
        cartItems = cartItems.filter(ci => ci.id !== itemId);
        saveCart();
    },
    updateQuantity: (itemId, quantity) => {
        const item = cartItems.find(ci => ci.id === itemId);
        if (item) {
            item.quantity = quantity;
            if (item.quantity <= 0) {
                cart.removeItem(itemId);
            } else {
                saveCart();
            }
        }
    },
    getItems: () => [...cartItems], // Return a copy
    getTotal: () => {
        return cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    },
    clearCart: () => {
        cartItems = [];
        saveCart();
    },
    isEmpty: () => cartItems.length === 0,
};

// Initialize cart count on load
ui.updateCartCount(cartItems.reduce((sum, item) => sum + item.quantity, 0));

// Expose cart to global scope or use modules
window.cart = cart;