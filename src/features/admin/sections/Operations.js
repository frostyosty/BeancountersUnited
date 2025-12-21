// src/features/admin/sections/Operations.js
import * as uiUtils from '@/utils/uiUtils.js';

export function renderOperationsSection(settings) {
    const hours = settings.openingHours || {};
    const delivery = settings.deliveryConfig || {};

    // Helper for Day Rows
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const hoursRows = days.map(day => {
        const d = hours[day] || { isOpen: true, start: '08:00', end: '17:00' };
        return `
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:5px;">
                <span style="width:90px; text-transform:capitalize;">${day}</span>
                <label><input type="checkbox" name="open_${day}" ${d.isOpen?'checked':''}> Open</label>
                <input type="time" name="start_${day}" value="${d.start}">
                <span>to</span>
                <input type="time" name="end_${day}" value="${d.end}">
            </div>
        `;
    }).join('');

    return `
        <section class="dashboard-section" style="border-left: 5px solid #28a745;">
            <h3>Store Operations</h3>
            
            <form id="operations-form">
                
                <!-- OPENING HOURS -->
                <div style="margin-bottom:20px;">
                    <label style="font-weight:bold; display:flex; gap:10px; align-items:center; cursor:pointer; margin-bottom:10px;">
                        <input type="checkbox" name="hoursEnabled" ${hours.enabled ? 'checked' : ''}> 
                        Enforce Opening Hours (Block checkout when closed)
                    </label>
                    <div style="background:#f9f9f9; padding:10px; border-radius:8px; border:1px solid #eee;">
                        ${hoursRows}
                    </div>
                </div>

                <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

                <!-- DELIVERY SETTINGS -->
                <div>
                    <label style="font-weight:bold; display:flex; gap:10px; align-items:center; cursor:pointer; margin-bottom:10px;">
                        <input type="checkbox" name="deliveryEnabled" ${delivery.enabled ? 'checked' : ''}> 
                        Enable Delivery Option
                    </label>
                    
                    <div id="delivery-config-panel" style="display:${delivery.enabled ? 'block' : 'none'}; background:#f0f8ff; padding:15px; border-radius:8px;">
                        <h4>Delivery Rules</h4>
                        
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:15px;">
                            <div class="form-group">
                                <label>Base Fee ($)</label>
                                <input type="number" name="baseFee" value="${delivery.baseFee || 5}" step="0.50">
                            </div>
                            <div class="form-group">
                                <label>Fee per Km ($)</label>
                                <input type="number" name="feePerKm" value="${delivery.feePerKm || 1}" step="0.10">
                            </div>
                            <div class="form-group">
                                <label>Max Radius (Km)</label>
                                <input type="number" name="maxDistanceKm" value="${delivery.maxDistanceKm || 10}">
                            </div>
                        </div>

                        <h4>Cafe Location (For Distance Calc)</h4>
                        <div style="display:flex; gap:10px; margin-bottom:10px;">
                            <button type="button" id="btn-get-cafe-location" class="button-secondary small">📍 Set Current Location</button>
                            <span id="cafe-coords-display" style="font-size:0.8rem; color:#666;">
                                ${delivery.cafeLat ? `${delivery.cafeLat}, ${delivery.cafeLng}` : 'Not set'}
                            </span>
                            <input type="hidden" name="cafeLat" id="input-cafe-lat" value="${delivery.cafeLat || ''}">
                            <input type="hidden" name="cafeLng" id="input-cafe-lng" value="${delivery.cafeLng || ''}">
                        </div>
                    </div>
                </div>

                <div style="text-align:right; margin-top:20px;">
                    <button type="submit" class="button-primary">Save Operations</button>
                </div>
            </form>
        </section>
    `;
}