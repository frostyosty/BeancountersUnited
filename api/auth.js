import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
const TABLES = { PROFILES: 'beancountersunited_profiles' };

export default async function handler(req, res) {
    const { type } = req.query;
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    // 1. Check Env Vars
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
        console.error("CRITICAL: Missing Environment Variables");
        return res.status(500).json({ error: "Server Config Error: Missing Keys" });
    }

    // 2. Handle LOGIN
    if (type === 'login') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        const { email, password } = req.body;
        
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ error: error.message });
        return res.status(200).json({ session: data.session });
    }

    // 3. Handle SIGNUP
    if (type === 'signup') {
        console.log("--- STARTING SIGNUP ---");
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        const { email, password } = req.body;

        console.log(`1. Attempting Auth SignUp for: ${email}`);
        const { data, error } = await supabase.auth.signUp({ email, password });
        
        if (error) {
            console.error("Auth SignUp Failed:", error.message);
            return res.status(400).json({ error: error.message });
        }
        
        // Auto-create Profile
        if (data.user) {
            console.log(`2. Auth Success. User ID: ${data.user.id}`);
            console.log(`3. Attempting DB Insert into: ${TABLES.PROFILES}`);
            
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
            
            const { error: profileError } = await supabaseAdmin
                .from(TABLES.PROFILES)
                .upsert([{ 
                    id: data.user.id, 
                    email: email, 
                    role: 'customer',
                    full_name: email.split('@')[0] 
                }]);

            if (profileError) {
                 console.error("!!! DB INSERT FAILED !!!");
                 console.error("Code:", profileError.code);
                 console.error("Message:", profileError.message);
                 console.error("Details:", profileError.details);
                 console.error("Hint:", profileError.hint);
                 
                 // Return the DETAILED error to the frontend
                 return res.status(400).json({ 
                     error: `DB Error: ${profileError.message} (Code: ${profileError.code})` 
                 });
            }
            console.log("4. Profile Created Successfully");
        }
        return res.status(200).json({ user: data.user });
    }

    return res.status(400).json({ error: "Invalid auth type requested." });
}