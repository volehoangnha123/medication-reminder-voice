import queue
import time
# pyrefly: ignore [missing-import]
from flask import Flask, render_template, jsonify, request, Response
from datetime import datetime

from medication_reminder.database import (
    init_db,
    add_prescription,
    delete_prescription,
    get_all_prescriptions,
    get_logs_by_date,
    update_log_status,
    get_compliance_stats,
    create_daily_logs_if_needed,
    get_now
)
from medication_reminder.voice_assistant import VoiceAssistant
from medication_reminder.scheduler import MedicationScheduler

app = Flask(__name__)

# Thread-safe queue for SSE notifications to the frontend UI
event_queue = queue.Queue()

# Instantiate core components
assistant = VoiceAssistant()
scheduler = MedicationScheduler(voice_assistant=assistant)

# In-memory session log to show voice transcription history on the UI
voice_chat_history = []

def add_chat_history(speaker, text):
    """Utility to log conversations for UI visualization."""
    timestamp = get_now().strftime("%H:%M:%S")
    voice_chat_history.append({
        "timestamp": timestamp,
        "speaker": speaker, # "assistant" or "user" or "system"
        "text": text
    })
    # Keep last 50 logs
    if len(voice_chat_history) > 50:
        voice_chat_history.pop(0)

# Configure scheduler callbacks
def on_reminder_triggered_callback(data):
    """Triggered when scheduler initiates a vocal prompt."""
    event_data = {
        "type": "reminder_triggered",
        "log_id": data["log_id"],
        "med_name": data["med_name"],
        "dosage": data["dosage"],
        "scheduled_time": data["scheduled_time"],
        "retry_count": data["retry_count"]
    }
    event_queue.put(event_data)
    add_chat_history("assistant", f"Đã đến giờ uống thuốc: {data['med_name']} ({data['dosage']}). Đang lắng nghe phản hồi...")

def on_reminder_resolved_callback(log_id, status):
    """Triggered when scheduler gets a response and updates status."""
    event_data = {
        "type": "reminder_resolved",
        "log_id": log_id,
        "status": status
    }
    event_queue.put(event_data)
    status_text = "Đã uống" if status == "TAKEN" else "Bỏ qua"
    add_chat_history("system", f"Lời nhắc ID {log_id} đã được xác nhận: {status_text}")

scheduler.on_reminder_triggered = on_reminder_triggered_callback
scheduler.on_reminder_resolved = on_reminder_resolved_callback

@app.route('/')
def index():
    """Renders the main dashboard page."""
    return render_template('index.html')

@app.route('/api/prescriptions', methods=['GET'])
def list_prescriptions_api():
    """Returns a list of all active prescriptions."""
    try:
        prescriptions = get_all_prescriptions()
        return jsonify({"success": True, "data": prescriptions})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/prescriptions', methods=['POST'])
def add_prescription_api():
    """Endpoint to add a new prescription manually via form."""
    try:
        data = request.get_json()
        med_name = data.get('med_name')
        dosage = data.get('dosage', '1 viên')
        remind_time = data.get('remind_time')
        remind_date = data.get('remind_date')
        
        if not med_name or not remind_time:
            return jsonify({"success": False, "message": "Thiếu tên thuốc hoặc giờ nhắc."}), 400
            
        # Basic HH:MM validation
        try:
            datetime.strptime(remind_time, "%H:%M")
        except ValueError:
            return jsonify({"success": False, "message": "Định dạng giờ nhắc không hợp lệ (HH:MM)."}), 400
            
        # Basic YYYY-MM-DD validation if provided
        if remind_date and remind_date.strip():
            try:
                datetime.strptime(remind_date, "%Y-%m-%d")
            except ValueError:
                return jsonify({"success": False, "message": "Định dạng ngày nhắc không hợp lệ (YYYY-MM-DD)."}), 400
        else:
            remind_date = None
            
        pres_id = add_prescription(med_name, dosage, remind_time, remind_date)
        
        date_desc = f" ngày {remind_date}" if remind_date else " hàng ngày"
        msg = f"Đã thêm đơn thuốc: {med_name} ({dosage}) vào lúc {remind_time}{date_desc}"
        add_chat_history("system", msg)
        assistant.speak(f"Đã thêm lịch nhắc thuốc {med_name} lúc {remind_time}{date_desc} thành công.", block=False)
        
        # Trigger an SSE update to refresh today's list
        event_queue.put({"type": "data_changed"})
        
        return jsonify({"success": True, "prescription_id": pres_id, "message": msg})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/prescriptions/<int:pres_id>', methods=['DELETE'])
def delete_prescription_api(pres_id):
    """Deletes a prescription."""
    try:
        delete_prescription(pres_id)
        msg = f"Đã xóa đơn thuốc ID: {pres_id}"
        add_chat_history("system", msg)
        
        # Trigger SSE update
        event_queue.put({"type": "data_changed"})
        return jsonify({"success": True, "message": msg})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/logs', methods=['GET'])
def get_logs_api():
    """Retrieves compliance logs for today."""
    try:
        today_str = get_now().strftime("%Y-%m-%d")
        create_daily_logs_if_needed(today_str)
        logs = get_logs_by_date(today_str)
        return jsonify({"success": True, "data": logs, "date": today_str})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/logs/<int:log_id>/status', methods=['POST'])
def update_log_status_api(log_id):
    """Allows manual override of medication compliance status via buttons on dashboard."""
    try:
        data = request.get_json()
        status = data.get('status')
        if status not in ['TAKEN', 'MISSED', 'PENDING']:
            return jsonify({"success": False, "message": "Trạng thái không hợp lệ."}), 400
            
        update_log_status(log_id, status)
        msg = f"Đã cập nhật trạng thái lịch uống thuốc sang: {status}"
        add_chat_history("system", msg)
        
        if status == 'TAKEN':
            assistant.speak("Đã xác nhận đã uống thuốc.", block=False)
        else:
            assistant.speak("Đã đánh dấu bỏ qua thuốc.", block=False)
            
        # Trigger SSE update
        event_queue.put({"type": "data_changed"})
        return jsonify({"success": True, "message": msg})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/voice/trigger', methods=['POST'])
def trigger_voice_command():
    """
    Manually activates the room microphone to listen for a voice command.
    Can be used to:
    1. Add a new prescription, e.g.: "Thêm thuốc Paracetamol lúc 8 giờ sáng"
    2. Confirm a pending medication, e.g.: "Đã uống" or "Bỏ qua"
    """
    try:
        add_chat_history("system", "Hệ thống đang mở microphone lắng nghe...")
        event_queue.put({"type": "mic_listening"})
        
        # Actively listen to microphone
        voice_text, error_msg = assistant.listen(timeout=6, phrase_time_limit=6)
        
        event_queue.put({"type": "mic_stopped"})
        
        if not voice_text:
            add_chat_history("assistant", f"Lỗi thu âm: {error_msg}")
            assistant.speak("Tôi chưa nhận được giọng nói. Xin bạn vui lòng thử lại.", block=False)
            return jsonify({"success": False, "message": error_msg})
            
        add_chat_history("user", voice_text)
        
        # 1. Check if it's an "add prescription" command
        parsed = assistant.parse_add_prescription_command(voice_text)
        if parsed:
            med_name, dosage, remind_time, remind_date = parsed
            pres_id = add_prescription(med_name, dosage, remind_time, remind_date)
            date_desc = f" ngày {remind_date}" if remind_date else " hàng ngày"
            msg = f"Thành công! Đã thêm lịch nhắc: thuốc {med_name}, liều lượng {dosage}, lúc {remind_time}{date_desc}."
            add_chat_history("assistant", msg)
            assistant.speak(msg, block=False)
            event_queue.put({"type": "data_changed"})
            return jsonify({"success": True, "command_type": "add_prescription", "text": voice_text, "result": msg})
            
        # 2. Check if it is a confirmation command for any currently active reminders
        # We can look up active reminders or if none, find the earliest PENDING log for today
        today_str = get_now().strftime("%Y-%m-%d")
        logs = get_logs_by_date(today_str)
        pending_logs = [l for l in logs if l['status'] == 'PENDING']
        
        if pending_logs:
            # Pick the earliest pending log
            earliest_log = pending_logs[0]
            log_id = earliest_log['log_id']
            med_name = earliest_log['med_name']
            
            if assistant.is_confirm_taken_command(voice_text):
                update_log_status(log_id, "TAKEN")
                msg = f"Đã ghi nhận bạn đã uống thuốc {med_name} thành công."
                add_chat_history("assistant", msg)
                assistant.speak(msg, block=False)
                event_queue.put({"type": "data_changed"})
                return jsonify({"success": True, "command_type": "confirm_taken", "text": voice_text, "result": msg})
                
            elif assistant.is_skip_command(voice_text):
                update_log_status(log_id, "MISSED")
                msg = f"Đã ghi nhận bỏ qua thuốc {med_name}."
                add_chat_history("assistant", msg)
                assistant.speak(msg, block=False)
                event_queue.put({"type": "data_changed"})
                return jsonify({"success": True, "command_type": "skip", "text": voice_text, "result": msg})
                
        # 3. If command not recognized
        msg = "Tôi đã nghe được giọng nói của bạn, nhưng chưa rõ yêu cầu. Bạn hãy nói rõ hơn nhé, ví dụ: Thêm thuốc Paracetamol lúc mười hai giờ."
        add_chat_history("assistant", msg)
        assistant.speak(msg, block=False)
        return jsonify({"success": False, "message": "Command not recognized", "text": voice_text})
        
    except Exception as e:
        add_chat_history("system", f"Có lỗi xảy ra: {str(e)}")
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/stats', methods=['GET'])
def get_stats_api():
    """Retrieves overall adherence metrics."""
    try:
        stats = get_compliance_stats()
        return jsonify({"success": True, "data": stats})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/chat/history', methods=['GET'])
def get_chat_history_api():
    """Returns conversation logs for the visualizer."""
    return jsonify({"success": True, "data": voice_chat_history})

@app.route('/api/events')
def events_stream():
    """SSE endpoint providing real-time notifications to the client dashboard."""
    def generate():
        while True:
            # Yield active keep-alive comments to prevent connection drop
            try:
                # Wait for an event with a timeout of 15 seconds
                event_data = event_queue.get(timeout=15.0)
                yield f"data: {json_stringify(event_data)}\n\n"
            except queue.Empty:
                yield ": keep-alive\n\n"
            except GeneratorExit:
                break
            except Exception as e:
                print(f"SSE Error: {e}")
                break
                
    return Response(generate(), mimetype='text/event-stream')

def json_stringify(obj):
    import json
    return json.dumps(obj)

if __name__ == '__main__':
    # Initialize the database file
    init_db()
    
    # Initialize chat history with first welcome message
    add_chat_history("assistant", "Xin chào! Tôi là Trợ lý nhắc thuốc thông minh của bạn. Hãy thiết lập đơn thuốc và bắt đầu nhé.")
    
    # Start background scheduler thread
    scheduler.start()
    
    # Run the web server
    print("Launching Flask Server on http://127.0.0.1:5000")
    app.run(debug=False, host='127.0.0.1', port=5000)
