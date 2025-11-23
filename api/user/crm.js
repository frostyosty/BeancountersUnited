// api/user/crm.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
        return res.status(500).json({ error: "Server Config Error" });
    }
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Auth Check (Manager/Owner Only)
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Missing Token" });

    const { data: { user: actor }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !actor) return res.status(401).json({ error: "Unauthorized" });

    const { data: adminProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', actor.id).single();
    if (adminProfile.role !== 'manager' && adminProfile.role !== 'owner') {
        return res.status(403).json({ error: "Forbidden" });
    }

    // --- GET REQUEST (Fetch Profile + History + Audit Logs) ---
    if (req.method === 'GET') {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: "Missing userId" });

        // A. Profile
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('email, full_name, internal_nickname, staff_note, staff_note_urgency')
            .eq('id', userId)
            .single();

        // B. Order History
        const { data: history } = await supabaseAdmin
            .from('orders')
            .select(`id, created_at, total_amount, status, order_items (quantity, menu_items (name))`)
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(10);

        // C. Audit Logs (NEW)
        const { data: logs } = await supabaseAdmin
            .from('audit_logs')
            .select(`
                created_at, action_type, old_value, new_value,
                profiles:actor_id ( email, full_name ) 
            `) // Join to get the Manager's name
            .eq('target_user_id', userId)
            .order('created_at', { ascending: false });

        return res.status(200).json({ profile, history, logs });
    }

    // --- POST REQUEST (Update + Log) ---
    if (req.method === 'POST') {
        const { userId, nickname, note, urgency } = req.body;
        
        // 1. Fetch CURRENT data (to compare)
        const { data: oldProfile } = await supabaseAdmin
            .from('profiles')
            .select('internal_nickname, staff_note, staff_note_urgency')
            .eq('id', userId)
            .single();

        const updates = {};
        const auditEntries = [];

        // 2. Compare and Prepare Logs
        // Nickname Change
        if (nickname !== undefined && nickname !== oldProfile.internal_nickname) {
            updates.internal_nickname = nickname;
            auditEntries.push({
                actor_id: actor.id,
                target_user_id: userId,
                action_type: 'UPDATE_NICKNAME',
                old_value: oldProfile.internal_nickname || '(none)',
                new_value: nickname
            });
        }

        // Note Change
        if (note !== undefined && note !== oldProfile.staff_note) {
            updates.staff_note = note;
            auditEntries.push({
                actor_id: actor.id,
                target_user_id: userId,
                action_type: 'UPDATE_NOTE',
                old_value: oldProfile.staff_note || '(none)',
                new_value: note
            });
        }

        // Urgency Change
        if (urgency !== undefined && urgency !== oldProfile.staff_note_urgency) {
            updates.staff_note_urgency = urgency;
            // Optional: Log urgency changes too if you want granular detail
             auditEntries.push({
                actor_id: actor.id,
                target_user_id: userId,
                action_type: 'UPDATE_URGENCY',
                old_value: oldProfile.staff_note_urgency || 'info',
                new_value: urgency
            });
        }

        // 3. Perform Update
        if (Object.keys(updates).length > 0) {
            const { error } = await supabaseAdmin
                .from('profiles')
                .update(updates)
                .eq('id', userId);

            if (error) return res.status(500).json({ error: error.message });

            // 4. Insert Audit Logs
            if (auditEntries.length > 0) {
                await supabaseAdmin.from('audit_logs').insert(auditEntries);
            }
        }

        return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
}