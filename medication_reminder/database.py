import sqlite3
import os
from datetime import datetime, timedelta

# User PC clock is 5 minutes slow (e.g. 8:56 vs 9:01), so we add a global 5-minute offset to the entire system!
SYSTEM_TIME_OFFSET_MINUTES = 5

def get_now():
    """Returns the current date and time adjusted by the system offset."""
    return datetime.now() + timedelta(minutes=SYSTEM_TIME_OFFSET_MINUTES)

DB_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(DB_DIR, "medication_reminder.db")

def get_connection():
    """Returns a connection to the SQLite database with row factory enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initializes the database schema if it doesn't exist."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = get_connection()
    cursor = conn.cursor()
    
    # Create prescriptions table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS prescriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            med_name TEXT NOT NULL,
            dosage TEXT NOT NULL,
            remind_date TEXT,          -- Format: "YYYY-MM-DD" or NULL (daily)
            remind_time TEXT NOT NULL, -- Format: "HH:MM" (e.g. "08:00")
            active INTEGER DEFAULT 1,  -- 1 = Active, 0 = Inactive
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Migrate table to add remind_date if existing database doesn't have it
    cursor.execute("PRAGMA table_info(prescriptions)")
    columns = [col['name'] for col in cursor.fetchall()]
    if 'remind_date' not in columns:
        cursor.execute("ALTER TABLE prescriptions ADD COLUMN remind_date TEXT")
    
    # Create medication_logs table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS medication_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prescription_id INTEGER NOT NULL,
            scheduled_time TEXT NOT NULL, -- Format: "HH:MM"
            status TEXT NOT NULL,         -- "PENDING", "TAKEN", "MISSED"
            taken_time TEXT,             -- Format: "HH:MM:SS" or NULL
            date TEXT NOT NULL,           -- Format: "YYYY-MM-DD"
            FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE
        )
    """)
    
    conn.commit()
    conn.close()
    print(f"Database initialized successfully at {DB_PATH}")

def add_prescription(med_name, dosage, remind_time, remind_date=None):
    """Adds a new prescription to the database and generates today's log entry if active and date matches."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Standardize empty/whitespace dates to None
    if remind_date and not remind_date.strip():
        remind_date = None
        
    cursor.execute(
        "INSERT INTO prescriptions (med_name, dosage, remind_time, remind_date) VALUES (?, ?, ?, ?)",
        (med_name, dosage, remind_time, remind_date)
    )
    pres_id = cursor.lastrowid
    conn.commit()
    
    # Generate today's log for this prescription if active and remind_date is empty OR matches today
    today_str = datetime.now().strftime("%Y-%m-%d")
    if not remind_date or remind_date == today_str:
        cursor.execute(
            "INSERT INTO medication_logs (prescription_id, scheduled_time, status, date) VALUES (?, ?, ?, ?)",
            (pres_id, remind_time, "PENDING", today_str)
        )
        conn.commit()
    conn.close()
    return pres_id

def delete_prescription(pres_id):
    """Deletes a prescription and its associated logs."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM medication_logs WHERE prescription_id = ?", (pres_id,))
    cursor.execute("DELETE FROM prescriptions WHERE id = ?", (pres_id,))
    conn.commit()
    conn.close()

def get_all_prescriptions():
    """Retrieves all prescriptions."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM prescriptions ORDER BY remind_date DESC, remind_time ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_active_prescriptions():
    """Retrieves only active prescriptions."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM prescriptions WHERE active = 1 ORDER BY remind_date DESC, remind_time ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def create_daily_logs_if_needed(date_str=None):
    """Generates PENDING logs for active prescriptions for the specified date if they don't exist."""
    if date_str is None:
        date_str = get_now().strftime("%Y-%m-%d")
        
    conn = get_connection()
    cursor = conn.cursor()
    
    # Retrieve active prescriptions that are either daily (remind_date IS NULL/empty) OR match date_str
    cursor.execute("""
        SELECT * FROM prescriptions 
        WHERE active = 1 AND (remind_date IS NULL OR remind_date = '' OR remind_date = ?)
    """, (date_str,))
    active_pres = [dict(row) for row in cursor.fetchall()]
    
    did_insert = False
    for pres in active_pres:
        # Check if a log already exists for this individual prescription on this date
        cursor.execute(
            "SELECT COUNT(*) as count FROM medication_logs WHERE prescription_id = ? AND date = ?",
            (pres['id'], date_str)
        )
        has_log = cursor.fetchone()['count'] > 0
        
        if not has_log:
            cursor.execute(
                "INSERT INTO medication_logs (prescription_id, scheduled_time, status, date) VALUES (?, ?, ?, ?)",
                (pres['id'], pres['remind_time'], "PENDING", date_str)
            )
            did_insert = True
            print(f"Generated new pending log for {pres['med_name']} on {date_str}.")
            
    if did_insert:
        conn.commit()
        
    conn.close()

def get_logs_by_date(date_str):
    """Retrieves medication logs for a specific date joined with prescription info."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            l.id as log_id, 
            l.scheduled_time, 
            l.status, 
            l.taken_time, 
            l.date, 
            p.id as prescription_id,
            p.med_name, 
            p.dosage,
            p.remind_date
        FROM medication_logs l
        JOIN prescriptions p ON l.prescription_id = p.id
        WHERE l.date = ?
        ORDER BY l.scheduled_time ASC
    """, (date_str,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def update_log_status(log_id, status, taken_time=None):
    """Updates the compliance status of a medication log."""
    conn = get_connection()
    cursor = conn.cursor()
    if taken_time is None and status == "TAKEN":
        taken_time = get_now().strftime("%H:%M:%S")
        
    cursor.execute(
        "UPDATE medication_logs SET status = ?, taken_time = ? WHERE id = ?",
        (status, taken_time, log_id)
    )
    conn.commit()
    conn.close()

def get_pending_logs_for_scheduler(current_time_str, date_str):
    """Retrieves PENDING logs scheduled at or before the current time."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            l.id as log_id, 
            l.scheduled_time, 
            l.status, 
            p.id as prescription_id,
            p.med_name, 
            p.dosage 
        FROM medication_logs l
        JOIN prescriptions p ON l.prescription_id = p.id
        WHERE l.date = ? AND l.status = 'PENDING' AND l.scheduled_time <= ?
    """, (date_str, current_time_str))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_compliance_stats():
    """Calculates overall adherence statistics (taken, missed, pending count)."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT status, COUNT(*) as count FROM medication_logs GROUP BY status")
    rows = cursor.fetchall()
    conn.close()
    
    stats = {"TAKEN": 0, "MISSED": 0, "PENDING": 0}
    for row in rows:
        if row['status'] in stats:
            stats[row['status']] = row['count']
            
    total = sum(stats.values())
    stats['compliance_rate'] = (stats['TAKEN'] / (stats['TAKEN'] + stats['MISSED']) * 100) if (stats['TAKEN'] + stats['MISSED']) > 0 else 100.0
    stats['total'] = total
    return stats
