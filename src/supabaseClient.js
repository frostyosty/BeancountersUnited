// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// 1. Validation: Fail fast if keys are missing
if (!supabaseUrl || !supabaseAnonKey) {
    const msg = "CRITICAL: Supabase URL or Anon Key is missing from .env file.";
    console.error(msg);
    throw new Error(msg);
}

// 2. Create a SINGLE client instance with Auth Persistence
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: true,    // Saves session to LocalStorage (Required for 90-day login)
        autoRefreshToken: true,  // Keeps the token alive
        detectSessionInUrl: true // Handles magic links/password resets
    }
});

// 3. Expose the SAME instance to window for debugging
window.supabase = supabase;