// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

console.log("--- [3] appStore.js: START ---");

// Import all slice creators
import { createMenuSlice } from './menuSlice.js';
import { createAuthSlice } from './authSlice.js';
import { createCartSlice } from './cartSlice.js';
import { createSiteSettingsSlice } from './siteSettingsSlice.js';
import { createCheckoutSlice } from './checkoutSlice.js';
import { createAdminSlice } from './adminSlice.js';
import { createOrderHistorySlice } from './orderHistorySlice.js'; // <-- Import




export const useAppStore = create(
  devtools(
    (set, get) => {
        console.log("--- [3.1] appStore.js: Zustand create() function is running. ---");
        return {
      menu: createMenuSlice(set, get),
      auth: createAuthSlice(set, get),
      cart: createCartSlice(set, get),
      siteSettings: createSiteSettingsSlice(set, get),
      checkout: createCheckoutSlice(set, get),
      admin: createAdminSlice(set, get),
            orderHistory: createOrderHistorySlice(set, get),
                  ui: createUiSlice(set, get), // Add the new UI slice
    
        };
    },
    { name: "RestaurantAppStore" }
  )
);

console.log("--- [3] appStore.js: END ---");
window.useAppStore = useAppStore;

