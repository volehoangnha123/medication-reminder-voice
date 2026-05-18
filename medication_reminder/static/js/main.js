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
            return `
            <div class="prescription-item" id="pres-item-${p.id}">
                <div class="pres-info">
                    <div class="pres-avatar"><i class="fa-solid fa-pills"></i></div>
                    <div class="pres-details">
                        <h5>${escapeHTML(p.med_name)}</h5>
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
        
        if (!res.success || res.data.length === 0) {
            container.innerHTML = `
                <div class="empty-placeholder">
                    <i class="fa-solid fa-calendar-xmark text-muted"></i>
                    Không có lịch nhắc thuốc nào hôm nay.
                </div>
            `;
            return;
        }
        
        container.innerHTML = res.data.map(log => {
            let statusClass = 'pending';
            let statusPillText = 'Chờ uống';
            let takenTimeInfo = '';
            
            if (log.status === 'TAKEN') {
                statusClass = 'taken';
                statusPillText = 'Đã uống';
                takenTimeInfo = `<span class="taken-time-tag"><i class="fa-solid fa-circle-check"></i> Đã uống lúc: ${log.taken_time}</span>`;
            } else if (log.status === 'MISSED') {
                statusClass = 'missed';
                statusPillText = 'Bỏ qua';
            }
            
            const dateStr = log.remind_date ? `<span class="date-tag"><i class="fa-solid fa-calendar-day"></i> ${formatDate(log.remind_date)}</span>` : `<span class="date-tag daily"><i class="fa-solid fa-repeat"></i> Hàng ngày</span>`;
            
            return `
                <div class="timeline-item ${statusClass}" id="log-item-${log.log_id}">
                    <div class="timeline-node"></div>
                    <div class="timeline-body">
                        <div class="timeline-info">
                            <div class="timeline-time">${log.scheduled_time}</div>
                            <div class="timeline-med-details">
                                <h5>${escapeHTML(log.med_name)}</h5>
                                <p><i class="fa-solid fa-pills"></i> ${escapeHTML(log.dosage)} &nbsp;&nbsp; ${dateStr} &nbsp;&nbsp; ${takenTimeInfo}</p>
                            </div>
                        </div>
                        <div class="timeline-actions">
                            ${log.status === 'PENDING' ? `
                                <button onclick="updateLogStatus(${log.log_id}, 'TAKEN')" class="btn-circle check" title="Xác nhận đã uống">
                                    <i class="fa-solid fa-check"></i>
                                </button>
                                <button onclick="updateLogStatus(${log.log_id}, 'MISSED')" class="btn-circle skip" title="Đánh dấu bỏ qua">
                                    <i class="fa-solid fa-xmark"></i>
                                </button>
                            ` : `
                                <span class="status-pill ${statusClass}">${statusPillText}</span>
                            `}
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
    
    if (!medName || !remindTime) return;
    
    try {
        const response = await fetch('/api/prescriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ med_name: medName, dosage: dosage, remind_time: remindTime, remind_date: remindDate })
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
