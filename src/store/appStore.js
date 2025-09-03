// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMenuSlice } from './menuSlice.js';
import { createAuthSlice } from './authSlice.js';
import { createCartSlice } from './cartSlice.js';

export const useAppStore = create(
  devtools(
    (set, get) => ({
      menu: createMenuSlice(set, get),
      auth: createAuthSlice(set, get),
      cart: createCartSlice(set, get),
    }),
    { name: "RestaurantAppStore" }
  )
);

window.useAppStore = useAppStore;