// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// We are only importing the menu slice for this test
import { createMenuSlice } from './menuSlice.js';

export const useAppStore = create(
  devtools(
    (set, get) => ({
      // The entire store only has one namespace: 'menu'
      menu: createMenuSlice(set, get),
    }),
    { name: "RestaurantAppStore (Menu Only)" }
  )
);

window.useAppStore = useAppStore;