// Global state to track current active reminder in modal
let activeReminderLogId = null;
let timeOffsetMs = 5 * 60 * 1000; // Global 5-minute offset to fix slow client/PC clocks!

// Clock tick utility
function initClock() {
    const clockEl = document.getElementById('liveClock');
    setInterval(() => {
        const now = new Date(Date.now() + timeOffsetMs);
        const timeStr = now.toLocaleTimeString('vi-VN', { hour12: false });
        clockEl.textContent = timeStr;
    }, 1000);
}

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    refreshAllData();
    initSSE();
    
    // Set default date text to today's date
    const dateTextEl = document.getElementById('currentDateText');
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    dateTextEl.textContent = new Date(Date.now() + timeOffsetMs).toLocaleDateString('vi-VN', options);

    // Auto-sync Sáng/Tối toggle button state on manual time input change
    const remindTimeInput = document.getElementById('remindTime');
    if (remindTimeInput) {
        remindTimeInput.addEventListener('change', function() {
            const toggleBtn = document.getElementById('timePeriodToggle');
            if (!this.value || !toggleBtn) return;
            let [hours, minutes] = this.value.split(':').map(Number);
            if (hours >= 12) {
                toggleBtn.innerHTML = '<i class="fa-solid fa-cloud-sun text-yellow"></i> Sáng (AM)';
            } else {
                toggleBtn.innerHTML = '<i class="fa-solid fa-cloud-moon text-blue"></i> Tối (PM)';
            }
        });
    }
});

// Full UI Refresh helper
function refreshAllData() {
    fetchPrescriptions();
    fetchLogs();
    fetchStats();
    fetchChatHistory();
}

// 1. SSE Connection for Real-Time UI Updates from Python Background Scheduler
function initSSE() {
    console.log("Initializing SSE Connection...");
    const eventSource = new EventSource('/api/events');
    
    eventSource.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            console.log("Received SSE event: ", data);
            
            if (data.type === 'data_changed') {
                refreshAllData();
            } 
            else if (data.type === 'mic_listening') {
                setMicListening(true, "Trợ lý đang thu âm từ mic máy tính...");
            } 
            else if (data.type === 'mic_stopped') {
                setMicListening(false, "Nhấp để ra lệnh giọng nói");
            } 
            else if (data.type === 'reminder_triggered') {
                showReminderModal(data);
            } 
            else if (data.type === 'reminder_resolved') {
                hideReminderModal();
                refreshAllData();
            }
        } catch (e) {
            console.error("Error parsing SSE message: ", e);
        }
    };
    
    eventSource.onerror = function(err) {
        console.warn("SSE connection error, reconnecting in 5s...", err);
        eventSource.close();
        setTimeout(initSSE, 5000);
    };
}

// 2. Fetch Prescriptions
async function fetchPrescriptions() {
    try {
        const response = await fetch('/api/prescriptions');
        const res = await response.json();
        
        const container = document.getElementById('prescriptionsContainer');
        const countBadge = document.getElementById('prescriptionsCount');
        
        if (!res.success || res.data.length === 0) {
            container.innerHTML = `
                <div class="empty-placeholder">
                    <i class="fa-solid fa-prescription-bottle text-muted"></i>
                    Chưa có đơn thuốc nào. Hãy thêm bằng giọng nói hoặc nhập form bên dưới!
                </div>
            `;
            countBadge.textContent = "0 đơn thuốc";
            return;
        }
        
        countBadge.textContent = `${res.data.length} đơn thuốc`;
        container.innerHTML = res.data.map(p => {
            const dateStr = p.remind_date ? `<span class="date-tag"><i class="fa-solid fa-calendar-day"></i> ${formatDate(p.remind_date)}</span>` : `<span class="date-tag daily"><i class="fa-solid fa-repeat"></i> Hàng ngày</span>`;
            const color = p.med_color || '#3b82f6';
            return `
            <div class="prescription-item" id="pres-item-${p.id}">
                <div class="pres-info">
                    <div class="pres-avatar"><i class="fa-solid fa-pills"></i></div>
                    <div class="pres-details">
                        <h5><span class="med-color-dot" style="background-color: ${color}; display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; vertical-align: middle; box-shadow: 0 0 6px ${color};"></span>${escapeHTML(p.med_name)}</h5>
                        <p><i class="fa-solid fa-weight-hanging"></i> ${escapeHTML(p.dosage)} &nbsp;&nbsp; <span><i class="fa-solid fa-clock"></i> ${p.remind_time}</span> &nbsp;&nbsp; ${dateStr}</p>
                    </div>
                </div>
                <button onclick="deletePrescription(${p.id})" class="btn-icon-danger" title="Xóa đơn thuốc này">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
            `;
        }).join('');
        
    } catch (e) {
        console.error("Error fetching prescriptions: ", e);
    }
}

// 3. Fetch Today's Medication Logs (Timeline)
async function fetchLogs() {
    try {
        const response = await fetch('/api/logs');
        const res = await response.json();
        
        const container = document.getElementById('timelineContainer');
        if (!container) return;
        
        if (!res.success || res.data.length === 0) {
            container.innerHTML = `
                <div class="empty-placeholder">
                    <i class="fa-solid fa-calendar-xmark text-muted"></i>
                    Không có lịch nhắc thuốc nào hôm nay.
                </div>
            `;
            return;
        }
        
        const pendingLogs = res.data.filter(log => log.status === 'PENDING');
        
        if (pendingLogs.length === 0) {
            container.innerHTML = `
                <div class="empty-placeholder" style="border: 1px dashed var(--success); background: rgba(16, 185, 129, 0.03); color: #34d399; padding: 24px;">
                    <i class="fa-solid fa-circle-check" style="font-size: 24px; color: var(--success); display: block; margin-bottom: 8px;"></i>
                    Tuyệt vời! Bạn đã hoàn thành tất cả lịch uống thuốc hôm nay.
                </div>
            `;
            return;
        }
        
        container.innerHTML = pendingLogs.map(log => {
            const statusClass = 'pending';
            const dateStr = log.remind_date ? `<span class="date-tag"><i class="fa-solid fa-calendar-day"></i> ${formatDate(log.remind_date)}</span>` : `<span class="date-tag daily"><i class="fa-solid fa-repeat"></i> Hàng ngày</span>`;
            const color = log.med_color || '#3b82f6';
            
            return `
                <div class="timeline-item ${statusClass}" id="log-item-${log.log_id}">
                    <div class="timeline-node"></div>
                    <div class="timeline-body">
                        <div class="timeline-info">
                            <div class="timeline-time">${log.scheduled_time}</div>
                            <div class="timeline-med-details">
                                <h5><span class="med-color-dot" style="background-color: ${color}; display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; vertical-align: middle; box-shadow: 0 0 6px ${color};"></span>${escapeHTML(log.med_name)}</h5>
                                <p><i class="fa-solid fa-pills"></i> ${escapeHTML(log.dosage)} &nbsp;&nbsp; ${dateStr}</p>
                            </div>
                        </div>
                        <div class="timeline-actions">
                            <button onclick="updateLogStatus(${log.log_id}, 'TAKEN')" class="btn-circle check" title="Xác nhận đã uống">
                                <i class="fa-solid fa-check"></i>
                            </button>
                            <button onclick="updateLogStatus(${log.log_id}, 'MISSED')" class="btn-circle skip" title="Đánh dấu bỏ qua">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
    } catch (e) {
        console.error("Error fetching logs: ", e);
    }
}

// 4. Fetch Adherence Stats
async function fetchStats() {
    try {
        const response = await fetch('/api/stats');
        const res = await response.json();
        
        if (res.success) {
            document.getElementById('statRate').textContent = `${Math.round(res.data.compliance_rate)}%`;
            document.getElementById('statTaken').textContent = res.data.TAKEN;
            document.getElementById('statMissed').textContent = res.data.MISSED;
            document.getElementById('statPending').textContent = res.data.PENDING;
        }
    } catch (e) {
        console.error("Error fetching stats: ", e);
    }
}

// 5. Fetch Chat/Voice Console History
async function fetchChatHistory() {
    try {
        const response = await fetch('/api/chat/history');
        const res = await response.json();
        
        const consoleEl = document.getElementById('chatConsole');
        if (res.success) {
            consoleEl.innerHTML = res.data.map(c => `
                <div class="chat-msg ${c.speaker}">
                    <div class="chat-bubble">
                        ${escapeHTML(c.text)}
                    </div>
                    <div class="chat-meta">
                        <span>${c.speaker === 'assistant' ? 'Trợ lý' : c.speaker === 'user' ? 'Người dùng' : 'Hệ thống'}</span>
                        <span>&bull;</span>
                        <span>${c.timestamp}</span>
                    </div>
                </div>
            `).join('');
            
            // Auto scroll to bottom
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
    } catch (e) {
        console.error("Error fetching chat history: ", e);
    }
}

// 6. Manual Prescription Form Submit
async function submitPrescription(e) {
    e.preventDefault();
    
    const medName = document.getElementById('medName').value.trim();
    const dosage = document.getElementById('dosage').value.trim() || '1 viên';
    const remindTime = document.getElementById('remindTime').value;
    const remindDate = document.getElementById('remindDate').value;
    
    const medColorEl = document.querySelector('input[name="medColor"]:checked');
    const medColor = medColorEl ? medColorEl.value : '#3b82f6';
    
    if (!medName || !remindTime) return;
    
    try {
        const response = await fetch('/api/prescriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ med_name: medName, dosage: dosage, remind_time: remindTime, remind_date: remindDate, med_color: medColor })
        });
        const res = await response.json();
        
        if (res.success) {
            document.getElementById('addPrescriptionForm').reset();
            // Default dosage back to "1 viên"
            document.getElementById('dosage').value = "1 viên";
            refreshAllData();
        } else {
            alert("Lỗi: " + res.message);
        }
    } catch (err) {
        console.error("Error submitting prescription: ", err);
    }
}

// 7. Delete Prescription
async function deletePrescription(presId) {
    if (!confirm("Bạn có chắc chắn muốn xóa đơn thuốc này? Điều này cũng sẽ xóa toàn bộ lịch nhắc hôm nay.")) return;
    
    try {
        const response = await fetch(`/api/prescriptions/${presId}`, {
            method: 'DELETE'
        });
        const res = await response.json();
        if (res.success) {
            refreshAllData();
        }
    } catch (err) {
        console.error("Error deleting prescription: ", err);
    }
}

// 8. Manual Override Log Compliance Status (Timeline Checkmark/Skip Buttons)
async function updateLogStatus(logId, status) {
    try {
        const response = await fetch(`/api/logs/${logId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status })
        });
        const res = await response.json();
        if (res.success) {
            refreshAllData();
        }
    } catch (err) {
        console.error("Error updating log status: ", err);
    }
}

// 9. Browser-Based Speech Recognition (Web Speech API) with Backend Text API Fallback
async function triggerMic() {
    // Check if Browser Speech Recognition is supported
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (SpeechRecognition) {
        console.log("Using Browser-based SpeechRecognition (Web Speech API)...");
        const recognition = new SpeechRecognition();
        recognition.lang = 'vi-VN';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        
        recognition.onstart = () => {
            setMicListening(true, "Trợ lý đang lắng nghe giọng nói tiếng Việt...");
        };
        
        recognition.onerror = (e) => {
            console.error("Browser speech recognition error: ", e);
            setMicListening(false, "Lỗi nhận diện giọng nói");
            // If user blocked microphone permission, warn them
            if (e.error === 'not-allowed') {
                alert("Vui lòng cấp quyền truy cập Microphone cho trình duyệt để ra lệnh bằng giọng nói!");
            }
        };
        
        recognition.onend = () => {
            setMicListening(false, "Nhấp để ra lệnh giọng nói");
        };
        
        recognition.onresult = async (event) => {
            const voiceText = event.results[0][0].transcript;
            console.log("Browser recognized text: ", voiceText);
            
            // Send the text to the backend for execution
            try {
                const response = await fetch('/api/voice/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: voiceText })
                });
                const res = await response.json();
                console.log("Backend voice text response: ", res);
            } catch (err) {
                console.error("Error sending voice text to backend: ", err);
            } finally {
                refreshAllData();
            }
        };
        
        recognition.start();
    } else {
        // Fallback to Server-side Microphone (requires PyAudio)
        console.warn("Browser SpeechRecognition not supported, falling back to server-side PyAudio...");
        setMicListening(true, "Đang khởi động mic máy chủ...");
        try {
            const response = await fetch('/api/voice/trigger', {
                method: 'POST'
            });
            const res = await response.json();
            console.log("Mic API Trigger response: ", res);
            if (!res.success) {
                alert("Lỗi Microphone máy chủ: " + res.message);
            }
        } catch (err) {
            console.error("Error triggering server microphone: ", err);
            alert("Lỗi kết nối máy chủ: " + err.message);
        } finally {
            setMicListening(false, "Nhấp để ra lệnh giọng nói");
            refreshAllData();
        }
    }
}

// UI helper to toggle microphone listening visual effects
function setMicListening(isListening, statusText) {
    const btn = document.getElementById('micBtn');
    const label = document.getElementById('micStatusText');
    
    if (isListening) {
        btn.classList.add('listening');
        label.classList.add('text-red');
        label.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${statusText}`;
    } else {
        btn.classList.remove('listening');
        label.classList.remove('text-red');
        label.textContent = statusText;
    }
}

// 10. Active Reminder Modal Management (Triggered from Background Thread SSE events)
function showReminderModal(data) {
    activeReminderLogId = data.log_id;
    document.getElementById('modalMedName').textContent = data.med_name;
    document.getElementById('modalMedDosage').innerHTML = `<i class="fa-solid fa-pills"></i> Liều lượng: ${data.dosage}`;
    document.getElementById('modalMedTime').innerHTML = `<i class="fa-solid fa-clock"></i> Giờ uống: ${data.scheduled_time}`;
    
    // Dynamic color coding for the alert modal
    const color = data.med_color || '#3b82f6';
    
    const modalContent = document.querySelector('#reminderModal .modal-content');
    if (modalContent) {
        modalContent.style.borderColor = color;
        modalContent.style.boxShadow = `0 0 25px ${color}80, var(--shadow-main)`;
    }
    
    const modalMedName = document.getElementById('modalMedName');
    if (modalMedName) {
        modalMedName.style.color = color;
        modalMedName.style.textShadow = `0 0 8px ${color}40`;
    }
    
    const modalAlertIcon = document.querySelector('#reminderModal .modal-header i');
    if (modalAlertIcon) {
        modalAlertIcon.style.color = color;
    }
    
    const pulseDot = document.querySelector('#reminderModal .pulse-dot');
    if (pulseDot) {
        pulseDot.style.backgroundColor = color;
        pulseDot.style.boxShadow = `0 0 0 0 ${color}`;
    }
    
    const micRipple = document.querySelector('#reminderModal .mic-ripple-small');
    if (micRipple) {
        micRipple.style.borderColor = color;
        micRipple.style.color = color;
        micRipple.style.boxShadow = `0 0 15px ${color}30`;
    }
    
    // 1. Play alert chime sound
    try {
        const chime = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-200.wav');
        chime.volume = 0.4;
        chime.play();
    } catch (e) {
        console.log("Audio autoplay prevented by browser permissions.");
    }
    
    // 2. Browser-based voice notification (Web Speech API) has been removed.
    // The Python backend (VoiceAssistant) handles playing the voice prompt directly
    // to ensure it synchronizes properly with the microphone listening phase.
    
    const modal = document.getElementById('reminderModal');
    modal.classList.remove('hidden');
    
    // Automatically trigger browser speech recognition after 4.5 seconds (giving time for backend voice to speak!)
    setTimeout(() => {
        // Only trigger if modal is still open and visible
        if (!modal.classList.contains('hidden')) {
            console.log("Automatically triggering browser speech recognition for hands-free confirmation...");
            triggerMic();
        }
    }, 4500);
}

function hideReminderModal() {
    const modal = document.getElementById('reminderModal');
    modal.classList.add('hidden');
    activeReminderLogId = null;
}

// Triggered when clicking manual override buttons inside the glowing modal popup
async function manualResolveReminder(status) {
    if (!activeReminderLogId) return;
    
    try {
        const logId = activeReminderLogId;
        hideReminderModal(); // Hide modal first to give immediate responsive feedback
        
        const response = await fetch(`/api/logs/${logId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status })
        });
        const res = await response.json();
        
        if (res.success) {
            refreshAllData();
        }
    } catch (err) {
        console.error("Error manually resolving reminder modal: ", err);
    }
}

// Small helper to secure logs and prevent HTML injections
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// Format YYYY-MM-DD into Vietnamese standard DD/MM/YYYY
function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// Sáng (AM) / Tối (PM) Toggle helper for time input
function toggleTimePeriod() {
    const timeInput = document.getElementById('remindTime');
    const toggleBtn = document.getElementById('timePeriodToggle');
    if (!timeInput || !toggleBtn) return;
    
    if (!timeInput.value) {
        // Default to a PM time if empty
        timeInput.value = "19:00";
        toggleBtn.innerHTML = '<i class="fa-solid fa-cloud-sun text-yellow"></i> Sáng (AM)';
        return;
    }
    
    let [hours, minutes] = timeInput.value.split(':').map(Number);
    if (hours < 12) {
        // Shift +12 hours to PM (Evening/Tối)
        hours += 12;
        toggleBtn.innerHTML = '<i class="fa-solid fa-cloud-sun text-yellow"></i> Sáng (AM)';
    } else {
        // Shift -12 hours to AM (Morning/Sáng)
        hours -= 12;
        toggleBtn.innerHTML = '<i class="fa-solid fa-cloud-moon text-blue"></i> Tối (PM)';
    }
    
    timeInput.value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Quick Preset Time Setter helper
function setPresetTime(timeVal) {
    const timeInput = document.getElementById('remindTime');
    const toggleBtn = document.getElementById('timePeriodToggle');
    if (!timeInput || !toggleBtn) return;
    
    timeInput.value = timeVal;
    let [hours, minutes] = timeVal.split(':').map(Number);
    if (hours >= 12) {
        toggleBtn.innerHTML = '<i class="fa-solid fa-cloud-sun text-yellow"></i> Sáng (AM)';
    } else {
        toggleBtn.innerHTML = '<i class="fa-solid fa-cloud-moon text-blue"></i> Tối (PM)';
    }
}

// Show statistics details in a beautiful glassmorphic modal
async function showStatsModal(filterType) {
    try {
        const response = await fetch('/api/logs');
        const res = await response.json();
        
        const listContainer = document.getElementById('statsModalList');
        if (!listContainer) return;
        
        if (!res.success || res.data.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-placeholder">
                    <i class="fa-solid fa-calendar-xmark text-muted"></i>
                    Không có lịch nhắc thuốc nào hôm nay.
                </div>
            `;
            document.getElementById('statsModalTitle').textContent = "Danh Sách Trống";
            document.getElementById('statsDetailsModal').classList.remove('hidden');
            return;
        }
        
        let filteredLogs = [];
        let title = "Danh Sách Lịch Trình";
        let iconClass = "fa-solid fa-chart-line text-purple";
        let colorTheme = "#7c3aed";
        
        if (filterType === 'ALL') {
            filteredLogs = res.data;
            title = "Tất Cả Lịch Trình Hôm Nay";
            iconClass = "fa-solid fa-chart-line text-purple";
            colorTheme = "#7c3aed";
        } else if (filterType === 'TAKEN') {
            filteredLogs = res.data.filter(log => log.status === 'TAKEN');
            title = "Thuốc Đã Uống Hôm Nay";
            iconClass = "fa-solid fa-circle-check text-green";
            colorTheme = "#10b981";
        } else if (filterType === 'MISSED') {
            filteredLogs = res.data.filter(log => log.status === 'MISSED');
            title = "Thuốc Bỏ Qua / Trễ";
            iconClass = "fa-solid fa-circle-xmark text-red";
            colorTheme = "#ef4444";
        } else if (filterType === 'PENDING') {
            filteredLogs = res.data.filter(log => log.status === 'PENDING');
            title = "Thuốc Đang Chờ Uống";
            iconClass = "fa-solid fa-clock-rotate-left text-blue";
            colorTheme = "#06b6d4";
        }
        
        document.getElementById('statsModalTitle').textContent = title;
        const iconEl = document.getElementById('statsModalIcon');
        if (iconEl) {
            iconEl.className = iconClass;
            iconEl.style.color = colorTheme;
        }
        
        const modalContent = document.querySelector('#statsDetailsModal .modal-content');
        if (modalContent) {
            modalContent.style.borderColor = colorTheme;
            modalContent.style.boxShadow = `0 0 20px ${colorTheme}50, var(--shadow-main)`;
        }
        
        if (filteredLogs.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-placeholder" style="border: 1px dashed var(--border-color); padding: 20px; text-align: center; color: var(--text-muted); width: 100%;">
                    <i class="fa-solid fa-prescription-bottle"></i>
                    Không có đơn thuốc nào ở trạng thái này.
                </div>
            `;
        } else {
            listContainer.innerHTML = filteredLogs.map(log => {
                let statusBadge = '';
                if (log.status === 'TAKEN') {
                    statusBadge = `<span class="status-pill taken">Đã uống lúc ${log.taken_time}</span>`;
                } else if (log.status === 'MISSED') {
                    statusBadge = `<span class="status-pill missed">Bỏ qua / Trễ</span>`;
                } else {
                    statusBadge = `<span class="status-pill pending">Chờ uống</span>`;
                }
                
                const medColor = log.med_color || '#3b82f6';
                const dateStr = log.remind_date ? `<span class="date-tag" style="margin-left: 8px;"><i class="fa-solid fa-calendar-day"></i> ${formatDate(log.remind_date)}</span>` : `<span class="date-tag daily" style="margin-left: 8px;"><i class="fa-solid fa-repeat"></i> Hàng ngày</span>`;
                
                return `
                    <div class="stats-modal-item">
                        <div class="stats-modal-med-info">
                            <div class="pres-avatar" style="background: ${medColor}15; color: ${medColor};">
                                <i class="fa-solid fa-pills"></i>
                            </div>
                            <div class="stats-modal-med-details">
                                <h5 style="margin: 0; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: white;">
                                    <span style="background-color: ${medColor}; display: inline-block; width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 6px ${medColor};"></span>
                                    ${escapeHTML(log.med_name)}
                                </h5>
                                <p style="margin: 4px 0 0 0; font-size: 12px; color: var(--text-secondary);">
                                    <i class="fa-solid fa-weight-hanging"></i> ${escapeHTML(log.dosage)} &nbsp;&nbsp; 
                                    <i class="fa-solid fa-clock"></i> ${log.scheduled_time}
                                    ${dateStr}
                                </p>
                            </div>
                        </div>
                        <div>
                            ${statusBadge}
                        </div>
                    </div>
                `;
            }).join('');
        }
        
        document.getElementById('statsDetailsModal').classList.remove('hidden');
    } catch (e) {
        console.error("Error showing stats details modal: ", e);
    }
}

function hideStatsModal() {
    const modal = document.getElementById('statsDetailsModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}
