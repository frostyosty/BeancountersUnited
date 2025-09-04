// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMenuSlice } from './menuSlice.js';
import { createAuthSlice } from './authSlice.js';
import { createCartSlice } from './cartSlice.js';

export const useAppStore = create(
  devtools(
    (set, get) => {
      console.log("--- appStore: CREATING SLICES ---");
      const store = {
          menu: createMenuSlice(set, get),
          auth: createAuthSlice(set, get),
          cart: createCartSlice(set, get),
      };
      console.log("--- appStore: SLICES CREATED. Initial store shape:", {
          menu: Object.keys(store.menu),
          auth: Object.keys(store.auth),
          cart: Object.keys(store.cart),
      });
      return store;
    },
    { name: "RestaurantAppStore" }
  )
);