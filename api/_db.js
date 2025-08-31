// api/_db.js - VERBOSE DEBUGGING
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
    console.error("CRITICAL ERROR IN _db.js: Supabase server-side environment variables are not set.");
    throw new Error("Supabase server-side credentials are not configured.");
}

export const supabaseAdmin = createClient(supabaseUrl, serviceKey);
console.log("--- [API _db.js] Module loaded, supabaseAdmin client created. ---");


export async function getUserFromRequest(req) {
    console.log("--- [API _db.js] getUserFromRequest() started ---");

    if (!req.headers.authorization) {
        console.log("[API _db.js] No authorization header found. Returning null user.");
        return { user: null, profile: null, error: { message: 'No authorization header provided.' } };
    }

    const token = req.headers.authorization.split(' ')[1];
    if (!token) {
        console.log("[API _db.js] Malformed authorization header. No token found. Returning null user.");
        return { user: null, profile: null, error: { message: 'Malformed authorization header. No token found.' } };
    }

    console.log("[API _db.js] Found token. Attempting to get user from Supabase...");
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError) {
        console.error("[API _db.js] Supabase auth.getUser() returned an error:", userError);
        return { user: null, profile: null, error: userError };
    }

    if (!user) {
        console.log("[API _db.js] Supabase auth.getUser() returned no user. Token might be invalid or expired.");
        return { user: null, profile: null, error: { message: 'User not found for the provided token.' } };
    }
    
    console.log(`[API _db.js] Successfully got user from token. User ID: ${user.id}, Email: ${user.email}`);
    console.log(`[API _db.js] Now attempting to fetch profile for user ID: ${user.id} from 'profiles' table...`);

    try {
        const { data: profile, error: profileError, status } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        console.log(`[API _db.js] Profile fetch query completed. Status: ${status}`);
        console.log("[API _db.js] Profile fetch error object:", profileError);
        console.log("[API _db.js] Profile fetch data object:", profile);

        if (profileError && profileError.code !== 'PGRST116') { // PGRST116 means row not found
            console.error("[API _db.js] Profile fetch returned a critical error.");
            throw profileError;
        }

        if (!profile) {
            console.warn(`[API _db.js] No profile found in 'profiles' table for user ID: ${user.id}`);
        }

        console.log("[API _db.js] getUserFromRequest() finished successfully.");
        return { user, profile, error: null };

    } catch (dbError) {
        console.error(`[API _db.js] CRITICAL ERROR in try/catch block while fetching profile:`, dbError);
        return { user, profile: null, error: dbError };
    }
}