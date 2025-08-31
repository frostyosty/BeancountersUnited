// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabaseInstance = null;
let initializationError = null;

console.log("--- supabaseClient.js ---");
console.log("VITE_SUPABASE_URL found by Vite:", supabaseUrl);
console.log("VITE_SUPABASE_ANON_KEY found by Vite:", supabaseAnonKey ? "Exists (key hidden for security)" : "MISSING!");
console.log("-----------------------");

if (!supabaseUrl || !supabaseAnonKey) {
    initializationError = "Supabase credentials (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are missing or were not injected into the build. Please check Vercel environment variables.";
} else {
    try {
        supabaseInstance = createClient(supabaseUrl, supabaseAnonKey);
    } catch (e) {
        initializationError = `Failed to create Supabase client: ${e.message}`;
    }
}

export const supabase = supabaseInstance;
export const supabaseError = initializationError;

// Also attach to window for easy console debugging
window.supabase = supabaseInstance;