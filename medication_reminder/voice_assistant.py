import os
import time
import re
import threading
from datetime import datetime

# Optional imports with robust fallbacks
try:
    # pyrefly: ignore [missing-import]
    from gtts import gTTS
    HAS_GTTS = True
except ImportError:
    HAS_GTTS = False

try:
    # pyrefly: ignore [missing-import]
    import pygame
    HAS_PYGAME = True
except ImportError:
    HAS_PYGAME = False

try:
    # pyrefly: ignore [missing-import]
    import pyttsx3
    HAS_PYTTSX3 = True
except ImportError:
    HAS_PYTTSX3 = False

try:
    # pyrefly: ignore [missing-import]
    import speech_recognition as sr
    HAS_SR = True
except ImportError:
    HAS_SR = False

class VoiceAssistant:
    def __init__(self):
        self.tts_lock = threading.Lock()
        
        # Initialize pyttsx3 engine as offline fallback
        self.offline_engine = None
        if HAS_PYTTSX3:
            try:
                self.offline_engine = pyttsx3.init()
                self.offline_engine.setProperty('rate', 160)  # Moderate speed
                # Try to set Vietnamese voice if available
                voices = self.offline_engine.getProperty('voices')
                for voice in voices:
                    # Safely extract languages and name
                    langs = getattr(voice, 'languages', [])
                    voice_name = getattr(voice, 'name', '').lower()
                    voice_id = getattr(voice, 'id', '').lower()
                    
                    is_vi = False
                    if langs and any('vi' in str(l).lower() for l in langs):
                        is_vi = True
                    elif 'vietnamese' in voice_name or 'vi-vn' in voice_id or 'vietnam' in voice_name:
                        is_vi = True
                        
                    if is_vi:
                        self.offline_engine.setProperty('voice', voice.id)
                        break
            except Exception as e:
                print(f"Error initializing pyttsx3 offline engine: {e}")
                self.offline_engine = None

        if HAS_PYGAME:
            try:
                pygame.mixer.init()
            except Exception as e:
                print(f"Error initializing pygame mixer: {e}")

    def speak(self, text, block=True):
        """Speaks the text in Vietnamese, using online gTTS if available, fallback to pyttsx3."""
        print(f"Assistant speaking: {text}")
        
        def run_speak():
            with self.tts_lock:
                success = False
                
                # Attempt gTTS (high quality natural Vietnamese)
                if HAS_GTTS:
                    try:
                        # Ensure static audio folder exists
                        temp_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "audio")
                        os.makedirs(temp_dir, exist_ok=True)
                        temp_file = os.path.join(temp_dir, f"speech_{int(time.time())}.mp3")
                        
                        tts = gTTS(text=text, lang='vi')
                        tts.save(temp_file)
                        
                        played = False
                        
                        # 1. Try PyGame if available
                        if HAS_PYGAME:
                            try:
                                pygame.mixer.music.load(temp_file)
                                pygame.mixer.music.play()
                                while pygame.mixer.music.get_busy():
                                    time.sleep(0.1)
                                pygame.mixer.music.unload()
                                played = True
                            except Exception as pe:
                                print(f"Pygame playback failed, trying PowerShell: {pe}")
                        
                        # 2. Try Native Windows PowerShell MediaPlayer (PresentationCore)
                        if not played and os.name == 'nt':
                            try:
                                # Convert path to absolute with standard backslashes for PowerShell
                                abs_path = os.path.abspath(temp_file).replace('/', '\\')
                                # Shell command using System.Windows.Media.MediaPlayer to play MP3 natively
                                cmd = (
                                    f'powershell -c "Add-Type -AssemblyName PresentationCore; '
                                    f'$player = New-Object System.Windows.Media.MediaPlayer; '
                                    f'$player.Open(\'{abs_path}\'); '
                                    f'$player.Play(); '
                                    f'while ($player.NaturalDuration.HasTimeSpan -eq $false) {{ Start-Sleep -Milliseconds 100 }}; '
                                    f'Start-Sleep -Milliseconds ($player.NaturalDuration.TimeSpan.TotalMilliseconds + 250)"'
                                )
                                os.system(cmd)
                                played = True
                            except Exception as pse:
                                print(f"Native Windows PowerShell playback failed: {pse}")
                                
                        if played:
                            success = True
                            
                        # Clean up temp file
                        try:
                            os.remove(temp_file)
                        except:
                            pass
                    except Exception as e:
                        print(f"gTTS error, trying offline TTS: {e}")
                
                # Attempt offline pyttsx3 fallback
                if not success and self.offline_engine:
                    try:
                        self.offline_engine.say(text)
                        self.offline_engine.runAndWait()
                        success = True
                    except Exception as e:
                        print(f"Offline TTS fallback failed: {e}")
                
                if not success:
                    print(f"[AUDIO OUTPUT ERROR] Could not speak aloud. Text was: '{text}'")

        if block:
            run_speak()
        else:
            threading.Thread(target=run_speak, daemon=True).start()

    def listen(self, timeout=6, phrase_time_limit=6):
        """Listens to the microphone and returns recognized Vietnamese text."""
        if not HAS_SR:
            print("SpeechRecognition library is not installed.")
            return None, "Thư viện SpeechRecognition chưa được cài đặt."

        r = sr.Recognizer()
        r.energy_threshold = 300  # Adjust for background noise
        r.dynamic_energy_threshold = True

        with sr.Microphone() as source:
            print("Listening...")
            r.adjust_for_ambient_noise(source, duration=0.8)
            try:
                audio = r.listen(source, timeout=timeout, phrase_time_limit=phrase_time_limit)
                print("Analyzing speech...")
                text = r.recognize_google(audio, language="vi-VN")
                print(f"Recognized: {text}")
                return text.lower(), None
            except sr.WaitTimeoutError:
                print("Listening timed out.")
                return None, "Hết thời gian chờ. Không phát hiện giọng nói."
            except sr.UnknownValueError:
                print("Google Speech Recognition could not understand audio.")
                return None, "Không thể nhận diện được giọng nói của bạn."
            except sr.RequestError as e:
                print(f"Could not request results from Google Speech Recognition service; {e}")
                return None, "Lỗi kết nối với dịch vụ nhận diện giọng nói Google."
            except Exception as e:
                print(f"Mic error: {e}")
                return None, f"Lỗi Microphone: {e}. Vui lòng kiểm tra lại thiết bị thu âm."

    def parse_add_prescription_command(self, text):
        """
        Parses a voice command to add a prescription.
        Expected formats:
        - "thêm thuốc [tên thuốc] uống lúc [giờ] giờ [phút] ngày [ngày] tháng [tháng]"
        - "nhắc uống [tên thuốc] vào lúc [giờ] giờ ngày [ngày]/[tháng]"
        Returns: (med_name, dosage, remind_time, remind_date) or None
        """
        # Lowercase normalize
        text = text.lower()
        
        # 1. Parse Time & Medication Name first
        match = re.search(r'thuốc\s+(.*?)\s+(?:uống\s+)?lúc\s+(\d{1,2})\s*giờ\s*(?:(\d{1,2})\s*(?:phút)?)?', text)
        
        if match:
            med_name = match.group(1).strip()
            # Clean up med name connector words
            for word in ["uống", "ngày", "vào"]:
                med_name = med_name.replace(word, "").strip()
            med_name = med_name.title()
            
            hours = int(match.group(2))
            minutes = int(match.group(3)) if match.group(3) else 0
            
            # Clamp hours/minutes
            hours = max(0, min(23, hours))
            minutes = max(0, min(59, minutes))
            remind_time = f"{hours:02d}:{minutes:02d}"
            
            # 2. Parse Date
            remind_date = None
            
            # Check for: "ngày 20 tháng 5 năm 2026" or "ngày 20 tháng 5"
            date_match = re.search(r'ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?', text)
            if date_match:
                day = int(date_match.group(1))
                month = int(date_match.group(2))
                year = int(date_match.group(3)) if date_match.group(3) else datetime.now().year
                remind_date = f"{year:04d}-{month:02d}-{day:02d}"
            else:
                # Check for: "ngày 20/05/2026" or "ngày 20-5"
                date_match_2 = re.search(r'ngày\s+(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?', text)
                if date_match_2:
                    day = int(date_match_2.group(1))
                    month = int(date_match_2.group(2))
                    year_val = date_match_2.group(3)
                    if year_val:
                        year = int(year_val)
                        if year < 100:
                            year += 2000
                    else:
                        year = datetime.now().year
                    remind_date = f"{year:04d}-{month:02d}-{day:02d}"
                    
            # Default to today's date if no date is specified to satisfy the date reminder requirement
            if not remind_date:
                remind_date = datetime.now().strftime("%Y-%m-%d")
                
            dosage = "1 viên"
            return med_name, dosage, remind_time, remind_date
        
        return None

    def is_confirm_taken_command(self, text):
        """Checks if the user confirmed taking the medication."""
        keywords = ["đã uống", "uống rồi", "rồi", "ok", "xong", "xác nhận", "da uong", "uong roi", "yes", "confirm"]
        return any(kw in text.lower() for kw in keywords)

    def is_skip_command(self, text):
        """Checks if the user skipped the medication."""
        keywords = ["bỏ qua", "không uống", "chưa", "bo qua", "skip", "no"]
        return any(kw in text.lower() for kw in keywords)
