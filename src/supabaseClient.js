// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

// Get these from your environment variables or a config file
// For Vite, environment variables prefixed with VITE_ are exposed to client-side code
// e.g., in a .env file: VITE_SUPABASE_URL=your_url
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Supabase URL or Anon Key is missing. Make sure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in your environment.");
}

// Export the client instance
export const supabase = createClient(supabaseUrl, supabaseAnonKey);