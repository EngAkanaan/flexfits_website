// Supabase client configuration
import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://craqgdlbluzlxvczvzrs.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNyYXFnZGxibHV6bHh2Y3p2enJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAxNTc2MDUsImV4cCI6MjA3NTczMzYwNX0.MW8qZusWSA79OlhCi3jvFpF8Eaq7N_epaQRwTcvMSCw';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials not configured. Using localStorage fallback.');
}

export const supabase = supabaseUrl && supabaseAnonKey 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

