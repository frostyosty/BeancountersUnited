// api/user.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const { type } = req.query; // 'profile', 'orders', 'manage', 'crm'
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) return res.status(500).json({ error: "Server Config Error" });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // --- 1. Verify Token (Common for all user actions) ---
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Missing Token" });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

    try {
        // =================================================
        // TYPE: PROFILE (Get own profile)
        // =================================================
        if (type === 'profile') {
            if (req.method !== 'GET') return res.status(405).end();
            
            const { data: profile, error } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();
            
            if (error) throw error;
            return res.status(200).json(profile);
        }

        // =================================================
        // TYPE: ORDERS (Get own orders)
        // =================================================
        if (type === 'orders') {
            if (req.method !== 'GET') return res.status(405).end();

            const { data: orders, error } = await supabaseAdmin
                .from('orders')
                .select(`
                    *,
                    order_items (
                        *,
                        menu_items (name, image_url)
                    )
                `)
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json(orders);
        }

        // =================================================
        // ADMIN CHECKS (Required for Manage and CRM)
        // =================================================
        if (type === 'manage' || type === 'crm') {
            const { data: adminProfile } = await supabaseAdmin
                .from('profiles')
                .select('role')
                .eq('id', user.id)
                .single();
                
            if (adminProfile.role !== 'manager' && adminProfile.role !== 'owner') {
                return res.status(403).json({ error: "Forbidden" });
            }
        }

        // =================================================
        // TYPE: MANAGE (List/Update Users)
        // =================================================
        if (type === 'manage') {
            if (req.method === 'GET') {
                const { data: usersList, error } = await supabaseAdmin
                    .from('profiles')
                    .select('*')
                    .order('created_at', { ascending: false });
                if (error) throw error;
                return res.status(200).json(usersList);
            }
            
            if (req.method === 'PUT') {
                const { userId, newRole, isVerifiedBuyer, canSeeOrderHistory } = req.body;
                const { error } = await supabaseAdmin
                    .from('profiles')
                    .update({ 
                        role: newRole, 
                        is_verified_buyer: isVerifiedBuyer, 
                        can_see_order_history: canSeeOrderHistory 
                    })
                    .eq('id', userId);
                if (error) throw error;
                return res.status(200).json({ success: true });
            }
        }

        // =================================================
        // TYPE: CRM (Client Relationship Mgmt & Audit)
        // =================================================
        if (type === 'crm') {
            if (req.method === 'GET') {
                const { userId } = req.query;
                if (!userId) return res.status(400).json({ error: "Missing userId" });

                const { data: profile } = await supabaseAdmin.from('profiles').select('email, full_name, internal_nickname, staff_note, staff_note_urgency').eq('id', userId).single();
                const { data: history } = await supabaseAdmin.from('orders').select(`id, created_at, total_amount, status, order_items (quantity, menu_items (name))`).eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
                const { data: logs } = await supabaseAdmin.from('audit_logs').select(`created_at, action_type, old_value, new_value, profiles:actor_id ( email, full_name )`).eq('target_user_id', userId).order('created_at', { ascending: false });

                return res.status(200).json({ profile, history, logs });
            }

            if (req.method === 'POST') {
                const { userId, nickname, note, urgency } = req.body;
                const { data: oldProfile } = await supabaseAdmin.from('profiles').select('internal_nickname, staff_note, staff_note_urgency').eq('id', userId).single();

                const updates = {};
                const auditEntries = [];

                if (nickname !== undefined && nickname !== oldProfile.internal_nickname) {
                    updates.internal_nickname = nickname;
                    auditEntries.push({ actor_id: user.id, target_user_id: userId, action_type: 'UPDATE_NICKNAME', old_value: oldProfile.internal_nickname, new_value: nickname });
                }
                if (note !== undefined && note !== oldProfile.staff_note) {
                    updates.staff_note = note;
                    auditEntries.push({ actor_id: user.id, target_user_id: userId, action_type: 'UPDATE_NOTE', old_value: oldProfile.staff_note, new_value: note });
                }
                if (urgency !== undefined && urgency !== oldProfile.staff_note_urgency) {
                    updates.staff_note_urgency = urgency;
                    auditEntries.push({ actor_id: user.id, target_user_id: userId, action_type: 'UPDATE_URGENCY', old_value: oldProfile.staff_note_urgency, new_value: urgency });
                }

                if (Object.keys(updates).length > 0) {
                    await supabaseAdmin.from('profiles').update(updates).eq('id', userId);
                    if (auditEntries.length > 0) await supabaseAdmin.from('audit_logs').insert(auditEntries);
                }
                return res.status(200).json({ success: true });
            }
        }

    } catch (error) {
        console.error("User API Error:", error);
        return res.status(500).json({ error: error.message });
    }

    return res.status(400).json({ error: "Invalid request type" });
}