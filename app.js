/* =========================================================
   ORTAK DÜNYA VERİTABANI — SUPABASE
   Tüm kullanıcılar aynı çiftlik durumunu paylaşır.
========================================================= */
const SUPABASE_URL = "https://xzkizeuaruuyagxgtwry.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6a2l6ZXVhcnV1eWFneGd0d3J5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNjI1MjAsImV4cCI6MjEwNjYzODUyMH0.AaXcnfbW208-ZVxosu85C2aTiQU6QhIqC8fhUjSA2rg";
let sharedBackend = { client:null, ready:false, syncing:false, applyingRemote:false, channel:null, version:0, farmId:null, userId:null };
