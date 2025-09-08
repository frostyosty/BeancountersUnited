// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

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
    (set, get) => ({
      menu: createMenuSlice(set, get),
      auth: createAuthSlice(set, get),
      cart: createCartSlice(set, get),
      siteSettings: createSiteSettingsSlice(set, get),
      checkout: createCheckoutSlice(set, get),
      admin: createAdminSlice(set, get),
            orderHistory: createOrderHistorySlice(set, get),
    }),
    { name: "RestaurantAppStore" }
  )
);
