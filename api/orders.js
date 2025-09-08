// /api/orders.js
import { supabaseAdmin, getUserFromRequest } from './_db.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end('Method Not Allowed');
    }

    try {
        const { customerDetails, items, totalAmount } = req.body;

        if (!items || items.length === 0 || !totalAmount || !customerDetails?.pickupTime || !customerDetails?.name || !customerDetails?.email) {
            return res.status(400).json({ error: 'Missing required order information.' });
        }

        const { user } = await getUserFromRequest(req);

        if (totalAmount > 10 && !user) {
            return res.status(403).json({ error: 'Login is required for orders over $10.' });
        }

        const orderPayload = {
            p_user_id: user?.id || null,
            p_customer_name: customerDetails.name,
            p_customer_email: customerDetails.email,
            p_customer_phone: customerDetails.phone,
            p_total_amount: totalAmount,
            p_pickup_time: customerDetails.pickupTime,
            p_special_requests: customerDetails.specialRequests,
            p_order_items: items.map(item => ({
                menu_item_id: item.id,
                quantity: item.quantity,
                price_at_order: item.price
            }))
        };

        const { data: newOrder, error: transactionError } = await supabaseAdmin.rpc('create_new_order', orderPayload);

        if (transactionError) {
            console.error('Supabase RPC error creating order:', transactionError);
            throw new Error('Database transaction failed.');
        }

        // --- NEW LOGIC: VERIFIED BUYER STATUS ---
        // If the order was successful AND was placed by a logged-in user,
        // update their profile to mark them as a verified buyer.
        if (user?.id) {
            console.log(`Order successful for user ${user.id}. Marking as verified buyer...`);
            const { error: profileUpdateError } = await supabaseAdmin
                .from('profiles')
                .update({ is_verified_buyer: true })
                .eq('id', user.id);

            if (profileUpdateError) {
                // This is not a critical error; the order was still placed.
                // We just log it for monitoring purposes.
                console.error(`Failed to update profile for user ${user.id} to verified buyer:`, profileUpdateError);
            } else {
                console.log(`User ${user.id} successfully marked as verified buyer.`);
            }
        }
        // --- END NEW LOGIC ---

        return res.status(201).json(newOrder);

    } catch (error) {
        console.error('Error in /api/orders handler:', error);
        return res.status(500).json({ error: 'Internal Server Error: Could not place order.' });
    }
}