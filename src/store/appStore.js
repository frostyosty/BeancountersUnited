// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMenuSlice } from './menuSlice.js';
// We will add auth and cart back later. Let's just get the menu working.

export const useAppStore = create(
  devtools(
    (set, get) => ({
      ...createMenuSlice(set, get),
    }),
    { name: "RestaurantAppStore" }
  )
);

window.useAppStore = useAppStore;