// src/store/appStore.js
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import * as api from '../apiService.js'; // Use relative path

// --- SLICE CREATORS ---

const createAuthSlice = (set, get) => ({
  user: null,
  profile: null,
  isLoading: true,
  checkUserSession: async () => {
    set({ isLoading: true });
    try {
      const { data: { session } } = await window.supabase.auth.getSession(); // Assuming supabase client is set up
      if (session?.user) {
        const profile = await api.getUserProfile();
        set({ user: session.user, profile, isLoading: false }, false, 'auth/sessionSuccess');
      } else {
        set({ user: null, profile: null, isLoading: false }, false, 'auth/noSession');
      }
    } catch (error) {
      console.error("Error checking session:", error);
      set({ user: null, profile: null, isLoading: false, error: error.message }, false, 'auth/sessionError');
    }
  },
  // Add login, logout, etc. actions here that modify the state
  logout: async () => {
     await window.supabase.auth.signOut();
     set({ user: null, profile: null }, false, 'auth/logout');
  }
});

const createCartSlice = (set, get) => ({
  items: JSON.parse(localStorage.getItem('restaurantCart')) || [],
  _saveToLocalStorage: () => {
    localStorage.setItem('restaurantCart', JSON.stringify(get().items));
  },
  addItem: (item) => {
    const items = get().items;
    const existingItem = items.find(i => i.id === item.id);
    let newItems;
    if (existingItem) {
      newItems = items.map(i => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i);
    } else {
      newItems = [...items, { ...item, quantity: 1 }];
    }
    set({ items: newItems }, false, 'cart/addItem');
    get()._saveToLocalStorage();
  },
  // Add removeItem, updateQuantity, clearCart, etc.
  clearCart: () => {
     set({ items: [] }, false, 'cart/clear');
     get()._saveToLocalStorage();
  }
});

// --- COMBINED STORE ---
export const useAppStore = create(
  devtools(
    (...args) => ({
      ...createAuthSlice(...args),
      ...createCartSlice(...args),
      // ... add menuSlice, settingsSlice later
    }),
    { name: "RestaurantAppStore" }
  )
);

// Expose for debugging if needed
window.useAppStore = useAppStore;