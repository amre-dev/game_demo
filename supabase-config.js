const SUPABASE_URL = "https://bwwoizcwywovpgxxdchu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3d29pemN3eXdvdnBneHhkY2h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNjg4NzUsImV4cCI6MjEwNzg0NDg3NX0.0P2PK6c1NI2vtmsstYRkc-zIEsGoOX3AYyRWrs8c_3E";

if (!window.supabase) {
  throw new Error("Supabase client library failed to load.");
}
if (SUPABASE_URL.includes("YOUR_PROJECT_REF") || SUPABASE_ANON_KEY.includes("YOUR_")) {
  throw new Error("Set the Supabase project URL and publishable/anon key in supabase-config.js.");
}

window.sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
