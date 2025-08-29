// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabaseInstance = null;
let initializationError = null;

if (!supabaseUrl || !supabaseAnonKey) {
    initializationError = "Supabase credentials (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are missing in your environment variables.";
    console.error(`CRITICAL ERROR: ${initializationError}`);
} else {
    try {
        supabaseInstance = createClient(supabaseUrl, supabaseAnonKey);
    } catch (e) {
        initializationError = `Failed to create Supabase client: ${e.message}`;
        console.error(`CRITICAL ERROR: ${initializationError}`);
    }
}

export const supabase = supabaseInstance;
export const supabaseError = initializationError;