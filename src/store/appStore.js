// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// Import our slice creators
import { createMenuSlice } from './menuSlice.js';
import { createCartSlice } from './cartSlice.js';
import { createAuthSlice } from './authSlice.js';
import { createCheckoutSlice } from './checkoutSlice.js'; // <-- Import the new slice

export const useAppStore = create(
  devtools(
    (...args) => ({
      ...createMenuSlice(...args),
      ...createCartSlice(...args),
      ...createAuthSlice(...args),
      ...createCheckoutSlice(...args), // <-- Add the slice here
    }),
    { name: "RestaurantAppStore" }
  )
);

// Expose for debugging
window.useAppStore = useAppStore;