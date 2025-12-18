import { createClient } from '@supabase/supabase-js';

// --- TENANCY CONFIG ---
// We define this here to avoid Vercel build path issues with importing from src/
const TABLES = {
    PROFILES: 'mealmates_profiles',
    ORDERS: 'mealmates_orders',
    ITEMS: 'mealmates_order_items',
    AUDIT: 'mealmates_audit_logs',
    MENU: 'mealmates_menu_items'
};

export default async function handler(req, res) {
    const { type } = req.query; 
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) return res.status(500).json({ error: "Server Config Error" });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // --- 1. Verify Token ---
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Missing Token" });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

    try {
        // =================================================
        // TYPE: PROFILE (Get/Update Own Profile)
        // =================================================
        if (type === 'profile') {
            if (req.method === 'GET') {
                const { data } = await supabaseAdmin
                    .from(TABLES.PROFILES)
                    .select('*')
                    .eq('id', user.id)
                    .single();
                return res.status(200).json(data);
            }
            if (req.method === 'PUT') {
                const { dietary_preferences } = req.body;
                const { error } = await supabaseAdmin
                    .from(TABLES.PROFILES)
                    .update({ dietary_preferences })
                    .eq('id', user.id);
                
                if (error) throw error;
                return res.status(200).json({ success: true });
            }
        }

        // =================================================
        // TYPE: ORDERS (Get own orders)
        // =================================================
        if (type === 'orders') {
            if (req.method !== 'GET') return res.status(405).end();

            // Check Admin Status
            const { data: profile } = await supabaseAdmin
                .from(TABLES.PROFILES)
                .select('role')
                .eq('id', user.id)
                .single();
            
            const isAdmin = profile && (profile.role === 'god' || profile.role === 'owner' || profile.role === 'manager');

            // Build Query
            // Note: We reference the foreign tables by their new names in the select string
            let query = supabaseAdmin
                .from(TABLES.ORDERS)
                .select(`
                    *,
                    ${TABLES.ITEMS} (
                        *,
                        ${TABLES.MENU} (name, image_url)
                    ),
                    ${TABLES.PROFILES} (email, full_name, internal_nickname, staff_note, staff_note_urgency)
                `)
                .order('created_at', { ascending: false });

            // If not admin, restrict to own data
            if (!isAdmin) {
                query = query.eq('user_id', user.id);
            }

            const { data, error } = await query;
            if (error) throw error;
            return res.status(200).json(data);
        }

        // =================================================
        // ADMIN CHECKS (Required for Manage, CRM, Manual)
        // =================================================
        if (['manage', 'crm', 'manual_order', 'merge_clients', 'clients'].includes(type)) {
            const { data: adminProfile } = await supabaseAdmin
                .from(TABLES.PROFILES)
                .select('role')
                .eq('id', user.id)
                .single();
            
            if (!adminProfile || (adminProfile.role !== 'god' && adminProfile.role !== 'owner')) {
                return res.status(403).json({ error: "Forbidden" });
            }
        }

        // =================================================
        // TYPE: MANAGE (List/Update Users)
        // =================================================
        if (type === 'manage') {
            if (req.method === 'GET') {
                const { data } = await supabaseAdmin
                    .from(TABLES.PROFILES)
                    .select('*')
                    .order('created_at', { ascending: false });
                return res.status(200).json(data || []);
            }
            if (req.method === 'PUT') {
                const { userId, newRole, isVerifiedBuyer, canSeeOrderHistory } = req.body;
                const { error } = await supabaseAdmin
                    .from(TABLES.PROFILES)
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
        // TYPE: CLIENTS (Rich Data Aggregation)
        // =================================================
        if (type === 'clients') {
            // 1. Fetch Profiles
            const { data: profiles, error: pError } = await supabaseAdmin.from(TABLES.PROFILES).select('*');
            if (pError) throw pError;

            // 2. Fetch Orders
            const { data: orders, error: oError } = await supabaseAdmin.from(TABLES.ORDERS).select('user_id, total_amount, created_at, status');
            if (oError) throw oError;

            // 3. Aggregate
            const clientStats = {}; 
            orders.forEach(o => {
                if (!clientStats[o.user_id]) clientStats[o.user_id] = { totalSpend: 0, lastOrder: null, orderCount: 0 };
                const stats = clientStats[o.user_id];
                if (o.status !== 'cancelled') {
                    stats.totalSpend += (o.total_amount || 0);
                    stats.orderCount += 1;
                    const d = new Date(o.created_at);
                    if (!stats.lastOrder || d > stats.lastOrder) stats.lastOrder = d;
                }
            });

            // 4. Merge
            const richClients = profiles.map(p => ({
                ...p,
                ...(clientStats[p.id] || { totalSpend: 0, lastOrder: null, orderCount: 0 })
            }));

            richClients.sort((a, b) => b.totalSpend - a.totalSpend);
            return res.status(200).json(richClients);
        }

        // =================================================
        // TYPE: CRM (Individual History)
        // =================================================
        if (type === 'crm') {
            if (req.method === 'GET') {
                const { userId } = req.query;
                
                const { data: profile } = await supabaseAdmin.from(TABLES.PROFILES).select('*').eq('id', userId).single();
                
                const { data: history } = await supabaseAdmin
                    .from(TABLES.ORDERS)
                    .select(`id, created_at, total_amount, status, ${TABLES.ITEMS} (quantity, ${TABLES.MENU} (name))`)
                    .eq('user_id', userId)
                    .order('created_at', { ascending: false })
                    .limit(10);
                
                const { data: logs } = await supabaseAdmin
                    .from(TABLES.AUDIT)
                    .select(`created_at, action_type, old_value, new_value, ${TABLES.PROFILES}:actor_id (email, full_name)`)
                    .eq('target_user_id', userId)
                    .order('created_at', { ascending: false });

                return res.status(200).json({ profile, history, logs });
            }

            if (req.method === 'POST') {
                const { userId, nickname, note, urgency } = req.body;
                const { data: old } = await supabaseAdmin.from(TABLES.PROFILES).select('*').eq('id', userId).single();
                
                const updates = {};
                const auditEntries = [];

                if (nickname !== undefined && nickname !== old.internal_nickname) {
                    updates.internal_nickname = nickname;
                    auditEntries.push({ actor_id: user.id, target_user_id: userId, action_type: 'UPDATE_NICKNAME', old_value: old.internal_nickname, new_value: nickname });
                }
                if (note !== undefined && note !== old.staff_note) {
                    updates.staff_note = note;
                    auditEntries.push({ actor_id: user.id, target_user_id: userId, action_type: 'UPDATE_NOTE', old_value: old.staff_note, new_value: note });
                }
                if (urgency !== undefined && urgency !== old.staff_note_urgency) {
                    updates.staff_note_urgency = urgency;
                }

                if (Object.keys(updates).length > 0) {
                    await supabaseAdmin.from(TABLES.PROFILES).update(updates).eq('id', userId);
                    if (auditEntries.length > 0) await supabaseAdmin.from(TABLES.AUDIT).insert(auditEntries);
                }
                return res.status(200).json({ success: true });
            }
        }

        // =================================================
        // TYPE: MANUAL ORDER
        // =================================================
        if (type === 'manual_order') {
            const { items, total, customerName, dueTime, createdAt, targetUserId } = req.body;
            
            const assignedUserId = targetUserId || user.id;

            // 1. Insert Order
            const { data: order, error: orderError } = await supabaseAdmin.from(TABLES.ORDERS).insert([{
                user_id: assignedUserId, 
                total_amount: total, 
                status: 'pending', // Show in live orders
                payment_status: 'paid', 
                payment_method: 'manual_entry', 
                customer_name: customerName || 'Walk-in',
                customer_email: null,
                pickup_time: dueTime || new Date().toISOString(),
                created_at: createdAt || new Date().toISOString()
            }]).select().single();

            if (orderError || !order) {
                console.error("Manual Order Header Failed:", orderError);
                throw new Error("Failed to create order.");
            }
            
            // 2. Insert Items
            const itemsData = items.map(i => ({ 
                order_id: order.id, 
                menu_item_id: i.id, 
                quantity: i.quantity, 
                price_at_order: i.price 
            }));
            
            const { error: itemsError } = await supabaseAdmin.from(TABLES.ITEMS).insert(itemsData);
            if (itemsError) throw itemsError;

            return res.status(200).json({ success: true, orderId: order.id });
        }

        // =================================================
        // TYPE: MERGE CLIENTS
        // =================================================
        if (type === 'merge_clients') {
            if (req.method !== 'POST') return res.status(405).end();
            const { sourceId, targetId } = req.body;
            
            if (!sourceId || !targetId) return res.status(400).json({ error: "Missing IDs" });

            // 1. Move Orders
            await supabaseAdmin.from(TABLES.ORDERS).update({ user_id: targetId }).eq('user_id', sourceId);
            
            // 2. Move Audit Logs
            await supabaseAdmin.from(TABLES.AUDIT).update({ target_user_id: targetId }).eq('target_user_id', sourceId);

            // 3. Delete Source
            await supabaseAdmin.from(TABLES.PROFILES).delete().eq('id', sourceId);

            return res.status(200).json({ success: true });
        }

    } catch (error) {
        console.error("User API Error:", error);
        return res.status(500).json({ error: error.message });
    }

    return res.status(400).json({ error: "Invalid Request" });
}