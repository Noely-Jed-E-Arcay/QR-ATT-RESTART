import { supabase } from './supabase';
import * as SQLite from 'expo-sqlite';

export type AttendanceRecord = {
  id: string;
  eventId: string;
  eventTitle: string;
  scannedAt: string;
};

type EventPayload = {
  v: number;       // version 1 = our QR format
  event: string;   // the event code (e.g. EVT-2026-0002)
  title?: string;  // optional title
  start?: string;  // optional start time
  end?: string;    // optional end time
};

export type RegisterResult = {
  success: boolean;     // did it work?
  message: string;      // what to tell the user
  eventTitle?: string;  // optional event name for the message
};

let db: SQLite.SQLiteDatabase | null = null;

async function getDb() {
  if (!db) {
    db = await SQLite.openDatabaseAsync('qr-attendance.db');
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        eventId TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studentId TEXT NOT NULL,
        eventId TEXT NOT NULL,
        scannedAt TEXT NOT NULL,
        UNIQUE (studentId, eventId)
      );
    `);
  }
  return db;
}

export async function registerAttendance(
  rawPayload: string,
  studentId: string
): Promise<RegisterResult> {
  let payload: EventPayload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return { success: false, message: 'Invalid QR code.' };
  }

  if (payload.v !== 1 || !payload.event) {
    return { success: false, message: 'Not an attendance QR code.' };
  }

  const now = Date.now();
  const start = payload.start ? new Date(payload.start).getTime() : null;
  const end = payload.end ? new Date(payload.end).getTime() : null;

  if (start && now < start) {
    return { success: false, message: 'Event has not started yet.' };
  }
  if (end && now > end) {
    return { success: false, message: 'Event has already ended.' };
  }

  const database = await getDb();
  const title = payload.title ?? payload.event;

let event: { id: string; title: string } | null = null;

const { data: foundEvent, error: findError } = await supabase
  .from('events')
  .select('id, title')
  .eq('event_code', payload.event)
  .maybeSingle();

if (findError) {
  return { success: false, message: 'Could not check event.' };
}

if (foundEvent) {
  event = foundEvent;
} else {
  const { data: newEvent, error: insertError } = await supabase
    .from('events')
    .insert([
      {
        event_code: payload.event,
        title,
        start_time: payload.start ?? null,
        end_time: payload.end ?? null,
      },
    ])
    .select('id, title')
    .single();

  if (insertError) {
    return { success: false, message: 'Could not create event.' };
  }
  event = newEvent;
}

const { error: attError } = await supabase.from('attendance').insert([
  {
    student_id: studentId,
    event_id: event.id,
  },
]);

if (attError) {
  if (attError.code === '23505') {
    return {
      success: false,
      message: 'Already registered for this event.',
      eventTitle: event.title,
    };
  }
  return { success: false, message: attError.message };
}

return { success: true, message: 'Attendance recorded!', eventTitle: event.title };


  await database.runAsync(
    'INSERT OR IGNORE INTO events (eventId, title, start, end) VALUES (?, ?, ?, ?)',
    payload.event,
    title,
    payload.start ?? '',
    payload.end ?? ''
  );

  const result = await database.runAsync(
    'INSERT OR IGNORE INTO attendance (studentId, eventId, scannedAt) VALUES (?, ?, ?)',
    studentId,
    payload.event,
    new Date().toISOString()
  );

  if (result.changes === 0) {
    return {
      success: false,
      message: 'Already registered for this event.',
      eventTitle: title,
    };
  }

  return { success: true, message: 'Attendance recorded!', eventTitle: title };
}

export async function getAttendanceHistory(
  studentId: string
): Promise<AttendanceRecord[]> {
  const { data, error } = await supabase
    .from('attendance')
    .select('id, scanned_at, events ( event_code, title )')
    .eq('student_id', studentId)
    .order('scanned_at', { ascending: false });

  if (error || !data) {
    return [];
  }

  return data.map((row: any) => ({
    id: row.id,
    eventId: row.events?.event_code ?? '',
    eventTitle: row.events?.title ?? '',
    scannedAt: row.scanned_at,
  }));
}

