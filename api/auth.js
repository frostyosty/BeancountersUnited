// api/auth.js
import { createClient } from '@supabase/supabase-js';

// Define TABLES locally for Vercel safety
const TABLES = { PROFILES: 'mealmates_profiles' };

export default async function handler(req, res) {
    const { type } = req.query;
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
        return res.status(500).json({ error: "Server Config Error" });
    }

    // Handle LOGIN
    if (type === 'login') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        const { email, password } = req.body;
        
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ error: error.message });
        return res.status(200).json({ session: data.session });
    }

    // Handle SIGNUP
    if (type === 'signup') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        const { email, password } = req.body;

        const { data, error } = await supabase.auth.signUp({ email, password });
        
        if (error) return res.status(400).json({ error: error.message });
        
        // Auto-create Profile
        if (data.user) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
            await supabaseAdmin.from(TABLES.PROFILES).insert([{ 
                id: data.user.id, 
                email: email, 
                role: 'customer',
                // FIX: Restore default name logic
                full_name: email.split('@')[0] 
            }]);
        }
        return res.status(200).json({ user: data.user });
    }

    return res.status(400).json({ error: "Invalid auth type requested." });
}