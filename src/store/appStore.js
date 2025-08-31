// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMenuSlice } from './menuSlice.js';
import { createAuthSlice } from './authSlice.js'; // <-- Add this import

export const useAppStore = create(
  devtools(
    (set, get) => ({
      ...createMenuSlice(set, get),
      ...createAuthSlice(set, get), // <-- Add the slice creator here
    }),
    { name: "RestaurantAppStore" }
  )
);

window.useAppStore = useAppStore;