export const DB_PREFIX = 'beancountersunited_'; // Change this variable to swap restaurants
export const TABLES = {
    MENU: `${DB_PREFIX}menu_items`,
    ORDERS: `${DB_PREFIX}orders`,
    ITEMS: `${DB_PREFIX}order_items`,
    PROFILES: `${DB_PREFIX}profiles`,
    SETTINGS: `${DB_PREFIX}site_settings`,
    AUDIT: `${DB_PREFIX}audit_logs`
};