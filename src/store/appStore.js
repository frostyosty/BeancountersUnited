// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// Import our slice creators
import { createMenuSlice } from './menuSlice.js';
import { createCartSlice } from './cartSlice.js'; // <-- Import the new cart slice

export const useAppStore = create(
  devtools(
    (...args) => ({
      ...createMenuSlice(...args),
      ...createCartSlice(...args), // <-- Add the cart slice here
      // ... Add other slices like createAuthSlice later
    }),
    { name: "RestaurantAppStore" }
  )
);

// Expose for debugging
window.useAppStore = useAppStore;