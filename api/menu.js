// api/menu.js
import { getActiveDbClient, getUserFromRequest, getUserProfile } from './_db.js';

export default async function handler(req, res) {
    const { client, type } = await getActiveDbClient();
    const user = await getUserFromRequest(req); // For auth checks
    let userProfile = null;
    if (user) {
        try {
            userProfile = await getUserProfile(user.id);
        } catch(profileError) {
            console.warn("Could not fetch profile for authenticated user:", profileError.message);
            // User is authenticated but may not have a profile entry or role.
            // Decide how to handle: proceed with default/no role, or deny.
            // For simplicity, let's allow viewing menu, but block modifications without a specific role.
        }
    }

    const { itemId } = req.query; // For routes like /api/menu/[itemId] if you set up path segments

    if (req.method === 'GET') {
        // Get all menu items
        try {
            if (type === 'supabase') {
                const { data, error } = await client.from('menu_items').select('*').order('category').order('name');
                if (error) throw error;
                return res.status(200).json(data);
            } else if (type === 'turso') {
                const rs = await client.execute("SELECT * FROM menu_items ORDER BY category, name;");
                return res.status(200).json(rs.rows);
            }
        } catch (error) {
            console.error('Error fetching menu:', error);
            return res.status(500).json({ message: 'Failed to fetch menu items', error: error.message });
        }
    } else if (req.method === 'POST') {
        // Add new menu item (Owner/Manager only)
        if (!userProfile || (userProfile.role !== 'owner' && userProfile.role !== 'manager')) {
            return res.status(403).json({ message: 'Forbidden: Insufficient privileges.' });
        }
        try {
            const { name, description, price, category, image_url } = req.body;
             if (!name || price === undefined) {
                return res.status(400).json({ message: 'Name and price are required.' });
            }
            if (type === 'supabase') {
                const { data, error } = await client.from('menu_items').insert([{ name, description, price, category, image_url }]).select().single();
                if (error) throw error;
                return res.status(201).json(data);
            } else if (type === 'turso') {
                // Turso (SQLite) doesn't have .returning() quite like Postgres for inserts.
                // You might insert then select, or use last_insert_rowid()
                await client.execute({
                    sql: "INSERT INTO menu_items (name, description, price, category, image_url) VALUES (?, ?, ?, ?, ?);",
                    args: [name, description, price, category, image_url]
                });
                // This is a simplification, you'd typically fetch the last inserted row by ID if needed.
                // For now, just return the input data or a success message.
                const rs = await client.execute({ sql: "SELECT * FROM menu_items WHERE rowid = last_insert_rowid();"});
                return res.status(201).json(rs.rows[0]);
            }
        } catch (error) {
             console.error('Error adding menu item:', error);
            return res.status(500).json({ message: 'Failed to add menu item', error: error.message });
        }
    } else if (req.method === 'PUT') {
        // Update menu item (Owner/Manager only)
        // Assuming itemId is passed in the URL, e.g., /api/menu?itemId=xxx
        // Or Vercel path segments /api/menu/[itemId]. For now, use query param for simplicity.
        const idToUpdate = req.query.itemId;
        if (!idToUpdate) return res.status(400).json({ message: "Item ID is required for update." });

        if (!userProfile || (userProfile.role !== 'owner' && userProfile.role !== 'manager')) {
            return res.status(403).json({ message: 'Forbidden: Insufficient privileges.' });
        }
        try {
            const { name, description, price, category, image_url } = req.body;
            const updates = {};
            if (name !== undefined) updates.name = name;
            if (description !== undefined) updates.description = description;
            if (price !== undefined) updates.price = price;
            if (category !== undefined) updates.category = category;
            if (image_url !== undefined) updates.image_url = image_url;

            if (Object.keys(updates).length === 0) {
                 return res.status(400).json({ message: 'No update fields provided.' });
            }

            if (type === 'supabase') {
                const { data, error } = await client.from('menu_items').update(updates).eq('id', idToUpdate).select().single();
                if (error) throw error;
                if (!data) return res.status(404).json({ message: "Menu item not found."});
                return res.status(200).json(data);
            } else if (type === 'turso') {
                // Build the SET part of the query dynamically
                const setClauses = [];
                const args = [];
                for (const key in updates) {
                    setClauses.push(`${key} = ?`);
                    args.push(updates[key]);
                }
                args.push(idToUpdate); // For the WHERE clause

                const rs = await client.execute({
                    sql: `UPDATE menu_items SET ${setClauses.join(', ')} WHERE id = ?;`,
                    args: args
                });

                if (rs.rowsAffected === 0) return res.status(404).json({ message: "Menu item not found or no change."});

                // Fetch the updated row to return it
                const updatedItemRs = await client.execute({sql: "SELECT * FROM menu_items WHERE id = ?", args: [idToUpdate]});
                return res.status(200).json(updatedItemRs.rows[0]);
            }
        } catch (error) {
            console.error('Error updating menu item:', error);
            return res.status(500).json({ message: 'Failed to update menu item', error: error.message });
        }
    } else if (req.method === 'DELETE') {
        // Delete menu item (Owner/Manager only)
        const idToDelete = req.query.itemId;
        if (!idToDelete) return res.status(400).json({ message: "Item ID is required for deletion." });

        if (!userProfile || (userProfile.role !== 'owner' && userProfile.role !== 'manager')) {
            return res.status(403).json({ message: 'Forbidden: Insufficient privileges.' });
        }
        try {
            if (type === 'supabase') {
                const { error, count } = await client.from('menu_items').delete({count: 'exact'}).eq('id', idToDelete);
                if (error) throw error;
                if (count === 0) return res.status(404).json({ message: "Menu item not found."});
                return res.status(204).send(); // No content
            } else if (type === 'turso') {
                const rs = await client.execute({
                    sql: "DELETE FROM menu_items WHERE id = ?;",
                    args: [idToDelete]
                });
                if (rs.rowsAffected === 0) return res.status(404).json({ message: "Menu item not found."});
                return res.status(204).send();
            }
        } catch (error) {
             console.error('Error deleting menu item:', error);
            return res.status(500).json({ message: 'Failed to delete menu item', error: error.message });
        }
    } else {
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}