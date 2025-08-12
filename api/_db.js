// api/_db.js - Shared DB client for serverless functions
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
    console.error("CRITICAL ERROR: Supabase server-side environment variables (SUPABASE_URL and SUPABASE_SERVICE_KEY) are not set.");
    throw new Error("Supabase server-side credentials are not configured.");
}

export const supabaseAdmin = createClient(supabaseUrl, serviceKey);

export async function getUserFromRequest(req) {
    if (!req.headers.authorization) {
        return { user: null, profile: null, error: { message: 'No authorization header provided.' } };
    }

    const token = req.headers.authorization.split(' ')[1];
    if (!token) {
        return { user: null, profile: null, error: { message: 'Malformed authorization header. No token found.' } };
    }

    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError) {
        return { user: null, profile: null, error: userError };
    }
    if (!user) {
        return { user: null, profile: null, error: { message: 'User not found for the provided token.' } };
    }

    try {
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError && profileError.code !== 'PGRST116') { // PGRST116 = row not found
            throw profileError;
        }
        return { user, profile, error: null };
    } catch (dbError) {
        console.error(`Error fetching profile for user ${user.id}:`, dbError);
        return { user, profile: null, error: dbError };
    }
}