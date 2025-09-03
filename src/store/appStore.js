// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMenuSlice } from './menuSlice.js';
import { createAuthSlice } from './authSlice.js'; // <-- Import

export const useAppStore = create(
  devtools(
    (set, get) => ({
      ...createMenuSlice(set, get),
      ...createAuthSlice(set, get), // <-- Add the slice
    }),
    { name: "RestaurantAppStore" }
  )
);

console.log("--- appStore.js: Store created with menu and auth slices. ---");
window.useAppStore = useAppStore;