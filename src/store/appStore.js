// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMenuSlice } from './menuSlice.js';
import { createAuthSlice } from './authSlice.js';
import { createCartSlice } from './cartSlice.js'; // <-- Import

export const useAppStore = create(
  devtools(
    (set, get) => ({
      ...createMenuSlice(set, get),
      ...createAuthSlice(set, get),
      ...createCartSlice(set, get), // <-- Add the slice
    }),
    { name: "RestaurantAppStore" }
  )
);

window.useAppStore = useAppStore;