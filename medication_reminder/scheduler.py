import threading
import time
from datetime import datetime
from medication_reminder.database import (
    create_daily_logs_if_needed,
    get_pending_logs_for_scheduler,
    update_log_status,
    get_now
)
from medication_reminder.voice_assistant import VoiceAssistant

class MedicationScheduler(threading.Thread):
    def __init__(self, voice_assistant=None):
        super().__init__()
        self.daemon = True
        self.running = False
        self.assistant = voice_assistant or VoiceAssistant()
        # Keep track of active reminders to prevent overlapping voice prompts
        # Structure: {log_id: {"last_reminded": timestamp, "retries": count, "is_reminding": bool}}
        self.active_reminders = {}
        self.reminders_lock = threading.Lock()
        
        # Callbacks to notify Flask UI
        self.on_reminder_triggered = None
        self.on_reminder_resolved = None

    def run(self):
        self.running = True
        print("Medication Scheduler Thread started.")
        
        while self.running:
            try:
                today_str = get_now().strftime("%Y-%m-%d")
                
                # 1. Automatically generate logs for today if they don't exist
                create_daily_logs_if_needed(today_str)
                
                # 2. Get current time in HH:MM
                current_time_str = get_now().strftime("%H:%M")
                
                # 3. Fetch all pending logs scheduled at or before the current time
                pending_logs = get_pending_logs_for_scheduler(current_time_str, today_str)
                
                for log in pending_logs:
                    log_id = log['log_id']
                    
                    with self.reminders_lock:
                        # Initialize tracking if not present
                        if log_id not in self.active_reminders:
                            self.active_reminders[log_id] = {
                                "last_reminded": 0,
                                "retries": 0,
                                "is_reminding": False,
                                "med_name": log['med_name'],
                                "dosage": log['dosage'],
                                "scheduled_time": log['scheduled_time']
                            }
                        
                        rem_info = self.active_reminders[log_id]
                        
                        # If the reminder is currently actively running (speaking/listening), skip this cycle
                        if rem_info["is_reminding"]:
                            continue
                            
                        time_since_last = time.time() - rem_info["last_reminded"]
                        
                        # Remind every 60 seconds if not yet answered
                        if time_since_last >= 60:
                            rem_info["is_reminding"] = True
                            rem_info["last_reminded"] = time.time()
                            rem_info["retries"] += 1
                            
                            # Trigger the voice workflow in a separate worker thread so the scheduler remains highly responsive
                            threading.Thread(
                                target=self._voice_reminder_workflow,
                                args=(log_id, log),
                                daemon=True
                            ).start()
                            
            except Exception as e:
                print(f"Error in scheduler loop: {e}")
                
            time.sleep(10) # check every 10 seconds

    def _voice_reminder_workflow(self, log_id, log):
        """Asynchronous worker that plays the voice prompt and processes mic response."""
        try:
            med_name = log['med_name']
            dosage = log['dosage']
            
            with self.reminders_lock:
                retries = self.active_reminders[log_id]["retries"]
            
            # Notify Flask dashboard that we started reminding (triggers mic pulse UI animation!)
            if self.on_reminder_triggered:
                self.on_reminder_triggered({
                    "log_id": log_id,
                    "med_name": med_name,
                    "dosage": dosage,
                    "scheduled_time": log['scheduled_time'],
                    "retry_count": retries
                })
            
            # 1. Compose spoken announcement
            if retries == 1:
                speech_text = f"Đã đến giờ uống thuốc rồi ạ. Bạn có lịch uống thuốc {med_name}, liều lượng {dosage}. Bạn đã uống thuốc chưa ạ?"
            else:
                speech_text = f"Nhắc lại lần {retries}. Vui lòng uống thuốc {med_name}, liều lượng {dosage}. Hãy xác nhận đã uống hoặc bỏ qua."
                
            self.assistant.speak(speech_text, block=True)
            
            # 2. Listen to user voice response
            # Pause a tiny bit before listening to ensure voice playback is completely unloaded
            time.sleep(0.3)
            voice_text, error_msg = self.assistant.listen(timeout=6, phrase_time_limit=5)
            
            resolved = False
            status_result = None
            
            if voice_text:
                if self.assistant.is_confirm_taken_command(voice_text):
                    # Confirmed
                    update_log_status(log_id, "TAKEN")
                    self.assistant.speak("Tuyệt vời, tôi đã ghi nhận bạn đã uống thuốc đầy đủ.", block=True)
                    resolved = True
                    status_result = "TAKEN"
                elif self.assistant.is_skip_command(voice_text):
                    # Skipped
                    update_log_status(log_id, "MISSED")
                    self.assistant.speak("Đã ghi nhận bỏ qua liều thuốc này. Hãy cố gắng uống đúng giờ lần sau nhé.", block=True)
                    resolved = True
                    status_result = "MISSED"
                else:
                    # Spoken but not matching expected keywords
                    self.assistant.speak("Tôi chưa hiểu ý bạn. Vui lòng nói Đã uống hoặc Bỏ qua.", block=True)
            else:
                print(f"Speech recognition could not interpret feedback: {error_msg}")
            
            # 3. Check if we need to auto-mark as missed (after 3 failures)
            if not resolved:
                if retries >= 3:
                    # Too many attempts, mark as missed
                    update_log_status(log_id, "MISSED")
                    self.assistant.speak(f"Đã hết lượt nhắc nhở. Tôi sẽ ghi nhận liều thuốc {med_name} là chưa uống.", block=True)
                    resolved = True
                    status_result = "MISSED"
            
            # Clean up or update reminder tracking
            with self.reminders_lock:
                if resolved:
                    # Remove from active tracking since it's now updated in the DB
                    if log_id in self.active_reminders:
                        del self.active_reminders[log_id]
                    
                    # Notify UI that reminder is resolved
                    if self.on_reminder_resolved:
                        self.on_reminder_resolved(log_id, status_result)
                else:
                    # Mark active state as False so it can be picked up for retry in the next scheduler cycle
                    if log_id in self.active_reminders:
                        self.active_reminders[log_id]["is_reminding"] = False
                        
        except Exception as e:
            print(f"Error in voice reminder workflow for log {log_id}: {e}")
            with self.reminders_lock:
                if log_id in self.active_reminders:
                    self.active_reminders[log_id]["is_reminding"] = False

    def stop(self):
        """Gracefully stops the scheduler thread."""
        self.running = False
        print("Medication Scheduler stopping...")

    def resolve_reminder_externally(self, log_id, status):
        """Called by Flask API when a reminder is resolved via UI or browser voice."""
        update_log_status(log_id, status)
        with self.reminders_lock:
            if log_id in self.active_reminders:
                del self.active_reminders[log_id]
        if self.on_reminder_resolved:
            self.on_reminder_resolved(log_id, status)
