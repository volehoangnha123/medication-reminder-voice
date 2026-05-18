import os
import sys

# Reconfigure stdout/stderr to utf-8 to prevent encoding crashes on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        pass

# Add the current directory to sys.path so we can import the package easily
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from medication_reminder.app import app, init_db, scheduler
except ImportError as e:
    print("\n[LỖI] Không thể tìm thấy hoặc import các module. Vui lòng cài đặt các thư viện cần thiết bằng lệnh:")
    print("pip install -r medication_reminder/requirements.txt")
    print(f"\nChi tiết lỗi: {e}")
    sys.exit(1)

if __name__ == '__main__':
    print("=" * 60)
    print("           TRỢ LÝ NHẮC THUỐC THÔNG MINH (MEDI-VOICE)")
    print("=" * 60)
    print(" Đang khởi tạo cơ sở dữ liệu...")
    init_db()
    
    print(" Đang kích hoạt tiến trình lập lịch ngầm (Scheduler Thread)...")
    scheduler.start()
    
    print("\n Khởi chạy Web Dashboard tại: http://127.0.0.1:5000")
    print(" Vui lòng mở trình duyệt và truy cập địa chỉ trên.")
    print(" Nhấp vào biểu tượng Microphone trên giao diện để ra lệnh bằng giọng nói!")
    print("=" * 60)
    
    try:
        app.run(debug=False, host='127.0.0.1', port=5000)
    except KeyboardInterrupt:
        print("\n Đang dừng tiến trình hệ thống...")
        scheduler.stop()
        print(" Đã thoát chương trình.")
