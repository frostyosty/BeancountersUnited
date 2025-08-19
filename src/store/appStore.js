// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// Import our new slice creator
import { createMenuSlice } from './menuSlice.js';

export const useAppStore = create(
  devtools(
    (...args) => ({
      ...createMenuSlice(...args),
      // ... Add other slices like createAuthSlice, createCartSlice here later
    }),
    { name: "RestaurantAppStore" }
  )
);

// Expose for debugging
window.useAppStore = useAppStore;