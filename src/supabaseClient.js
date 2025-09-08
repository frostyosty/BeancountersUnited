// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

console.log("--- [1] supabaseClient.js: START ---");

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabaseInstance = null;
let initializationError = null;

if (!supabaseUrl || !supabaseAnonKey) {
    initializationError = "CRITICAL: Supabase credentials (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) are missing.";
    console.error(initializationError);
} else {
    try {
        supabaseInstance = createClient(supabaseUrl, supabaseAnonKey);
        console.log("--- [1] supabaseClient.js: Client created successfully. ---");
    } catch (e) {
        initializationError = `CRITICAL: Failed to create Supabase client: ${e.message}`;
        console.error(initializationError);
    }
}

export const supabase = supabaseInstance;
export const supabaseError = initializationError;

window.supabase = supabaseInstance; // For easy console access
console.log("--- [1] supabaseClient.js: END ---");