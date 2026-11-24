// @ts-nocheck
// ============================================================================
// GramWasi server — Supabase Edge Functions bundle (Deno runtime)
// ----------------------------------------------------------------------------
// Ye EK self-contained file hai: andar ~/workspace/insta-clone/server/server.js
// ka pura code hai (Node http style handleRequest), upar ek chhota sa shim
// layer (process.env + require + __dirname) aur neeche ek fetch adapter jo
// Supabase Edge Function ki request ko Node-style req/res me badal deta hai.
// Deploy: Supabase Dashboard -> Edge Functions -> new function "api" ->
// is file ka content paste -> Verify JWT OFF -> secret ADMIN_KEY set karo.
// URL: https://fmkcmxaocciqnzegbzxk.supabase.co/functions/v1/api
// ============================================================================

import * as __gwHttp from "node:http";
import * as __gwFs from "node:fs";
import * as __gwPath from "node:path";
import * as __gwCrypto from "node:crypto";
import * as __gwHttps from "node:https";
import * as __gwTls from "node:tls";
import * as __gwZlib from "node:zlib";
import { Buffer as __gwBuffer } from "node:buffer";
import { EventEmitter as __gwEventEmitter } from "node:events";

// Buffer global (server code bare `Buffer` use karta hai)
globalThis.Buffer = __gwBuffer;

// ---------- process shim (server code ke chalne se PEHLE) ----------
// Supabase Edge Functions SUPABASE_URL aur SUPABASE_ANON_KEY khud inject
// karti hai; ADMIN_KEY / TELEGRAM_* function secrets se aayenge. Sirf wahi
// keys set hoti hain jo sach me maujud hain.
{
  const __gwEnv = {};
  for (const __gwK of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "ADMIN_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SMTP_URL", "RESEND_API_KEY", "BREVO_API_KEY", "MAIL_FROM", "MAIL_FROM_EMAIL"]) {
    const __gwV = Deno.env.get(__gwK);
    if (__gwV !== undefined) __gwEnv[__gwK] = __gwV;
  }
  try {
    globalThis.process = { env: __gwEnv };
  } catch (__gwE) {
    // Kuch runtimes me process replace nahi hota — to usi ke env me ghused do.
    try {
      for (const __gwK of Object.keys(__gwEnv)) globalThis.process.env[__gwK] = __gwEnv[__gwK];
    } catch (__gwE2) { /* shim na lage to server apne defaults se chalega */ }
  }
}

// ---------- require shim ----------
// server.js CommonJS hai: top par require('http'|'fs'|'path'|'crypto') aur
// beech me require('https') / require('tls') (mail + telegram paths). Teeno
// asal node: modules se jude hain — crypto (password hashing) bilkul asli hai.
const __gwModules = {
  "http": __gwHttp,
  "fs": __gwFs,
  "path": __gwPath,
  "crypto": __gwCrypto,
  "https": __gwHttps,
  "tls": __gwTls,
  "zlib": __gwZlib,
};
const require = (id) => {
  if (Object.prototype.hasOwnProperty.call(__gwModules, id)) return __gwModules[id];
  throw new Error("GramWasi bundle: unsupported require('" + id + "')");
};

// __dirname sirf DATA_FILE (file-mode fallback) aur /admin static path ke
// liye chahiye. Supabase mode me file storage use hi nahi hota; ye path
// sirf isliye hai taaki module top-level crash na kare.
const __dirname = new URL(".", import.meta.url).pathname;

// ============================================================================
// ===== neeche: server.js ka code (sirf createServer/listen/exports hata) =====
// ============================================================================
// GramWasi backend server — zero-dependency Node.js
// Run: node server.js   (PORT env, default 8080)
// Data: SUPABASE_URL + SUPABASE_ANON_KEY set ho to Supabase (permanent, shared),
// warna data.json file next to this file (ya VERCEL/NETLIFY par /tmp).
// Admin API key: header x-admin-key: gramwasi-admin-123 (change before real use)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ADMIN_KEY = process.env.ADMIN_KEY || 'gramwasi-admin-123';
const GW_OWNER = 'sagarjha'; // Owner account — sirf isko extra powers (rename/verify/delete)
function isOwnerUser(u) { return !!u && (u.username === GW_OWNER || (db.owners || []).indexOf(u.username) >= 0); }
const DATA_FILE = process.env.GRAMWASI_DATA_FILE || (process.env.VERCEL || process.env.NETLIFY ? '/tmp/gramwasi-data.json' : path.join(__dirname, 'data.json'));

// ---------- Storage ----------
// Do mode hai:
//  1) SUPABASE (permanent + sab serverless instances ke beech shared):
//     env SUPABASE_URL + SUPABASE_ANON_KEY set ho to pura DB ek hi jagah rehta
//     hai — Supabase table public.app_state, sirf ek row (id=1), column data
//     (jsonb) me pura DB object (wahi shape jo data.json me hota tha).
//     Netlify par /tmp wali dikkat (ek instance ka banaya account dusre
//     instance ko nahi dikhta) isiliye khatam ho jati hai.
//  2) FILE (fallback, pehle jaisa behaviour): GRAMWASI_DATA_FILE set ho to wo
//     path, VERCEL/NETLIFY par /tmp/gramwasi-data.json, warna server ke paas
//     wali data.json.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_ON = !!(SUPABASE_URL && SUPABASE_KEY);

let db = { users: [], posts: [], messages: [], stories: [], notifications: [], reports: [], owners: [], signals: [], seq: 1 };
let dbReady = false;   // pehli load koshish ho chuki hai
let dbHasData = false; // db me asli loaded/seed data aa chuka hai (khali initial object nahi)
let dbLoading = null;  // chal rahi load ka promise (duplicate load rokne ke liye)
let lastLoadAt = 0;    // aakhri successful load/save ka time (ms)
let pendingSaves = 0;  // chal rahe Supabase saves ki ginti
let sbHasRow = false;  // Supabase me app_state ki row (id=1) maujud hai
let dbLoadOk = false;  // Supabase se ASAL data load hua hai — jab tak false, ye instance save NAHI karega (blind instance kabhi asli data overwrite nahi kar sakta)

function seedData() {
  const d = { users: [], posts: [], messages: [], stories: [], notifications: [], reports: [], owners: [], signals: [], seq: 1 };
  const mk = (u, name, verified) => ({
    id: d.seq++, username: u, name, bio: '', avatar: 'https://picsum.photos/seed/' + u + '/150/150',
    passwordHash: hash('demo123'), verified: !!verified, blocked: false,
    followers: [], following: [], acceptedChats: [], blockedUsers: [], chatCleared: {}, lastSeen: 0, note: '', noteAt: 0, createdAt: Date.now()
  });
  d.users.push(mk('demo', 'Demo User', true), mk('aarav_sharma', 'Aarav Sharma', true),
    mk('priya_singh', 'Priya Singh', false), mk('rohit_kumar', 'Rohit Kumar', false));
  ensureSeedReels(d);
  return d;
}

// ===== v15: 100 wallpaper + bhagwan posts (ek baar seed) =====
const WP15 = [
["https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0c/Attributed_to_Khushala%2C_Indian%2C_active_late_18th_century_-_The_Gods_Sing_and_Dance_for_Shiva_and_Parvati_-_Google_Art_Project.jpg/960px-Attributed_to_Khushala%2C_Indian%2C_active_late_18th_century_-_The_Gods_Sing_and_Dance_for_Shiva_and_Parvati_-_Google_Art_Project.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🕉️ Mahadev ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/1/15/The_Goddess_Bhairavi_Devi_with_Shiva_MET_DP257990.jpg/960px-The_Goddess_Bhairavi_Devi_with_Shiva_MET_DP257990.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🕉️ Mahadev ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/5/51/Shiva_Painting_1.jpg/960px-Shiva_Painting_1.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🕉️ Mahadev ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6e/Krishna_Holds_Up_Mount_Govardhan_to_Shelter_the_Villagers_of_Braj%2C_ca.1590%E2%80%9395%2C_The_Met.jpg/960px-Krishna_Holds_Up_Mount_Govardhan_to_Shelter_the_Villagers_of_Braj%2C_ca.1590%E2%80%9395%2C_The_Met.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🪔 Shri Krishna ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/2/27/Dasavataralu_-_Krishna_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg/960px-Dasavataralu_-_Krishna_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🪔 Shri Krishna ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a0/Maker_unknown%2C_India_-_Krishna_and_Radha_-_Google_Art_Project.jpg/960px-Maker_unknown%2C_India_-_Krishna_and_Radha_-_Google_Art_Project.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🪔 Shri Krishna ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/a/a8/Ganesha_Painting_at_a_Temple_in_Bhadrachalam.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🙏 Ganpati Bappa ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/2/27/Ganesha_Sarasvati_Poona_painting_1800-05.jpg/960px-Ganesha_Sarasvati_Poona_painting_1800-05.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Ganpati Bappa ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e0/Painting_of_Ganesha_at_Bhimbetka.jpg/960px-Painting_of_Ganesha_at_Bhimbetka.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Ganpati Bappa ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/f/ff/Unknown_%28Indian%29_-_Durga_-_71.305_-_Detroit_Institute_of_Arts.jpg/960px-Unknown_%28Indian%29_-_Durga_-_71.305_-_Detroit_Institute_of_Arts.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🔱 Maa Durga ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a2/Unknown_%28Indian%29_-_Durga_-_71.306_-_Detroit_Institute_of_Arts.jpg/960px-Unknown_%28Indian%29_-_Durga_-_71.306_-_Detroit_Institute_of_Arts.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🔱 Maa Durga ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4a/Painting_of_Durga%2C_1820.jpg/960px-Painting_of_Durga%2C_1820.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🔱 Maa Durga ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/2/26/Hanuman_painting_c1920.jpg/960px-Hanuman_painting_c1920.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Bajrangbali ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d7/Rama_and_Hanuman_fighting_Ravana%2C_an_album_painting_on_paper%2C_c1820.jpg/960px-Rama_and_Hanuman_fighting_Ravana%2C_an_album_painting_on_paper%2C_c1820.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Bajrangbali ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7d/Painting_depicting_Hanuman%2C_Durga%2C_and_Bhairava.jpg/960px-Painting_depicting_Hanuman%2C_Durga%2C_and_Bhairava.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Bajrangbali ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1c/Dasavataralu_-_Rama_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg/960px-Dasavataralu_-_Rama_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🏹 Shri Ram ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/1/19/RAMA_SITA_-OIL_PAINTING_BY_RAJASEKHARAN.jpg/960px-RAMA_SITA_-OIL_PAINTING_BY_RAJASEKHARAN.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🏹 Shri Ram ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9d/Rama_Zadi_Temple_%2801%29.jpg/960px-Rama_Zadi_Temple_%2801%29.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🏹 Shri Ram ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/7/79/Siddha_Lakshmi_-_Google_Art_Project.jpg/960px-Siddha_Lakshmi_-_Google_Art_Project.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🪔 Maa Lakshmi ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8d/Nathdwara_Painting_showing_Sheshayi_Vishnu_and_Lakshmi%2C_provenance_unknown%2C_Government_Museum_and_Art_Gallery%2C_Chandigarh.jpg/960px-Nathdwara_Painting_showing_Sheshayi_Vishnu_and_Lakshmi%2C_provenance_unknown%2C_Government_Museum_and_Art_Gallery%2C_Chandigarh.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🪔 Maa Lakshmi ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a6/Raja_Ravi_Varma%2C_Goddess_Lakshmi%2C_1896.jpg/960px-Raja_Ravi_Varma%2C_Goddess_Lakshmi%2C_1896.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🪔 Maa Lakshmi ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1a/Raja_Ravi_Varma%2C_Goddess_Saraswati.jpg/960px-Raja_Ravi_Varma%2C_Goddess_Saraswati.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🎵 Maa Saraswati ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/3/30/Saraswati_Pata.jpg/960px-Saraswati_Pata.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🎵 Maa Saraswati ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/3/31/Goddess_Saraswati_-_Raja_Ravi_Varma.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🎵 Maa Saraswati ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3c/Dasavataralu_-_The_Main_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg/960px-Dasavataralu_-_The_Main_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Shri Vishnu ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e1/India%2C_Calcutta%2C_Kalighat_painting%2C_19th_century_-_Trivikramapada_%28Three_Steps_of_Vishnu%29_-_2003.165_-_Cleveland_Museum_of_Art.jpg/960px-India%2C_Calcutta%2C_Kalighat_painting%2C_19th_century_-_Trivikramapada_%28Three_Steps_of_Vishnu%29_-_2003.165_-_Cleveland_Museum_of_Art.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Shri Vishnu ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b0/Dasavataralu_-_Varaha_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg/960px-Dasavataralu_-_Varaha_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Shri Vishnu ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b3/India%2C_Calcutta%2C_Kalighat_painting%2C_19th_century_-_Kali_-_2003.163_-_Cleveland_Museum_of_Art.jpg/960px-India%2C_Calcutta%2C_Kalighat_painting%2C_19th_century_-_Kali_-_2003.163_-_Cleveland_Museum_of_Art.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🔱 Maa Kali ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/4/47/Kalighat_pictures_sep_sheets_81.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🔱 Maa Kali ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Unidentified_-_Kali_-_2021.344_-_Metropolitan_Museum_of_Art.jpg/960px-Unidentified_-_Kali_-_2021.344_-_Metropolitan_Museum_of_Art.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🔱 Maa Kali ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/3/33/Fresco_depicting_Kartikeya_from_the_Veer_Bhan_Da_Shivala%2C_Amritsar%2C_circa_late-19th_century.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🙏 Kartikeya ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3b/Kartikeya.jpg/960px-Kartikeya.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Kartikeya ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/8/89/Skanda_Kartikeya.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🙏 Kartikeya ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9c/Radha_and_Krishna_in_the_boat_of_love_-_Google_Art_Project.jpg/960px-Radha_and_Krishna_in_the_boat_of_love_-_Google_Art_Project.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "💙 Radha Krishna ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9d/Radha%2C_Krishna_and_the_gopis%2C_Bharatiya_Lok_Kala_Museum%2C_Udaipur%2C_India.jpg/960px-Radha%2C_Krishna_and_the_gopis%2C_Bharatiya_Lok_Kala_Museum%2C_Udaipur%2C_India.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "💙 Radha Krishna ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/7/73/Radha-_Krishna%2C_Kalighat_Painting.jpg/960px-Radha-_Krishna%2C_Kalighat_Painting.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "💙 Radha Krishna ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/5/50/Deities_enshrined_in_the_Jagannath_Temple.jpg/960px-Deities_enshrined_in_the_Jagannath_Temple.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Jagannath ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/6/62/Lord_Jagannath_Patachitra.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🙏 Jagannath ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/d/db/Balarama%2C_Subhadra_and_Jagannath_in_the_temple_at_Puri%2C_with_Wellcome_V0017732.jpg/960px-Balarama%2C_Subhadra_and_Jagannath_in_the_temple_at_Puri%2C_with_Wellcome_V0017732.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Jagannath ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/2/2e/Sai_Baba_by_Mr._Vasant_A_Mali.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🙏 Sai Baba ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7b/Sai_baba_side_view.jpg/960px-Sai_baba_side_view.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Sai Baba ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/2/26/Kuang_Chee_Tng_Buddhist%2C_Moulmein_Church_of_Christ_%26_Sathya_Sai_Baba_Centre.jpg/960px-Kuang_Chee_Tng_Buddhist%2C_Moulmein_Church_of_Christ_%26_Sathya_Sai_Baba_Centre.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Sai Baba ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/1/11/Information_board_at_Venkateswara_Temple_in_Midhilapuri_VUDA_colony.JPG/960px-Information_board_at_Venkateswara_Temple_in_Midhilapuri_VUDA_colony.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Tirupati Balaji ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e4/Dasavataralu_-Gautam_Buddha_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg/960px-Dasavataralu_-Gautam_Buddha_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Tirupati Balaji ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/7/76/Dasavataralu_-_Matsya_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg/960px-Dasavataralu_-_Matsya_avatar_of_Lord_Vishnu_on_Sri_Venkateshwara_temple%2C_Guntur.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🙏 Tirupati Balaji ✨ #bhakti #god #wallpaper"],
["https://upload.wikimedia.org/wikipedia/commons/d/df/Thomas_Daniell_%281749-1840%29_-_Puja_Performed_at_a_Temple_of_Shiva_-_732154_-_National_Trust.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled", "🛕 Shiv Mandir ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/9/92/Shiva_temples_Dhakeshwari_Mandir_2_by_Ragib_Hasan.jpg/960px-Shiva_temples_Dhakeshwari_Mandir_2_by_Ragib_Hasan.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🛕 Shiv Mandir ✨ #bhakti #god #wallpaper"],
["https://thumb.wikimedia.org/wikipedia/commons/thumb/7/72/Thiruneelakudi_-_Shiva_painting_in_the_wall.JPG/960px-Thiruneelakudi_-_Shiva_painting_in_the_wall.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail", "🛕 Shiv Mandir ✨ #bhakti #god #wallpaper"],
["https://picsum.photos/seed/gwwp1/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp2/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp3/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp4/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp5/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp6/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp7/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp8/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp9/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp10/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp11/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp12/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp13/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp14/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp15/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp16/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp17/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp18/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp19/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp20/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp21/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp22/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp23/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp24/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp25/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp26/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp27/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp28/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp29/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp30/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp31/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp32/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp33/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp34/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp35/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp36/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp37/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp38/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp39/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp40/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp41/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp42/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp43/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp44/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp45/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp46/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp47/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp48/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp49/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp50/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp51/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"],
["https://picsum.photos/seed/gwwp52/720/1280", "🌄 Beautiful Wallpaper ✨ #wallpaper #nature #hd"]
];
function ensureWallpaperSeeds() {
  try {
    if (!dbHasData || db.wpSeededV15) return;
    if (SUPABASE_ON && !dbLoadOk) return;
    db.wpSeededV15 = true;
    const now = Date.now();
    WP15.forEach(function (w, i) {
      db.posts.push({ id: 'wp15_' + (i + 1), user: 'gramwasi', image: w[0], video: null,
        caption: w[1], likes: 0, likedBy: [], comments: [], seed: true, createdAt: now - i * 60000 });
    });
    saveDb();
  } catch (e) { console.warn('[wp15] seed fail:', (e && e.message) || e); }
}
function normalizeDb(d) {
  const out = { users: [], posts: [], messages: [], stories: [], notifications: [], reports: [], signals: [], seq: 1 };
  if (d && typeof d === 'object') {
    if (Array.isArray(d.users)) out.users = d.users;
    if (Array.isArray(d.posts)) out.posts = d.posts;
    if (Array.isArray(d.messages)) out.messages = d.messages;
    if (Array.isArray(d.stories)) out.stories = d.stories;
    if (Array.isArray(d.notifications)) out.notifications = d.notifications;
    if (Array.isArray(d.reports)) out.reports = d.reports;
    if (typeof d.seq === 'number' && d.seq > 0) out.seq = d.seq;
    if (d.pending && typeof d.pending === 'object') out.pending = d.pending;
    if (d.wpSeededV15 === true) out.wpSeededV15 = true;
    if (Array.isArray(d.owners)) out.owners = d.owners;
    if (Array.isArray(d.signals)) out.signals = d.signals;
    if (typeof d.tgOffset === 'number') out.tgOffset = d.tgOffset;
    if (typeof d.tgLastCheck === 'number') out.tgLastCheck = d.tgLastCheck;
  }
  out.posts.forEach(migratePost);
  ensureSeedReels(out);
  return out;
}
// Post likes ka model: storage me likedBy (usernames) + baseLikes (seed/purani
// ginti) rehta hai; bahar hamesha likes = baseLikes + likedBy.length bhejte
// hain. Purane post jinme likedBy nahi hai: likes agar array hai to wahi
// likers the (likedBy ban jayenge), number hai to wahi baseLikes ban jayega.
function migratePost(post) {
  if (!post || typeof post !== 'object') return post;
  if (!Array.isArray(post.likedBy)) {
    if (Array.isArray(post.likes)) { post.likedBy = post.likes.slice(); post.baseLikes = 0; }
    else if (typeof post.likes === 'number') { post.likedBy = []; post.baseLikes = post.likes; }
    else post.likedBy = [];
  }
  if (typeof post.baseLikes !== 'number' || isNaN(post.baseLikes)) post.baseLikes = 0;
  if ('likes' in post) delete post.likes;
  if (!Array.isArray(post.comments)) post.comments = [];
  return post;
}
function postLikesCount(post) { migratePost(post); return (post.baseLikes || 0) + post.likedBy.length; }
// Telegram group (Rovenox) me Sagar jo photo dalta hai, wo GramWasi feed me
// apne aap aa jaye — getUpdates se (bot ke apne messages skip). 20s throttle.
let tgBotId = null;
async function maybeImportTgPhotos() {
  if (!TG_ON) return;
  const now = Date.now();
  if (now - (db.tgLastCheck || 0) < 20000) return;
  db.tgLastCheck = now;
  try {
    if (tgBotId === null) { const me = await tgCall('getMe', {}); tgBotId = me && me.result ? me.result.id : 0; }
    const upd = await tgCall('getUpdates', { offset: db.tgOffset || 0, timeout: 0, allowed_updates: ['message'] });
    const list = (upd && upd.result) || [];
    let changed = false;
    for (const u of list) {
      db.tgOffset = Math.max(db.tgOffset || 0, (u.update_id || 0) + 1);
      const m = u.message;
      if (!m || String(m.chat && m.chat.id) !== String(TG_CHAT)) continue;
      if (!m.photo || !m.photo.length) continue;
      if (m.from && m.from.is_bot) continue;
      if (db.posts.some(p => p.tgMsgId === m.message_id)) continue;
      const ph = m.photo[m.photo.length - 1];
      db.posts.unshift({ id: db.seq++, username: GW_OWNER, image: '', telegramFileId: ph.file_id, tgKind: 'photo', caption: m.caption || '', createdAt: (m.date || 0) * 1000 || Date.now(), likedBy: [], baseLikes: 0, comments: [], tgMsgId: m.message_id, imported: true });
      changed = true;
    }
    if (changed || list.length) await saveDb();
  } catch (e) { /* Telegram fail ho to feed normal chalti rahegi */ }
}
function serializePost(post) {
  migratePost(post);
  const pun = post.username || post.user || '';
  const out = { ...post, username: pun, likes: (post.baseLikes || 0) + post.likedBy.length,
    likedBy: post.likedBy.slice(), user: pun, author: pub(byName(pun)) };
  if (post.tgKind === 'video' && post.telegramFileId) out.video = '/api/media?postId=' + post.id;
  else if (!out.image && post.telegramFileId) out.image = '/api/media?postId=' + post.id;
  return out;
}
// Seeded popular reels: Reels tab khali na lage isliye Google ke sample bucket
// ke openly-usable videos. Shape app ke video post jaisi hi hai (video:true +
// src me video URL + image me poster). id "pop*" prefix se app inhe asli user
// reels ke BAAD rakhta hai; createdAt jaan-boojh kar purana hai taaki asli
// reels hamesha naye/upar rahen.
const GTV_SAMPLE = 'https://storage.googleapis.com/gtv-videos-bucket/sample/';
const POP_REEL_DEFS = [
  { id: 'pop1', username: 'aarav_sharma', file: 'ForBiggerBlazes.mp4', img: 'img/p1.jpg', baseLikes: 45200, caption: 'Popular reel 🔥 Full masti mode on #reels' },
  { id: 'pop2', username: 'priya_singh', file: 'ForBiggerEscapes.mp4', img: 'img/p2.jpg', baseLikes: 38400, caption: 'Popular reel 🔥 Chhuttiyon ka plan ban gaya ✈️ #travel' },
  { id: 'pop3', username: 'rohit_kumar', file: 'ForBiggerFun.mp4', img: 'img/p3.jpg', baseLikes: 27150, caption: 'Popular reel 🔥 Ye dekh ke hasna pakka hai 😂' },
  { id: 'pop4', username: 'demo', file: 'ForBiggerJoyrides.mp4', img: 'img/p4.jpg', baseLikes: 19800, caption: 'Popular reel 🔥 Ride wala din 🏍️ #bikelife' },
  { id: 'pop5', username: 'aarav_sharma', file: 'ForBiggerMeltdowns.mp4', img: 'img/p5.jpg', baseLikes: 15300, caption: 'Popular reel 🔥 Jab plan bigad jaye to aisa hota hai 😭😂' },
  { id: 'pop6', username: 'priya_singh', file: 'Sintel.mp4', img: 'img/p6.jpg', baseLikes: 12750, caption: 'Popular reel 🔥 Sintel — dil chhu lene wali kahani 🎬' },
  { id: 'pop7', username: 'rohit_kumar', file: 'BigBuckBunny.mp4', img: 'img/p7.jpg', baseLikes: 9800, caption: 'Popular reel 🔥 Big Buck Bunny — sabki pasand 🐰' },
  { id: 'pop8', username: 'demo', file: 'ElephantsDream.mp4', img: 'img/p8.jpg', baseLikes: 2350, caption: 'Popular reel 🔥 Elephants Dream — sapno ki duniya 🐘' }
];
function ensureSeedReels(d) {
  if (!d || !Array.isArray(d.posts)) return;
  const have = new Set(d.posts.map(x => String(x.id)));
  const missing = [];
  POP_REEL_DEFS.forEach((r, i) => {
    if (have.has(r.id)) return;
    missing.push({ id: r.id, username: r.username, image: r.img, video: true,
      src: GTV_SAMPLE + r.file, caption: r.caption, likedBy: [], baseLikes: r.baseLikes,
      comments: [], createdAt: 1759000000000 - i * 86400000 });
  });
  // Shuru me jodo (sabse purane) — GET /api/posts reverse order me deta hai,
  // isliye ye hamesha asli posts ke baad aayenge.
  if (missing.length) d.posts = missing.concat(d.posts);
}
function fileLoad() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return (d && Array.isArray(d.users)) ? d : null;
  } catch (e) { return null; }
}
function fileSave() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1)); } catch (e) { /* data write fail ho to request crash nahi hona chahiye */ } }
function sbSignal() { try { return AbortSignal.timeout(10000); } catch (e) { return undefined; } }
async function sbLoad() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=data', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, signal: sbSignal() });
  if (!r.ok) throw new Error('Supabase load HTTP ' + r.status);
  const rows = await r.json();
  if (Array.isArray(rows) && rows.length === 0) return null; // row hi nahi — sirf pehli boot par hota hai
  if (Array.isArray(rows) && rows[0] && rows[0].data && Array.isArray(rows[0].data.users)) return rows[0].data;
  throw new Error('Supabase load: unexpected response shape');
}
async function sbSave() {
  const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
  const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1', {
    method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal,count=exact' },
    body: JSON.stringify({ data: db }), signal: sbSignal() });
  if (!r.ok) throw new Error('Supabase save HTTP ' + r.status);
  let affected = null;
  const cr = r.headers.get('content-range');
  if (cr && cr.indexOf('/') >= 0) { const n = parseInt(cr.split('/')[1], 10); if (!isNaN(n)) affected = n; }
  if (affected > 0) { sbHasRow = true; return; }
  if (affected === null && sbHasRow) return; // header na mile, par row pehle se pakki hai — PATCH par bharosa
  // Row hi nahi hai (PATCH ne kuch affect nahi kiya) — upsert se bana do
  const ins = await fetch(SUPABASE_URL + '/rest/v1/app_state', {
    method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 1, data: db }), signal: sbSignal() });
  if (!ins.ok) throw new Error('Supabase insert HTTP ' + ins.status);
  sbHasRow = true;
}
async function loadDb(force) {
  if (dbLoading) return dbLoading;
  if (dbReady && !force) return;
  dbLoading = (async () => {
    try {
      if (SUPABASE_ON) {
        const data = await sbLoad();
        if (data) { db = normalizeDb(data); sbHasRow = true; dbLoadOk = true; }
        else {
          // Row sach me maujud nahi (sirf bilkul nayi pehli boot) — tab hi
          // seed banao. dbLoadOk yahin true hoga kyunki khali jagah par
          // likhna surakshit hai; maujud data ko ye raasta kabhi nahi chhuta.
          db = seedData(); dbLoadOk = true; await sbSave();
        }
      } else {
        const data = fileLoad();
        if (data) db = normalizeDb(data);
        else { db = seedData(); fileSave(); }
      }
      dbHasData = true;
      lastLoadAt = Date.now();
    } catch (e) {
      // Storage fail ho jaye to request crash nahi hona chahiye. Supabase mode
      // me fail ka matlab hai ye instance ANDHA hai: khali DB se jawab do,
      // par saveDb ka guard (dbLoadOk=false) iski koi bhi save rok dega —
      // asli data kabhi overwrite nahi hoga. File mode me seed chalega.
      console.warn('[storage] load fail, in-memory DB se continue:', (e && e.message) || e);
      if (!dbHasData) { db = SUPABASE_ON ? { users: [], posts: [], messages: [], stories: [], notifications: [], reports: [], seq: 1 } : seedData(); dbHasData = true; }
    } finally { dbReady = true; dbLoading = null; }
  })();
  return dbLoading;
}
function ensureDb() { return loadDb(false); }
// Read endpoints par taza data: dusre instance ne kuch likha ho to wo bhi dikhe
// (chat polling, user search jaise cases ke liye). 4 second se purani load ho
// tabhi refresh; apna save chal raha ho to refresh skip (purana data na aaye).
async function refreshIfStale(p, method) {
  if (!SUPABASE_ON || method !== 'GET') return;
  if (p !== '/api/users' && p !== '/api/chat' && p !== '/api/chat/unread' && p !== '/api/chat/inbox' && p !== '/api/notifications' && p !== '/api/posts' && p !== '/api/stories' && p !== '/api/telegram/discover' && p !== '/api/call/signals') return;
  if (pendingSaves > 0) return;
  if (Date.now() - lastLoadAt > 4000) await loadDb(true);
}
// Mutation (koi bhi POST) se pehle taza data: kai warm serverless instances
// apna-apna in-memory snapshot rakhte hain. Read refresh se kaam nahi chalta —
// mutation purane snapshot par chale to (a) verify-email jaisi request
// "pending not found" fail ho sakti hai kyunki signup kisi AUR instance par
// hua tha, aur (b) is instance ka save doosre instance ke naye data ko
// overwrite (clobber) kar sakta hai. Isliye har POST handler se pehle:
//  - Supabase mode: last successful load 1500ms se purani ho tabhi reload
//    (refreshIfStale wali hi machinery — loadDb(true) + lastLoadAt).
//  - File mode: hamesha reload (sasta hai, single instance hai). Yahan
//    loadDb(true) NAHI bulate: file mode me loadDb ka async IIFE bina kisi
//    await ke synchronously khatam ho jata hai, to uske finally wala
//    "dbLoading = null" assignment se pehle chal jata hai aur dbLoading
//    hamesha ke liye ek settled promise par atka rehta hai — aage ke saare
//    loadDb() calls bina reload kiye wahi purana promise lauta dete hain
//    (no-op). Isliye file branch fileLoad()/normalizeDb() se seedha padhta
//    hai; file na mile ya corrupt ho to in-memory copy hi rehti hai
//    (seed se reset kabhi nahi).
// Apna save chal raha ho (pendingSaves > 0) to refresh skip — warna beech me
// purana stored snapshot aakar in-flight mutation ko revert kar dega.
// Reload fail ho jaye to request crash NAHI hona chahiye: in-memory copy se
// continue karo, sirf warning log karo (loadDb khud bhi throw nahi karta,
// ye try/catch extra suraksha hai).
async function refreshBeforeMutation() {
  try {
    if (pendingSaves > 0) return;
    if (SUPABASE_ON) {
      if (Date.now() - lastLoadAt > 1500) await loadDb(true);
    } else {
      const data = fileLoad();
      if (data) { db = normalizeDb(data); dbHasData = true; lastLoadAt = Date.now(); }
    }
  } catch (e) {
    console.warn('[storage] mutation refresh fail, in-memory DB se continue:', (e && e.message) || e);
  }
}
async function saveDb() {
  if (!SUPABASE_ON) { fileSave(); return; }
  if (!dbLoadOk) { console.warn('[storage] save roka gaya — is instance ne asli data load hi nahi kiya (blind save se data ud sakta hai)'); return; }
  pendingSaves++;
  try { await sbSave(); lastLoadAt = Date.now(); }
  catch (e) { console.warn('[storage] save fail:', (e && e.message) || e); }
  finally { pendingSaves--; }
}
function hash(p) { return crypto.createHash('sha256').update('gw:' + p).digest('hex'); }
// Real email sending needs a FREE mail service (koi paisa nahi lagta). Teen me se
// koi ek env me set karo:
//   1) RESEND_API_KEY  — resend.com free account ki API key (sabse asaan)
//   2) BREVO_API_KEY   — brevo.com free account ki API key (roz 300 mail free)
//   3) SMTP_URL        — apne Gmail ka App Password: smtp://tum@gmail.com:APP_PASSWORD@smtp.gmail.com:465
// Kuch bhi set na ho to DEMO mode: code API response me wapas milta hai (test ke liye),
// lekin asli mail nahi jata.
const httpsMail = require('https');
const MAIL_CONFIGURED = !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY || process.env.SMTP_URL);
function mailApi(host, path2, headers, payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const r = httpsMail.request({ host, path: path2, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(resp.statusCode >= 200 && resp.statusCode < 300)); });
    r.on('error', () => resolve(false));
    r.write(data); r.end();
  });
}
function smtpSend(urlStr, from, to, subject, text) {
  // Zero-dependency SMTP over implicit TLS (port 465) — Gmail App Password ke liye
  return new Promise(resolve => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve(false); }
    const tls = require('tls');
    const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
    const sock = tls.connect(Number(u.port || 465), u.hostname, { servername: u.hostname }, () => {});
    const cmds = ['EHLO gramwasi.local', 'AUTH LOGIN', Buffer.from(user).toString('base64'),
      Buffer.from(pass).toString('base64'), 'MAIL FROM:<' + from + '>', 'RCPT TO:<' + to + '>', 'DATA',
      'From: ' + from + '\r\nTo: ' + to + '\r\nSubject: ' + subject + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + text + '\r\n.', 'QUIT'];
    let step = 0, buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => {
      buf += d;
      if (!buf.includes('\n')) return;
      buf = '';
      if (step < cmds.length) sock.write(cmds[step++] + '\r\n');
      else { sock.end(); resolve(true); }
    });
    sock.on('error', () => resolve(false));
    setTimeout(() => { try { sock.destroy(); } catch (e) {} resolve(false); }, 15000);
  });
}
async function sendMail(to, subject, text) {
  try {
    if (process.env.RESEND_API_KEY) {
      return await mailApi('api.resend.com', '/emails',
        { Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
        { from: process.env.MAIL_FROM || 'GramWasi <onboarding@resend.dev>', to: [to], subject, text });
    }
    if (process.env.BREVO_API_KEY) {
      return await mailApi('api.brevo.com', '/v3/smtp/email',
        { 'api-key': process.env.BREVO_API_KEY },
        { sender: { name: 'GramWasi', email: process.env.MAIL_FROM_EMAIL || 'no-reply@gramwasi.app' },
          to: [{ email: to }], subject, textContent: text });
    }
    if (process.env.SMTP_URL) {
      const from = decodeURIComponent(new URL(process.env.SMTP_URL).username);
      return await smtpSend(process.env.SMTP_URL, from, to, subject, text);
    }
  } catch (e) { /* mail fail ho to demo fallback neeche hai */ }
  return false;
}
function avatarOut(u) {
  // Avatar DB me data-URL (badi base64 photo) hai — API me seedha bhejne se
  // /api/users 60KB+ ho jata tha aur slow net par response kat jata tha
  // (profile par 0/0/0 ki asal jad). Ab sirf ek halki URL jati hai.
  const av = u && u.avatar;
  if (av && av.indexOf('data:') === 0 && process.env.SUPABASE_URL) {
    return process.env.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/api/avatar?u=' + encodeURIComponent(u.username);
  }
  return av || '';
}
function pub(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, bio: u.bio, avatar: avatarOut(u),
    email: u.email || '', emailVerified: !!u.emailVerified,
    publicKey: u.publicKey || null,
    verified: u.verified, blocked: u.blocked,
    lastSeen: typeof u.lastSeen === 'number' ? u.lastSeen : 0,
    crownUntil: typeof u.crownUntil === 'number' ? u.crownUntil : 0,
    note: (u.note && (Date.now() - (u.noteAt || 0)) < 24 * 3600 * 1000) ? u.note : '',
    noteAt: typeof u.noteAt === 'number' ? u.noteAt : 0,
    ownerPower: isOwnerUser(u),
    followers: (u.followers || []).length, following: (u.following || []).length,
    followerList: u.followers || [], followingList: u.following || [] };
}
function byName(name) { return db.users.find(u => u.username === String(name || '').toLowerCase()); }
// Admin ke liye rich user record. passwordHash KABHI nahi jata, aur E2EE
// publicKey ki value bhi nahi — sirf hasKey boolean (key set hai ya nahi).
function adminUser(u) {
  return { username: u.username, name: u.name, bio: u.bio || '', avatar: u.avatar,
    email: u.email || '', emailVerified: !!u.emailVerified,
    verified: !!u.verified, blocked: !!u.blocked, ownerPower: isOwnerUser(u),
    followers: (u.followers || []).length, following: (u.following || []).length,
    followerList: u.followers || [], followingList: u.following || [],
    postCount: db.posts.filter(x => x.username === u.username).length,
    messageCount: db.messages.filter(x => x.from === u.username).length,
    createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
    hasKey: !!u.publicKey };
}

function send(res, code, obj) {
  let body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  // Bade jawab (posts/users) gzip me — slow net par stream katne se bachav.
  if (body.length > 4096 && res._ae && String(res._ae).indexOf('gzip') >= 0) {
    try { body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding'; } catch (e) { body = JSON.stringify(obj); }
  }
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(code, headers);
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

// ---------- Telegram storage + message mirror (FREE, optional) ----------
// Set env TELEGRAM_BOT_TOKEN (BotFather se milega) and TELEGRAM_CHAT_ID
// (ek private channel jisme bot admin ho). Token kabhi code me mat likho —
// sirf hosting ke environment/settings me dalo.
// Kaam: (1) post ki photo Telegram channel par store hoti hai, server par
// sirf uski file_id rehti hai (server storage bachta hai).
// (2) har chat message ki ek copy Telegram par backup hoti hai.
const https = require('https');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const TG_ON = !!(TG_TOKEN && TG_CHAT);
function tgCall(method, params) {
  return new Promise(resolve => {
    if (!TG_ON) return resolve(null);
    const data = JSON.stringify(params || {});
    const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/' + method,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); });
    r.on('error', () => resolve(null));
    r.write(data); r.end();
  });
}
function tgUploadPhoto(buffer, caption) {
  // multipart upload of an image buffer via sendPhoto; resolves to Telegram file_id or null
  return new Promise(resolve => {
    if (!TG_ON) return resolve(null);
    const boundary = '----gw' + Date.now();
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + TG_CHAT +
      '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + (caption || 'GramWasi post') +
      '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="post.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const payload = Buffer.concat([head, buffer, tail]);
    const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/sendPhoto',
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length } },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        try { const j = JSON.parse(d); const ph = j.result && j.result.photo; resolve(ph ? ph[ph.length - 1].file_id : null); }
        catch (e) { resolve(null); } }); });
    r.on('error', () => resolve(null));
    r.write(payload); r.end();
  });
}
function tgUploadVideo(buffer, caption) {
  // multipart upload of a video buffer via sendVideo; resolves to Telegram file_id or null
  return new Promise(resolve => {
    if (!TG_ON) return resolve(null);
    const boundary = '----gw' + Date.now();
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + TG_CHAT +
      '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + (caption || 'GramWasi video') +
      '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="video"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const payload = Buffer.concat([head, buffer, tail]);
    const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/sendVideo',
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length } },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        try { const j = JSON.parse(d); const v = j.result && j.result.video; resolve(v ? v.file_id : null); }
        catch (e) { resolve(null); } }); });
    r.on('error', () => resolve(null));
    r.write(payload); r.end();
  });
}
function tgUploadVoice(buffer, caption, ext, mime) {
  ext = ext || 'webm'; mime = mime || 'audio/webm';
  // Voice note upload: pehle sendVoice (OGG), fail ho to sendDocument (webm bhi chalega).
  function up(method, field, filename, ctype, pick) {
    return new Promise(resolve => {
      if (!TG_ON) return resolve(null);
      const boundary = '----gw' + Date.now();
      const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + TG_CHAT +
        '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + (caption || 'GramWasi voice') +
        '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="' + field + '"; filename="' + filename + '"\r\nContent-Type: ' + ctype + '\r\n\r\n');
      const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
      const payload = Buffer.concat([head, buffer, tail]);
      const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/' + method,
        method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length } },
        resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
          try { const j = JSON.parse(d); resolve(pick(j) || null); } catch (e) { resolve(null); } }); });
      r.on('error', () => resolve(null));
      r.write(payload); r.end();
    });
  }
  const doc = () => up('sendDocument', 'document', 'voice.' + ext, mime, j => j.result && j.result.document && j.result.document.file_id);
  if (ext === 'ogg') return up('sendVoice', 'voice', 'voice.ogg', 'audio/ogg', j => j.result && j.result.voice && j.result.voice.file_id).then(id => id || doc());
  return doc();
}
async function tgStorePostImage(post) {
  if (!TG_ON || !post.image) return;
  try {
    if (post.image.startsWith('data:')) {
      const b64 = post.image.split(',')[1] || '';
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 0 && buf.length < 10 * 1024 * 1024) {
        const fid = await tgUploadPhoto(buf, '@' + post.username + ': ' + (post.caption || ''));
        if (fid) { post.telegramFileId = fid; post.image = ''; await saveDb(); }
      }
    } else if (post.image.startsWith('http')) {
      const j = await tgCall('sendPhoto', { chat_id: TG_CHAT, photo: post.image, caption: '@' + post.username + ': ' + (post.caption || '') });
      const ph = j && j.result && j.result.photo;
      if (ph) { post.telegramFileId = ph[ph.length - 1].file_id; await saveDb(); }
    }
  } catch (e) { /* Telegram fail ho to post server par hi rehta hai */ }
}
function tgMirrorMessage(m) {
  if (!TG_ON) return Promise.resolve(null);
  // Encrypted message (enc: se shuru) Telegram par bhi sirf cipher jata hai —
  // asli text na server ko milta hai, na Telegram ko. 🔒
  const bodyText = String(m.text || '').startsWith('enc:')
    ? '🔒 encrypted message (sirf bhejne wala aur paane wala hi padh sakta hai)'
    : (String(m.text || '').startsWith('ttt:') ? '🎮 Tic-Tac-Toe game ki chaal' : (String(m.text || '').startsWith('postshare:') ? '📸 Post share kiya' : (String(m.text || '').startsWith('profile:') ? '👤 Profile share kiya' : m.text)));
  return tgCall('sendMessage', { chat_id: TG_CHAT, text: '💬 @' + m.from + ' → @' + m.to + ': ' + bodyText }).catch(() => {});
}

async function handleRequest(req, res) {
  try { res._ae = (req.headers || {})['accept-encoding'] || ''; } catch (e) {}
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { send(res, 200, {}); return; }

  await ensureDb();
  ensureWallpaperSeeds();
  await refreshIfStale(p, req.method);

  // Serve admin panel at /admin if the file sits next to the server folder
  if (p === '/admin' || p === '/admin/') {
    const f = path.join(__dirname, '..', 'admin', 'index.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(f)); return;
    }
  }
  if (p === '/' || p === '/health') { send(res, 200, { app: 'GramWasi', ok: true, telegramStorage: TG_ON, storage: SUPABASE_ON ? 'supabase' : 'file' }); return; }
  if (p === '/api/avatar' && req.method === 'GET') {
    const un = String(url.searchParams.get('u') || '').toLowerCase();
    const usr = byName(un);
    const av = usr && usr.avatar;
    if (!av) { send(res, 404, { error: 'avatar nahi hai' }); return; }
    if (av.indexOf('data:') === 0) {
      const mm = av.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!mm) { send(res, 404, { error: 'avatar kharab hai' }); return; }
      const buf = mm[2] ? Buffer.from(mm[3], 'base64') : Buffer.from(decodeURIComponent(mm[3]));
      res.writeHead(200, { 'Content-Type': mm[1] || 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600' });
      res.end(buf); return;
    }
    res.writeHead(302, { Location: av }); res.end(); return;
  }
  if (p === '/api/media' && req.method === 'GET') {
    // Telegram par stored photo ko wapas dikhana: /api/media?postId=<id>
    const wantId = url.searchParams.get('postId');
    const msgId = url.searchParams.get('msgId');
    if (msgId) {
      const mm = (db.messages || []).find(x => String(x.id) === String(msgId));
      if (mm && mm.telegramFileId && TG_ON) {
        const j = await tgCall('getFile', { file_id: mm.telegramFileId });
        const fp = j && j.result && j.result.file_path;
        if (fp) { res.writeHead(302, { Location: 'https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fp }); res.end(); return; }
      }
      // Telegram upload fail hua tha to message me fallback data-URL pada hai —
      // wahi serve karo, warna voice/photo hamesha ke liye atak jata tha.
      const mdu = mm && (mm.imageData || mm.audioData);
      if (mdu) {
        const mt = mdu.match(/^data:([^;,]+)/);
        const mbuf = Buffer.from(mdu.split(',')[1] || '', 'base64');
        res.writeHead(200, { 'Content-Type': mt ? mt[1] : 'application/octet-stream', 'Content-Length': mbuf.length, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
        res.end(mbuf); return;
      }
      send(res, 404, { error: 'media nahi mila' }); return;
    }
    const post = db.posts.find(x => String(x.id) === String(wantId)) || (db.stories || []).find(x => String(x.id) === String(wantId));
    if (!post) { send(res, 404, { error: 'post nahi mila' }); return; }
    if (post.image) { res.writeHead(302, { Location: post.image }); res.end(); return; }
    if (post.telegramFileId && TG_ON) {
      const j = await tgCall('getFile', { file_id: post.telegramFileId });
      const fp = j && j.result && j.result.file_path;
      if (fp) { res.writeHead(302, { Location: 'https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fp }); res.end(); return; }
    }
    send(res, 404, { error: 'media nahi mila' }); return;
  }
  if (p === '/api/telegram/discover' && req.method === 'GET') {
    // Bot ko channel me add karke channel me ek message bhejo, fir ye kholo —
    // chat id dikh jayegi jo TELEGRAM_CHAT_ID me dalni hai. (Admin only)
    if (req.headers['x-admin-key'] !== ADMIN_KEY) { send(res, 401, { error: 'admin key chahiye' }); return; }
    if (!TG_TOKEN) { send(res, 200, { telegramStorage: false, note: 'TELEGRAM_BOT_TOKEN set nahi hai' }); return; }
    const j = await new Promise(resolve => {
      const r = https.request({ host: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/getUpdates', method: 'GET' },
        resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); });
      r.on('error', () => resolve(null)); r.end();
    });
    const chats = [];
    ((j && j.result) || []).forEach(u => {
      const c = (u.channel_post && u.channel_post.chat) || (u.message && u.message.chat);
      if (c && !chats.some(x => x.id === c.id)) chats.push({ id: c.id, title: c.title || c.username || c.first_name || '', type: c.type });
    });
    send(res, 200, { chats }); return;
  }

  const body = req.method === 'POST' ? await readBody(req) : {};
  // Har POST handler se pehle DB fresh kar lo (upar refreshBeforeMutation
  // dekho) — mutation kabhi purane snapshot par nahi chalna chahiye.
  if (req.method === 'POST') await refreshBeforeMutation();
  const isAdmin = req.headers['x-admin-key'] === ADMIN_KEY;

  try {
    if (p === '/api/signup' && req.method === 'POST') {
      // PENDING signup: account abhi NAHI banta. Sirf ek pending entry banti hai
      // aur code Gmail par jata hai. Sahi code dalne par hi account create hoga.
      const username = String(body.username || '').toLowerCase().trim();
      const email = String(body.email || '').toLowerCase().trim();
      if (!username || !body.password) return send(res, 400, { error: 'username aur password chahiye' });
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'sahi Gmail/email dalo' });
      if (byName(username)) return send(res, 409, { error: 'username pehle se liya gaya hai, dusra chuno' });
      // Pending signup bhi username ko hold karta hai: kisi AUR email wale ka
      // pending hai to ye username nahi mil sakta. Wahi email ho to allow —
      // pending overwrite hokar naya code jayega (resend jaisa).
      db.pending = db.pending || {};
      const heldPend = db.pending[username];
      if (heldPend && heldPend.email !== email) return send(res, 409, { error: 'username pehle se liya gaya hai, dusra chuno' });
      if (db.users.some(x => x.email === email)) return send(res, 409, { error: 'is email se pehle hi account hai' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.pending = db.pending || {};
      db.pending[username] = { username, name: body.name || username, email,
        passwordHash: hash(body.password), code, codeAt: Date.now() };
      await saveDb();
      const sent = await sendMail(email, 'GramWasi verification code',
        'Namaste!\n\nTumhara GramWasi verification code hai: ' + code + '\n\nYe code 15 minute tak valid hai. Sahi code dalne par hi tumhara account banega.\n\n— GramWasi team');
      if (!MAIL_CONFIGURED) console.log('[DEMO MAIL] ' + email + ' ka verification code: ' + code);
      const out = { needVerify: true, pending: true, mailSent: sent };
      if (!MAIL_CONFIGURED) out.devCode = code; // demo mode only; mail service judne par code sirf Gmail par jayega
      return send(res, 201, out);
    }
    if (p === '/api/resend-code' && req.method === 'POST') {
      const username = String(body.username || '').toLowerCase().trim();
      db.pending = db.pending || {};
      const pend = db.pending[username];
      if (!pend) return send(res, 404, { error: 'pending signup nahi mila, pehle signup karo' });
      pend.code = String(Math.floor(100000 + Math.random() * 900000));
      pend.codeAt = Date.now(); await saveDb();
      const sent = await sendMail(pend.email, 'GramWasi verification code',
        'Tumhara naya GramWasi verification code hai: ' + pend.code + '\nYe code 15 minute tak valid hai.');
      const out = { needVerify: true, mailSent: sent };
      if (!MAIL_CONFIGURED) out.devCode = pend.code;
      return send(res, 200, out);
    }
    if (p === '/api/verify-email' && req.method === 'POST') {
      // Sahi code = tab account BANTA hai. Galat code par kuch nahi banta.
      // Username pehle se kisi verified user ka hai to bina saboot ke success
      // NAHI milta — sirf wahi banda dobara verify ho sakta hai jiska pending
      // email usi account ke email se match kare AUR code sahi ho.
      const username = String(body.username || '').toLowerCase().trim();
      db.pending = db.pending || {};
      const pend = db.pending[username];
      const existing = byName(username);
      if (existing && existing.emailVerified) {
        if (pend && String(body.code || '') === pend.code && pend.email === existing.email) {
          delete db.pending[username]; await saveDb();
          return send(res, 200, { user: pub(existing), already: true });
        }
        // Dusre email wala pending is username par kabza nahi rakh sakta — hata do.
        if (pend && pend.email !== existing.email) { delete db.pending[username]; await saveDb(); }
        return send(res, 409, { error: 'ye username pehle se liya gaya hai — login karo ya dusra username chuno' });
      }
      if (!pend) return send(res, 404, { error: 'pehle signup karke code lo' });
      if (String(body.code || '') !== pend.code) return send(res, 400, { error: 'galat code — account nahi bana' });
      if (Date.now() - (pend.codeAt || 0) > 15 * 60 * 1000) { delete db.pending[username]; await saveDb(); return send(res, 400, { error: 'code expire ho gaya, dobara signup karo' }); }
      // Aakhri safety check, account bante hi pehle: is username ka user pehle
      // se maujood hai to DOOSRA account kabhi nahi banna chahiye.
      if (byName(username)) return send(res, 409, { error: 'ye username pehle se liya gaya hai — login karo ya dusra username chuno' });
      const u = { id: db.seq++, username, name: pend.name, bio: '', email: pend.email,
        emailVerified: true,
        avatar: 'https://picsum.photos/seed/' + username + '/150/150',
        passwordHash: pend.passwordHash, verified: false, blocked: false,
        followers: [], following: [], acceptedChats: [], blockedUsers: [], chatCleared: {}, lastSeen: 0, note: '', noteAt: 0, createdAt: Date.now() };
      db.users.push(u);
      delete db.pending[username];
      await saveDb();
      return send(res, 201, { user: pub(u), created: true });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const u = byName(body.username);
      if (!u) {
        db.pending = db.pending || {};
        if (db.pending[String(body.username || '').toLowerCase().trim()]) {
          return send(res, 403, { error: 'pehle Gmail wala code dalke account banao', needVerify: true, username: String(body.username || '').toLowerCase().trim() });
        }
        return send(res, 401, { error: 'galat username/password' });
      }
      if (u.passwordHash !== hash(body.password || '')) return send(res, 401, { error: 'galat username/password' });
      if (u.blocked) return send(res, 403, { error: 'account blocked hai' });
      if (u.email && !u.emailVerified) return send(res, 403, { error: 'pehle email verify karo', needVerify: true, username: u.username });
      u.lastLoginAt = Date.now(); await saveDb();
      // Message-request system ke liye: kaunsi chats accept ho chuki hain aur
      // kaun blocked hai — app ko login par hi mil jata hai (purane records par
      // ye fields na ho to khali array).
      return send(res, 200, { user: pub(u),
        acceptedChats: Array.isArray(u.acceptedChats) ? u.acceptedChats : [],
        blockedUsers: Array.isArray(u.blockedUsers) ? u.blockedUsers : [],
        note: typeof u.note === 'string' ? u.note : '', noteAt: typeof u.noteAt === 'number' ? u.noteAt : 0 });
    }
    if (p === '/api/users' && req.method === 'GET') {
      return send(res, 200, { users: db.users.filter(u => !u.blocked).map(pub) });
    }
    if (p === '/api/profile' && req.method === 'POST') {
      // Profile update: sirf wahi fields badlo jo body me bheje gaye hain
      // (name / bio / avatar). Avatar data URL ho sakta hai — ~700KB tak ki
      // string allow hai, usse badi reject (400). pub() me name/bio/avatar
      // pehle se shamil hain, to response me updated profile turant dikhta hai.
      const u = byName(body.username);
      if (!u) return send(res, 404, { error: 'user nahi mila' });
      if (body.avatar !== undefined) {
        if (typeof body.avatar !== 'string' || body.avatar.length > 700 * 1024) {
          return send(res, 400, { error: 'avatar bahut bada hai (max ~700KB)' });
        }
      }
      if (body.name !== undefined) u.name = String(body.name);
      if (body.bio !== undefined) u.bio = String(body.bio);
      if (body.avatar !== undefined) u.avatar = body.avatar;
      await saveDb();
      return send(res, 200, { ok: true, user: pub(u) });
    }
    if (p === '/api/note' && req.method === 'POST') {
      const u = byName(body.username);
      if (!u) return send(res, 404, { error: 'user nahi mila' });
      const nt = String(body.note || '').trim().slice(0, 60);
      u.note = nt; u.noteAt = nt ? Date.now() : 0;
      await saveDb();
      return send(res, 200, { ok: true, note: u.note, noteAt: u.noteAt });
    }
    if (p === '/api/presence' && req.method === 'POST') {
      // Presence heartbeat: app khula hai to har kuch second me ping aata
      // hai — lastSeen update hota hai, jisse DM list me "online" sirf unhi
      // ko dikhe jo sach me abhi app me hain. DB write bachane ke liye
      // saveDb sirf tab hota hai jab pichhla lastSeen 30 second se purana
      // ho; warna sirf memory update karke ok bhej dete hain.
      const u = byName(body.username);
      if (!u) return send(res, 404, { error: 'user nahi mila' });
      const now = Date.now();
      const prev = typeof u.lastSeen === 'number' ? u.lastSeen : 0;
      u.lastSeen = now;
      if (now - prev > 30 * 1000) await saveDb();
      return send(res, 200, { ok: true, lastSeen: u.lastSeen });
    }
    if (p === '/api/stories' && req.method === 'POST') {
      // Story lagana: 24 ghante tak rehti hai. Image string chahiye
      // (data URL, ~1.5MB tak). views me dekhene walon ke username jama hote hain.
      const me = byName(body.username);
      if (!me) return send(res, 404, { error: 'user nahi mila' });
      const hasVideo = typeof body.video === 'string' && body.video.startsWith('data:video');
      if (!hasVideo && (typeof body.image !== 'string' || !body.image || body.image.length > 1.5 * 1024 * 1024)) {
        return send(res, 400, { error: 'story image chahiye (max ~1.5MB)' });
      }
      db.stories = db.stories || [];
      const story = { id: db.seq++, username: me.username, image: hasVideo ? '' : body.image,
        caption: body.caption ? String(body.caption) : '', at: Date.now(), views: [], likes: [] };
      if (typeof body.song === 'string' && body.song.startsWith('http') && body.song.length < 400) story.song = body.song;
      if (hasVideo) {
        // Story video bhi Telegram par — blob me nahi. Fail ho to chhota
        // (<6MB) blob me, warna reject.
        const b64 = body.video.split(',')[1] || '';
        const buf = Buffer.from(b64, 'base64');
        let fid = null;
        if (buf.length > 0 && buf.length < 49 * 1024 * 1024) {
          try { fid = await tgUploadVideo(buf, '@' + me.username + ' ki story'); } catch (e) { fid = null; }
        }
        if (fid) { story.telegramFileId = fid; story.tgKind = 'video'; }
        else if (body.video.length <= 6 * 1024 * 1024) { story.video = body.video; }
        else return send(res, 400, { error: 'Story video bahut bada hai — chhoti video try karo' });
      }
      db.stories.push(story);
      await saveDb();
      return send(res, 201, { ok: true, story });
    }
    if (p === '/api/admin/import-gods' && req.method === 'POST') {
      // Bhagwan (Wikimedia) seed photos ko Telegram par copy karo — Wikimedia
      // seedha hotlink par 429 deta hai, isliye app me photo nahi khulti thi.
      // Ek call me max 6; bache hue ke liye dobara call karo (idempotent).
      if (!isAdmin) return send(res, 401, { error: 'admin key galat' });
      const gods = db.posts.filter(x => x.image && x.image.indexOf('wikimedia') >= 0 && !x.telegramFileId);
      let done = 0;
      for (const post of gods.slice(0, 6)) {
        const cleanUrl = post.image.split('?')[0];
        const j = await tgCall('sendPhoto', { chat_id: TG_CHAT, photo: cleanUrl, caption: '🙏 GramWasi bhagwan photo — ' + (post.caption || '') });
        const ph = j && j.result && j.result.photo;
        if (ph) { post.telegramFileId = ph[ph.length - 1].file_id; post.image = ''; done++; }
      }
      if (done) await saveDb();
      return send(res, 200, { ok: true, done, remaining: gods.length - done });
    }
    if (p === '/api/owner/rename' && req.method === 'POST') {
      const by = byName(body.by);
      if (!isOwnerUser(by)) return send(res, 403, { error: 'ye power sirf owner account ke paas hai' });
      const t = byName(body.target);
      const nm = String(body.name || '').trim().slice(0, 40);
      if (!t || !nm) return send(res, 400, { error: 'target ya naam galat hai' });
      t.name = nm; await saveDb();
      return send(res, 200, { ok: true, user: pub(t) });
    }
    if (p === '/api/owner/verify' && req.method === 'POST') {
      const by = byName(body.by);
      if (!isOwnerUser(by)) return send(res, 403, { error: 'ye power sirf owner account ke paas hai' });
      const t = byName(body.target);
      if (!t) return send(res, 404, { error: 'user nahi mila' });
      t.verified = !!body.verified; await saveDb();
      return send(res, 200, { ok: true, user: pub(t) });
    }
    if (p === '/api/owner/delete-post' && req.method === 'POST') {
      const by = byName(body.by);
      if (!isOwnerUser(by)) return send(res, 403, { error: 'ye power sirf owner account ke paas hai' });
      const idx = db.posts.findIndex(x => String(x.id) === String(body.postId));
      if (idx < 0) return send(res, 404, { error: 'post nahi mila' });
      db.posts.splice(idx, 1); await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stories' && req.method === 'GET') {
      // Sirf pichhle 24 ghante ki stories, user ke hisaab se group karke —
      // sabse nayi story wala group sabse upar. Expire ho chuki stories
      // is read par db se hata bhi dete hain (aur kuch hata to save).
      db.stories = db.stories || [];
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const before = db.stories.length;
      db.stories = db.stories.filter(s => s && typeof s.at === 'number' && s.at > cutoff);
      if (db.stories.length !== before) await saveDb();
      const byUser = {};
      db.stories.forEach(s => {
        if (!byUser[s.username]) byUser[s.username] = [];
        byUser[s.username].push({ id: s.id, image: s.image, caption: s.caption || '', at: s.at, views: s.views || [], likes: Array.isArray(s.likes) ? s.likes : [], video: s.telegramFileId ? '/api/media?postId=' + s.id : (s.video || ''), song: s.song || '' });
      });
      const groups = Object.keys(byUser).map(username => {
        const items = byUser[username].slice().sort((a, b) => a.at - b.at);
        return { username, items, latest: items.length ? items[items.length - 1].at : 0 };
      }).sort((a, b) => b.latest - a.latest)
        .map(g => ({ username: g.username, items: g.items }));
      return send(res, 200, { ok: true, stories: groups });
    }
    if (p === '/api/stories/view' && req.method === 'POST') {
      // Story dekhi gayi: viewer ka username views me jodo (ek baar hi).
      // Khud ki story dekhne se view nahi badhta.
      db.stories = db.stories || [];
      const story = db.stories.find(s => s.id === Number(body.storyId));
      if (!story) return send(res, 404, { error: 'story nahi mili' });
      const v = byName(body.viewer);
      const viewerName = v ? v.username : String(body.viewer || '').toLowerCase().trim();
      if (!viewerName) return send(res, 400, { error: 'viewer chahiye' });
      if (!Array.isArray(story.views)) story.views = [];
      if (viewerName !== story.username && story.views.indexOf(viewerName) < 0) {
        story.views.push(viewerName);
        await saveDb();
      }
      return send(res, 200, { ok: true, views: story.views.length });
    }
    if (p === '/api/stories/like' && req.method === 'POST') {
      // Story like toggle: like hai to hat jata hai, nahi hai to lag jata
      // hai. likes me username rehte hain; response me final state + kul
      // count. Khud ki story like karna bhi chalega (koi special case nahi).
      db.stories = db.stories || [];
      const story = db.stories.find(s => s.id === Number(body.storyId));
      if (!story) return send(res, 404, { error: 'story nahi mili' });
      const u = byName(body.username);
      if (!u) return send(res, 404, { error: 'user nahi mila' });
      if (!Array.isArray(story.likes)) story.likes = [];
      const i = story.likes.indexOf(u.username);
      let liked;
      if (i >= 0) { story.likes.splice(i, 1); liked = false; }
      else { story.likes.push(u.username); liked = true; }
      await saveDb();
      return send(res, 200, { ok: true, liked, likes: story.likes.length });
    }
    if (p === '/api/admin/set-owner' && req.method === 'POST') {
      if (!isAdmin) return send(res, 401, { error: 'admin key chahiye' });
      const t = byName(body.username);
      if (!t) return send(res, 404, { error: 'user nahi mila' });
      db.owners = db.owners || [];
      const has = db.owners.indexOf(t.username) >= 0;
      if (body.owner && !has) db.owners.push(t.username);
      if (!body.owner && has) db.owners = db.owners.filter(x => x !== t.username);
      await saveDb();
      return send(res, 200, { ok: true, ownerPower: isOwnerUser(t) });
    }
    if (p === '/api/chat/delete-message' && req.method === 'POST') {
      const idx = db.messages.findIndex(m => m.id === Number(body.messageId));
      if (idx < 0) return send(res, 404, { error: 'message nahi mila' });
      if (db.messages[idx].from !== String(body.from || '') && !isOwnerUser(byName(body.from))) return send(res, 403, { error: 'sirf apna message delete hoga' });
      db.messages.splice(idx, 1); await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/chat/edit-message' && req.method === 'POST') {
      const m = db.messages.find(x => x.id === Number(body.messageId));
      if (!m) return send(res, 404, { error: 'message nahi mila' });
      const editor = byName(body.from);
      const ownerEdit = m.from !== String(body.from || '') && isOwnerUser(editor);
      if (m.from !== String(body.from || '') && !ownerEdit) return send(res, 403, { error: 'sirf apna message edit hoga' });
      const nt = String(body.text || '').trim().slice(0, 1000);
      if (!nt || nt.indexOf('ttt:') === 0 || m.text.indexOf('ttt:') === 0 || m.kind) return send(res, 400, { error: 'ye message edit nahi hoga' });
      m.text = nt; m.edited = true; if (ownerEdit) m.editedBy = editor.username; await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/chat/react' && req.method === 'POST') {
      // Message reaction SIRF owner/official account ke liye hai.
      const by = byName(body.by);
      if (!isOwnerUser(by)) return send(res, 403, { error: 'reaction ki power sirf official account ke paas hai' });
      const m = db.messages.find(x => x.id === Number(body.messageId));
      if (!m) return send(res, 404, { error: 'message nahi mila' });
      const em = String(body.emoji || '');
      if (em && ['❤️','😂','👍','😮','🔥'].indexOf(em) < 0) return send(res, 400, { error: 'emoji allowed nahi' });
      if (em) { m.reaction = em; m.reactionBy = by.username; } else { delete m.reaction; delete m.reactionBy; }
      await saveDb();
      return send(res, 200, { ok: true, reaction: m.reaction || '' });
    }
    if (p === '/api/crown' && req.method === 'POST') {
      // Game series jeetne par Taj: user par 10 minute ke liye crown.
      // Followers/following ko users list (pub) se har jagah dikhega.
      const u = byName(body.username);
      if (!u) return send(res, 404, { error: 'user nahi mila' });
      u.crownUntil = Date.now() + 10 * 60 * 1000;
      await saveDb();
      return send(res, 200, { ok: true, crownUntil: u.crownUntil });
    }
    if (p === '/api/chat/clear-game' && req.method === 'POST') {
      // Naya game shuru hone par purane saare ttt: messages dono taraf se saaf.
      const a = String(body.user || ''), b = String(body.with || '');
      if (!a || !b) return send(res, 400, { error: 'user/with chahiye' });
      db.messages = db.messages || [];
      const before = db.messages.length;
      db.messages = db.messages.filter(m => !(((m.from === a && m.to === b) || (m.from === b && m.to === a)) && typeof m.text === 'string' && m.text.indexOf('ttt:') === 0));
      const removed = before - db.messages.length;
      if (removed) await saveDb();
      return send(res, 200, { ok: true, removed });
    }
    if (p === '/api/keys' && req.method === 'POST') {
      // End-to-end encryption: user ki PUBLIC key server par rakhi jati hai.
      // Private key sirf user ke phone par rehti hai — server (aur Telegram
      // backup) ko sirf encrypted (cipher) message milta hai, asli text kabhi nahi.
      const u = byName(body.username);
      if (!u || typeof body.publicKey !== 'string' || body.publicKey.length > 4000) {
        return send(res, 400, { error: 'bad key' });
      }
      u.publicKey = body.publicKey; await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/follow' && req.method === 'POST') {
      // Do mode: (1) body.action = "follow" | "unfollow" ho to state EXPLICIT
      // set hoti hai — idempotent (pehle se follow hai to follow hi rehta hai,
      // toggle nahi hota; v8 app yahi bhejta hai taaki follow apne aap revert
      // na ho). (2) action na ho to purana TOGGLE behaviour (purane app
      // versions ke liye). Dono taraf ki list saath update hoti hai aur counts
      // pub() me lists ki length se bante hain — hamesha lists se sync.
      // Follow TRANSITION (nahi tha -> ho gaya) par target ko notification.
      // Kuch clients {user, target} naam bhej dete hain — from/to maujud na
      // ho to unhe alias ki tarah le lo. Contract wahi hai, sirf naam ki choot.
      const fromName = body.from || body.user;
      const toName = body.to || body.target;
      if (!fromName || !toName) return send(res, 400, { error: 'from aur to dono chahiye' });
      if (String(fromName).toLowerCase().trim() === String(toName).toLowerCase().trim()) {
        return send(res, 400, { error: 'khud ko follow nahi kar sakte' });
      }
      const me = byName(fromName), other = byName(toName);
      if (!me || !other) return send(res, 404, { error: 'user nahi mila' });
      if (!Array.isArray(me.following)) me.following = [];
      if (!Array.isArray(other.followers)) other.followers = [];
      const wasFollowing = me.following.indexOf(other.username) >= 0;
      let following;
      if (body.action === 'follow') following = true;
      else if (body.action === 'unfollow') following = false;
      else following = !wasFollowing;
      if (following && !wasFollowing) {
        me.following.push(other.username);
        if (other.followers.indexOf(me.username) < 0) other.followers.push(me.username);
        db.notifications = db.notifications || [];
        db.notifications.push({ id: db.seq++, user: other.username, type: 'follow',
          from: me.username, createdAt: Date.now(), read: false });
      } else if (!following && wasFollowing) {
        me.following.splice(me.following.indexOf(other.username), 1);
        const j = other.followers.indexOf(me.username);
        if (j >= 0) other.followers.splice(j, 1);
      }
      await saveDb();
      return send(res, 200, { ok: true, following, user: pub(other), me: pub(me) });
    }
    if (p === '/api/notifications' && req.method === 'GET') {
      // User ki notifications (abhi follow wali) — sabse nayi pehle, max 100.
      const me = String(url.searchParams.get('user') || '').toLowerCase().trim();
      if (!me) return send(res, 400, { error: 'user chahiye' });
      db.notifications = db.notifications || [];
      const list = db.notifications.filter(n => n.user === me)
        .slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
      return send(res, 200, { ok: true, notifications: list });
    }
    if (p === '/api/notifications/read' && req.method === 'POST') {
      // User ki saari notifications read mark kar do.
      const me = byName(body.user);
      if (!me) return send(res, 404, { error: 'user nahi mila' });
      db.notifications = db.notifications || [];
      db.notifications.forEach(n => { if (n.user === me.username) n.read = true; });
      await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/block-user' && req.method === 'POST') {
      // User-level block (admin wale account-block se alag). blocked explicit
      // boolean ho to wahi set hota hai, na ho to toggle. Block karne par
      // follow DONO taraf se hat jata hai (main use follow nahi karta, wo
      // mujhe nahi karta) aur chat band ho jati hai (send par 403, chat read
      // par khali list, inbox se gayab).
      const me = byName(body.user), other = byName(body.target);
      if (!me || !other) return send(res, 404, { error: 'user nahi mila' });
      if (me.username === other.username) return send(res, 400, { error: 'khud ko block nahi kar sakte' });
      if (!Array.isArray(me.blockedUsers)) me.blockedUsers = [];
      const has = me.blockedUsers.indexOf(other.username) >= 0;
      const blocked = body.blocked === undefined ? !has : !!body.blocked;
      if (blocked && !has) me.blockedUsers.push(other.username);
      if (!blocked && has) me.blockedUsers.splice(me.blockedUsers.indexOf(other.username), 1);
      if (blocked) {
        if (Array.isArray(me.following)) me.following = me.following.filter(n => n !== other.username);
        if (Array.isArray(me.followers)) me.followers = me.followers.filter(n => n !== other.username);
        if (Array.isArray(other.following)) other.following = other.following.filter(n => n !== me.username);
        if (Array.isArray(other.followers)) other.followers = other.followers.filter(n => n !== me.username);
      }
      await saveDb();
      return send(res, 200, { ok: true, blocked });
    }
    if (p === '/api/posts' && req.method === 'GET') {
      await maybeImportTgPhotos();
      const posts = db.posts.slice().reverse().map(serializePost);
      return send(res, 200, { posts });
    }
    if (p === '/api/posts' && req.method === 'POST') {
      const me = byName(body.username);
      if (!me) return send(res, 400, { error: 'user nahi mila' });
      const post = { id: db.seq++, username: me.username, image: body.image || '',
        caption: body.caption || '', likedBy: [], baseLikes: 0, comments: [], createdAt: Date.now() };
      if (body.video) post.video = true;
      // v16: reel ka video data (image field me data:video aata hai) Telegram
      // par store karo — DB blob me bada video nahi rakhenge. Fail ho to
      // chhota video (<8MB) hi blob me rakho, bada reject.
      if (body.video && typeof body.image === 'string' && body.image.startsWith('data:video')) {
        const b64 = body.image.split(',')[1] || '';
        const buf = Buffer.from(b64, 'base64');
        let fid = null;
        if (buf.length > 0 && buf.length < 49 * 1024 * 1024) {
          try { fid = await tgUploadVideo(buf, '@' + me.username + ': ' + (body.caption || 'reel')); } catch (e) { fid = null; }
        }
        if (fid) { post.telegramFileId = fid; post.tgKind = 'video'; post.image = ''; }
        else if (body.image.length > 8 * 1024 * 1024) {
          return send(res, 400, { error: 'Video bahut bada hai — 15MB se chhoti reel try karo' });
        }
      }
      db.posts.push(post); await saveDb();
      await tgStorePostImage(post); // response se PEHLE Telegram storage (Edge Functions par background kaam response ke baad mar jata hai)
      return send(res, 201, { post: serializePost(post) });
    }
    if (p === '/api/posts/like' && req.method === 'POST') {
      // Server-synced like toggle: likedBy me username jodo/hatao; jawab me
      // hamesha computed count (baseLikes + likedBy.length). postId number
      // (asli post) ya "pop*" string (seeded reel) dono chalega.
      const post = db.posts.find(x => String(x.id) === String(body.postId));
      const me = byName(body.username);
      if (!post || !me) return send(res, 404, { error: 'post ya user nahi mila' });
      migratePost(post);
      const i = post.likedBy.indexOf(me.username);
      let liked;
      if (i >= 0) { post.likedBy.splice(i, 1); liked = false; }
      else { post.likedBy.push(me.username); liked = true; }
      await saveDb();
      return send(res, 200, { ok: true, liked, likes: (post.baseLikes || 0) + post.likedBy.length });
    }
    if (p === '/api/posts/comment' && req.method === 'POST') {
      const post = db.posts.find(x => x.id === body.postId);
      const me = byName(body.username);
      if (!post || !me || !body.text) return send(res, 400, { error: 'bad comment' });
      post.comments.push({ username: me.username, text: String(body.text), at: Date.now() });
      await saveDb(); return send(res, 200, { comments: post.comments });
    }
    if (p === '/api/posts/delete' && req.method === 'POST') {
      // Apni post delete: sirf post ka malik hi hata sakta hai.
      const post = db.posts.find(x => String(x.id) === String(body.postId));
      const me = byName(body.username);
      if (!post || !me) return send(res, 404, { error: 'post ya user nahi mila' });
      if (post.username !== me.username) return send(res, 403, { error: 'ye tumhari post nahi hai' });
      db.posts = db.posts.filter(x => x !== post);
      db.reports = (db.reports || []).filter(r => String(r.postId) !== String(post.id));
      await saveDb(); return send(res, 200, { ok: true });
    }
    if (p === '/api/posts/report' && req.method === 'POST') {
      const post = db.posts.find(x => String(x.id) === String(body.postId));
      const me = byName(body.username);
      if (!post || !me) return send(res, 404, { error: 'post ya user nahi mila' });
      if (!Array.isArray(db.reports)) db.reports = [];
      db.reports.push({ id: db.seq++, postId: post.id, postUser: post.username, by: me.username, reason: String(body.reason || 'Other').slice(0, 60), at: Date.now() });
      await saveDb(); return send(res, 200, { ok: true });
    }
    if (p === '/api/chat' && req.method === 'GET') {
      const me = url.searchParams.get('user'), other = url.searchParams.get('with');
      // Maine use block kiya hai to mujhe uski chat khali dikhegi.
      const meU = byName(me), otherU = byName(other);
      if (meU && otherU && (meU.blockedUsers || []).indexOf(otherU.username) >= 0) {
        return send(res, 200, { messages: [] });
      }
      // Maine chat delete (clear) ki hai to us time tak ke message mujhe nahi
      // dikhenge — sirf clear ke BAAD aaye hue dikhenge. Samne wale ko sab
      // dikhta rehta hai (uske apne chatCleared se faisla hota hai).
      const clearedAt = (meU && meU.chatCleared && otherU &&
        typeof meU.chatCleared[otherU.username] === 'number') ? meU.chatCleared[otherU.username] : 0;
      const msgs = db.messages.filter(m => {
        if (!((m.from === me && m.to === other) || (m.from === other && m.to === me))) return false;
        const at = typeof m.at === 'number' ? m.at : (m.createdAt || 0);
        return at > clearedAt;
      });
      return send(res, 200, { messages: msgs });
    }
    if (p === '/api/chat/accept' && req.method === 'POST') {
      // Message request accept: partner ko meri acceptedChats me jodo —
      // uski chat ab Requests se main inbox me chali jayegi.
      const me = byName(body.user), other = byName(body.with);
      if (!me || !other) return send(res, 400, { error: 'user aur with dono chahiye' });
      if (!Array.isArray(me.acceptedChats)) me.acceptedChats = [];
      if (me.acceptedChats.indexOf(other.username) < 0) me.acceptedChats.push(other.username);
      await saveDb();
      return send(res, 200, { ok: true, acceptedChats: me.acceptedChats });
    }
    if (p === '/api/chat/inbox' && req.method === 'GET') {
      // Har partner ke saath ek conversation summary — sabse recent chat
      // sabse upar (lastAt DESC). Blocked partner bilkul nahi dikhte.
      // lastText sirf plaintext ka snippet hai; encrypted (enc) message ka
      // text server par hota hi nahi, isliye null.
      const me = byName(url.searchParams.get('user'));
      if (!me) return send(res, 404, { error: 'user nahi mila' });
      const blockedList = me.blockedUsers || [];
      const myFollowing = me.following || [];
      const convos = {};
      db.messages.forEach(m => {
        let partner = null;
        if (m.from === me.username) partner = m.to;
        else if (m.to === me.username) partner = m.from;
        if (!partner || partner === me.username) return;
        if (blockedList.indexOf(partner) >= 0) return;
        // Chat clear ki hai to us time tak ke message is summary me bilkul
        // nahi gine jayenge — koi message bacha hi nahi to conversation
        // entry bhi nahi banegi (inbox se gayab).
        const at = typeof m.at === 'number' ? m.at : (m.createdAt || 0);
        const clearedAt = (me.chatCleared && typeof me.chatCleared[partner] === 'number') ? me.chatCleared[partner] : 0;
        if (at <= clearedAt) return;
        const c = convos[partner] || (convos[partner] = { with: partner, lastAt: 0,
          lastFrom: null, lastKind: 'text', lastText: null, unread: 0,
          hasSent: false, iFollow: myFollowing.indexOf(partner) >= 0 });
        if (m.from === me.username) c.hasSent = true;
        if (m.to === me.username && m.read !== true) c.unread++;
        if (at >= c.lastAt) {
          c.lastAt = at; c.lastFrom = m.from;
          if (m.enc) { c.lastKind = 'enc'; c.lastText = null; }
          else if (m.kind === 'image') { c.lastKind = 'image'; c.lastText = '📷 Photo'; }
          else if (m.kind === 'voice') { c.lastKind = 'voice'; c.lastText = '🎤 Voice message'; }
          else if (String(m.text || '').startsWith('postshare:')) { c.lastKind = 'text'; c.lastText = '📸 Post share kiya'; }
          else if (String(m.text || '').startsWith('profile:')) { c.lastKind = 'text'; c.lastText = '👤 Profile share kiya'; }
          else if (String(m.text || '').startsWith('call:')) { c.lastKind = 'text'; c.lastText = '📞 Call'; }
          else if (String(m.text || '').startsWith('voice:')) { c.lastKind = 'voice'; c.lastText = String(m.text).slice(0, 80); }
          else { c.lastKind = 'text'; c.lastText = String(m.text || '').slice(0, 80); }
        }
      });
      const conversations = Object.keys(convos).map(k => convos[k]).sort((a, b) => b.lastAt - a.lastAt);
      return send(res, 200, { ok: true, conversations });
    }
    if (p === '/api/chat/unread' && req.method === 'GET') {
      // Har partner ke kitne message unread hain (badge count ke liye).
      // Apne bheje hue message khud ke liye kabhi unread nahi hote — sirf
      // to===user wale gine jate hain.
      const me = String(url.searchParams.get('user') || '').toLowerCase().trim();
      if (!me) return send(res, 400, { error: 'user chahiye' });
      const meU = byName(me);
      const clearedMap = (meU && meU.chatCleared) || {};
      const counts = {};
      let total = 0;
      db.messages.forEach(m => {
        if (m.to !== me || m.read === true) return;
        // Chat clear ke pehle ke message unread badge me nahi gine jayenge.
        const at = typeof m.at === 'number' ? m.at : (m.createdAt || 0);
        const clearedAt = typeof clearedMap[m.from] === 'number' ? clearedMap[m.from] : 0;
        if (at <= clearedAt) return;
        counts[m.from] = (counts[m.from] || 0) + 1; total++;
      });
      return send(res, 200, { ok: true, counts, total });
    }
    if (p === '/api/chat/read' && req.method === 'POST') {
      // Ek partner ke saare aaye hue message read mark kar do (chat khulte hi).
      const me = byName(body.user), other = byName(body.with);
      if (!body.user || !body.with || !me || !other) return send(res, 400, { error: 'user aur with dono chahiye' });
      db.messages.forEach(m => {
        if (m.from === other.username && m.to === me.username) m.read = true;
      });
      await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/chat/delete' && req.method === 'POST') {
      // Chat delete (WhatsApp "delete for me" jaisa): sirf MERI taraf se
      // saaf hoti hai. Asli message delete NAHI hote — mere record par
      // chatCleared[partner] = abhi ka time lag jata hai, aur chat / inbox /
      // unread teeno us time tak ke message mere liye chhupa dete hain.
      // Samne wale ko uski poori chat waise ki waisi dikhti rehti hai.
      // Clear ke baad aaya naya message phir se dikhne lagega.
      const me = byName(body.user), other = byName(body.with);
      if (!body.user || !body.with || !me || !other) return send(res, 400, { error: 'user aur with dono chahiye' });
      if (!me.chatCleared || typeof me.chatCleared !== 'object') me.chatCleared = {};
      me.chatCleared[other.username] = Date.now();
      await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/app-version' && req.method === 'GET') {
      // Force update: app is endpoint se latest/min version check karta hai.
      return send(res, 200, { ok: true, latest: 33, min: 33,
        apkUrl: 'https://raw.githubusercontent.com/sagargramwasi/gramwasi-server/main/GramWasi.apk',
        notes: 'Version 1.6 — Shorts fix, call permission fix, smooth reels.' });
    }
    if (p === '/api/account/delete' && req.method === 'POST') {
      // Play Store policy: user apna account + data khud delete kar sake.
      const me = byName(body.username);
      if (!me) return send(res, 404, { error: 'user nahi mila' });
      if (!body.password || hash(String(body.password)) !== me.passwordHash) {
        return send(res, 401, { error: 'password galat hai' });
      }
      const un = me.username;
      db.users = db.users.filter(u => u.username !== un);
      db.posts = db.posts.filter(x => x.username !== un);
      db.stories = (db.stories || []).filter(x => x.username !== un);
      db.messages = db.messages.filter(m => m.from !== un && m.to !== un);
      db.notifications = (db.notifications || []).filter(n => n.from !== un && n.to !== un);
      db.users.forEach(u => {
        if (Array.isArray(u.followers)) u.followers = u.followers.filter(x => x !== un);
        if (Array.isArray(u.following)) u.following = u.following.filter(x => x !== un);
        if (Array.isArray(u.blockedUsers)) u.blockedUsers = u.blockedUsers.filter(x => x !== un);
        if (Array.isArray(u.acceptedChats)) u.acceptedChats = u.acceptedChats.filter(x => x !== un);
      });
      db.posts.forEach(x => { if (Array.isArray(x.likedBy)) x.likedBy = x.likedBy.filter(v => v !== un); });
      await saveDb();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/chat/send' && req.method === 'POST') {
      const from = byName(body.from), to = byName(body.to);
      const hasText = !!(body.text && String(body.text).trim());
      const hasImg = typeof body.image === 'string' && body.image.indexOf('data:image') === 0;
      const hasAud = typeof body.audio === 'string' && body.audio.indexOf('data:audio') === 0;
      if (!from || !to || (!hasText && !hasImg && !hasAud)) return send(res, 400, { error: 'bad message' });
      // Kisi ek taraf se bhi block hai to message nahi jayega.
      if ((from.blockedUsers || []).indexOf(to.username) >= 0 ||
          (to.blockedUsers || []).indexOf(from.username) >= 0) {
        return send(res, 403, { error: 'blocked' });
      }
      const m = { id: db.seq++, from: from.username, to: to.username, text: hasText ? String(body.text) : (hasImg ? '📷 Photo' : '🎤 Voice message'), at: Date.now(), read: false };
      if (body.enc) m.enc = true; // E2EE payload hai — inbox me kind 'enc' dikhega, text snippet nahi
      if (hasImg) {
        try {
          const b64 = body.image.split(',')[1] || '';
          const buf = Buffer.from(b64, 'base64');
          if (buf.length > 9 * 1024 * 1024) return send(res, 400, { error: 'photo bahut badi hai' });
          const fid = await tgUploadPhoto(buf, '💬 ' + from.username + ' → ' + to.username + ' (chat photo)');
          m.kind = 'image';
          if (fid) m.telegramFileId = fid; else if (buf.length < 5 * 1024 * 1024) m.imageData = body.image;
          else return send(res, 502, { error: 'photo upload fail — dobara try karo' });
        } catch (e) { return send(res, 400, { error: 'photo samajh nahi aayi' }); }
      }
      if (hasAud) {
        try {
          const b64 = body.audio.split(',')[1] || '';
          const buf = Buffer.from(b64, 'base64');
          if (buf.length > 4 * 1024 * 1024) return send(res, 400, { error: 'voice note bahut lamba hai' });
          const am = body.audio.match(/^data:([^;,]+)/); const amime = am ? am[1] : 'audio/webm';
          const aext = amime.indexOf('mp4') >= 0 ? 'm4a' : (amime.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
          const fid = await tgUploadVoice(buf, '💬 ' + from.username + ' → ' + to.username + ' (voice)', aext, amime);
          m.kind = 'voice';
          m.audioDur = Math.max(0, Math.min(600, Number(body.audioDur) || 0));
          if (fid) m.telegramFileId = fid; else if (buf.length < 3 * 1024 * 1024) m.audioData = body.audio;
          else return send(res, 502, { error: 'voice upload fail — dobara try karo' });
        } catch (e) { return send(res, 400, { error: 'voice samajh nahi aaya' }); }
      }
      db.messages.push(m); await saveDb();
      try { await tgMirrorMessage(m); } catch (e) { /* Telegram fail ho to bhi chat send fail nahi hoga */ } // Telegram par backup copy (free storage)
      return send(res, 201, { message: m });
    }
    // ===== v1.5: WebRTC call signaling =====
    // Signals db.signals me rehte hain (chat ki tarah db-backed, isliye
    // multiple Edge Function instances par bhi reliable) lekin chat se alag:
    // poll ka payload sirf signals hota hai (poori chat history nahi uthti),
    // 120s TTL par purane signals prune ho jate hain, aur koi signal kabhi
    // chat bubble / Telegram mirror me nahi jata.
    if (p === '/api/call/signal' && req.method === 'POST') {
      const from = byName(body.from), to = byName(body.to);
      if (!from || !to) return send(res, 400, { error: 'from/to galat hai' });
      let payload = body.payload;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { return send(res, 400, { error: 'payload JSON nahi hai' }); } }
      if (!payload || typeof payload !== 'object' || !payload.t || !payload.callid) {
        return send(res, 400, { error: 'payload me t aur callid chahiye' });
      }
      if (JSON.stringify(payload).length > 12000) return send(res, 413, { error: 'payload bahut bada hai' });
      if (!Array.isArray(db.signals)) db.signals = [];
      const cutS = Date.now() - 120000;
      db.signals = db.signals.filter(x => x && typeof x.at === 'number' && x.at >= cutS);
      const sig = { id: db.seq++, from: from.username, to: to.username, payload, at: Date.now() };
      db.signals.push(sig);
      if (db.signals.length > 200) db.signals = db.signals.slice(-200);
      await saveDb();
      return send(res, 201, { ok: true, signal: sig });
    }
    if (p === '/api/call/signals' && req.method === 'GET') {
      const me = String(url.searchParams.get('user') || '').toLowerCase().trim();
      const other = String(url.searchParams.get('with') || '').toLowerCase().trim();
      const since = Number(url.searchParams.get('since') || 0) || 0;
      if (!me) return send(res, 400, { error: 'user chahiye' });
      if (!Array.isArray(db.signals)) db.signals = [];
      const cutS = Date.now() - 120000;
      const list = db.signals.filter(x => x && typeof x.at === 'number' && x.at >= cutS && x.id > since &&
        (other ? ((x.from === me && x.to === other) || (x.from === other && x.to === me)) : x.to === me));
      return send(res, 200, { ok: true, signals: list });
    }
    // Admin endpoints
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin) return send(res, 401, { error: 'admin key chahiye' });
      if (p === '/api/admin/stats' && req.method === 'GET') {
        const storyCutoff = Date.now() - 24 * 60 * 60 * 1000;
        return send(res, 200, { users: db.users.length, posts: db.posts.length,
          messages: db.messages.length,
          likes: db.posts.reduce((a, x) => a + postLikesCount(x), 0),
          stories: (db.stories || []).filter(s => s && typeof s.at === 'number' && s.at > storyCutoff).length,
          pendingSignups: Object.keys(db.pending || {}).length });
      }
      if (p === '/api/admin/users' && req.method === 'GET') {
        // Rich user list admin panel ke liye — passwordHash kabhi nahi jata
        // (sirf hash store hota hai, dekhna mumkin hi nahi by design).
        return send(res, 200, { ok: true, users: db.users.map(adminUser) });
      }
      if (p === '/api/admin/reset-password' && req.method === 'POST') {
        // Password DIKHAYA nahi ja sakta (sirf hash hai) — admin ka sahi
        // tareeka yahi hai: user ke liye naya password SET kar do.
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 4) {
          return send(res, 400, { error: 'newPassword kam se kam 4 character ka chahiye' });
        }
        u.passwordHash = hash(body.newPassword);
        await saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/delete-user' && req.method === 'POST') {
        // User ko pura hata do: uske posts, stories, bheje/paaye message,
        // aur dusro ki followers/following lists se uska naam bhi.
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        const un = u.username;
        db.users = db.users.filter(x => x.username !== un);
        db.posts = db.posts.filter(x => x.username !== un);
        db.stories = (db.stories || []).filter(x => x.username !== un);
        db.messages = db.messages.filter(x => x.from !== un && x.to !== un);
        db.users.forEach(x => {
          if (Array.isArray(x.followers)) x.followers = x.followers.filter(n => n !== un);
          if (Array.isArray(x.following)) x.following = x.following.filter(n => n !== un);
        });
        await saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/delete-post' && req.method === 'POST') {
        const idx = db.posts.findIndex(x => x.id === Number(body.postId));
        if (idx < 0) return send(res, 404, { error: 'post nahi mila' });
        db.posts.splice(idx, 1);
        await saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/reports' && req.method === 'GET') {
        const reps = (db.reports || []).slice().reverse().map(r => {
          const post = db.posts.find(x => String(x.id) === String(r.postId));
          return { id: r.id, postId: r.postId, postUser: r.postUser, by: r.by, reason: r.reason, at: r.at,
            postImage: post ? (post.image || '') : '', postCaption: post ? (post.caption || '') : '', postGone: !post };
        });
        return send(res, 200, { ok: true, reports: reps });
      }
      if (p === '/api/admin/dismiss-report' && req.method === 'POST') {
        db.reports = (db.reports || []).filter(r => r.id !== Number(body.reportId));
        await saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/verify' && req.method === 'POST') {
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        u.verified = !!body.verified; await saveDb();
        return send(res, 200, { user: pub(u) });
      }
      if (p === '/api/admin/block' && req.method === 'POST') {
        const u = byName(body.username);
        if (!u) return send(res, 404, { error: 'user nahi mila' });
        u.blocked = !!body.blocked; await saveDb();
        return send(res, 200, { user: pub(u) });
      }
    }
    send(res, 404, { error: 'route nahi mila' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
}

const server = http.createServer(handleRequest);

// ============================================================================
// ===== Fetch adapter: Supabase Edge Function <-> Node-style handleRequest ====
// ============================================================================
// server.js ka res sirf do method use karta hai: writeHead(code, headers)
// aur end([data]) — FakeRes bilkul wahi deta hai (plus completion promise).
// req par: method, url, headers (lowercase object), on('data'/'end'), destroy.

class __GwFakeReq extends __gwEventEmitter {
  constructor(method, url, headers, bodyBuf) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.__bodyBuf = bodyBuf;
    this.__bodySent = false;
  }
  on(event, cb) {
    super.on(event, cb);
    // readBody pehle 'data' phir 'end' listener lagata hai — dono lag jane ke
    // baad (microtask me) buffered body ek chunk me bhej do, phir 'end'.
    if (event === "data" && !this.__bodySent) {
      this.__bodySent = true;
      queueMicrotask(() => {
        if (this.__bodyBuf && this.__bodyBuf.length) {
          this.emit("data", __gwBuffer.from(this.__bodyBuf));
        }
        this.emit("end");
      });
    }
    return this;
  }
  destroy() { /* adapter me socket nahi hota — no-op */ }
}

class __GwFakeRes {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.finished = new Promise((resolve) => { this.__resolveFinished = resolve; });
  }
  writeHead(code, headers) {
    this.statusCode = code;
    if (headers) {
      for (const k of Object.keys(headers)) this.headers[k] = headers[k];
    }
    return this;
  }
  end(data) {
    if (data !== undefined && data !== null) this.chunks.push(data);
    this.__resolveFinished();
  }
  bodyBytes() {
    const parts = this.chunks.map((c) => {
      if (typeof c === "string") return new TextEncoder().encode(c);
      if (c instanceof Uint8Array) return c;
      return new TextEncoder().encode(String(c));
    });
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

// "/functions/v1/<fn-name>" prefix hatao — bacha hua path /api/... ya
// /health hona chahiye. Agar path pehle se /api ya /health se shuru hai
// (local test), use waisa hi rakho.
// Supabase kabhi path "/api/health" jaisa deta hai (function name "api"
// retained) — server health sirf "/" aur "/health" par register karta
// hai, isliye sirf in do exact paths ko map karo; baaki /api/* asli
// routes hain, unhe mat chhuo.
function __gwStripPrefix(pathname) {
  const m = pathname.match(/^\/functions\/v1\/[^/]+(\/.*)?$/);
  let p = m ? (m[1] || "/") : pathname;
  // Production me Supabase gateway function-naam path me rakhta hai, aur app ka
  // base URL bhi /api par khatm hota hai — isliye requests /api/api/<route> bankar
  // aate hain. Doubled prefix ko ek baar collapse karo (zyada se zyada 2 baar).
  for (let i = 0; i < 2; i++) {
    if (p === "/api/api") { p = "/api"; break; }
    if (p.startsWith("/api/api/")) { p = "/api/" + p.slice("/api/api/".length); continue; }
    break;
  }
  if (p === "/api/health") return "/health";
  if (p === "/api" || p === "/api/") return "/";
  return p;
}

async function __gwServeFetch(request) {
  const u = new URL(request.url);
  const path = __gwStripPrefix(u.pathname);
  const headers = {};
  request.headers.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
  const bodyBuf = new Uint8Array(await request.arrayBuffer());
  const req = new __GwFakeReq(request.method, path + u.search, headers, bodyBuf);
  const res = new __GwFakeRes();
  try {
    await handleRequest(req, res);
  } catch (e) {
    // handleRequest khud try/catch karke 500 bhejta hai; ye sirf aakhri jaal hai.
    if (!res.chunks.length) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  }
  await res.finished;
  return new Response(res.bodyBytes(), { status: res.statusCode, headers: res.headers });
}

Deno.serve(__gwServeFetch);
export default __gwServeFetch;
