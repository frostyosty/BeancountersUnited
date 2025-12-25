// src/utils/ui/timers.js
let timerInterval = null;

export function startLiveTimers() {
    const update = () => {
        const now = new Date();
        document.querySelectorAll('.live-timer').forEach(el => {
            const dueStr = el.dataset.due;
            if (!dueStr) return;
            
            const due = new Date(dueStr);
            const diffMs = due - now;
            const diffMins = Math.ceil(diffMs / 60000); 
            const absMins = Math.abs(diffMins);

            el.classList.remove('overdue', 'due-soon', 'okay');
            if (diffMins < 0) el.classList.add('overdue');
            else if (diffMins <= 10) el.classList.add('due-soon');
            else el.classList.add('okay');

            if (diffMins < 0) {
                if (absMins < 60) el.textContent = `${absMins}m ago`;
                else if (absMins < 1440) el.textContent = `${Math.floor(absMins / 60)}h ago`;
                else el.textContent = `${Math.floor(absMins / 1440)}d ago`;
            } else {
                if (diffMins === 0) el.textContent = "Due Now";
                else if (diffMins < 60) el.textContent = `${diffMins}m`;
                else if (diffMins < 1440) el.textContent = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
                else el.textContent = `In ${Math.floor(diffMins / 1440)}d`;
            }
        });
    };

    update(); 
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(update, 60000); 
}