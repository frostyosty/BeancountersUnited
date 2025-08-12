// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
// Import slice creators as you build them
// import { createAuthSlice } from './authSlice';
// import { createCartSlice } from './cartSlice';

export const useAppStore = create(
  devtools(
    (...args) => ({
      // ...createAuthSlice(...args),
      // ...createCartSlice(...args),
      // Add more slices here as you create them
    }),
    { name: "RestaurantAppStore" }
  )
);