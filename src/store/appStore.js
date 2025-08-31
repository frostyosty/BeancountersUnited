// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createMenuSlice } from './menuSlice.js';

export const useAppStore = create(
  devtools(
    (set, get) => ({
      ...createMenuSlice(set, get),
    }),
    { name: "RestaurantAppStore" }
  )
);