// ============================================================
// UVShield — app.js
// This file controls everything the app does: getting the
// user's location, fetching live weather/UV data, updating the
// screen, and running the UV Assistant. Comments explain each part.
// ============================================================

(() => {
  "use strict";

  // ---------- APP STATE ----------
  // "state" holds all the data we currently know. Every function
  // reads from or writes to this one object, so there's a single
  // source of truth for what's on screen — and it's also what the
  // UV Assistant reads from when answering live-data questions.
  const state = {
    lat: null,
    lon: null,
    locationName: null,
    current: null,   // { temp, condition, humidity, wind, cloud, uv }
    hourly: null,    // list of { time, uv } for the UV timeline
    hourlyIsLive: false, // true once real hourly API data has loaded
  };

  // ---------- UV RISK CATEGORIES ----------
  // Converts a UV Index number into a risk label + colour, using
  // the standard bands from the World Health Organization.
  function riskFor(uv) {
    if (uv == null || isNaN(uv)) {
      return { label: "—", key: "none", color: "#fff", bg: "rgba(255,255,255,0.2)", protection: "—" };
    }
    if (uv < 3)  return { label: "Low",       key: "low",     color: "#8CE0B0", bg: "var(--risk-low-bg)",     protection: "Minimal protection needed" };
    if (uv < 6)  return { label: "Moderate",  key: "moderate",color: "#F5D98A", bg: "var(--risk-mod-bg)",     protection: "Protection recommended" };
    if (uv < 8)  return { label: "High",      key: "high",    color: "#F7B27E", bg: "var(--risk-high-bg)",    protection: "Protection recommended" };
    if (uv < 11) return { label: "Very High", key: "vhigh",   color: "#F49685", bg: "var(--risk-vhigh-bg)",   protection: "Extra protection needed" };
    return          { label: "Extreme",   key: "extreme", color: "#DDA9EC", bg: "var(--risk-extreme-bg)", protection: "Avoid sun exposure" };
  }

  // Solid hex colours for things that need a real colour value
  // rather than a CSS variable (used for chart bars).
  function riskHex(uv) {
    if (uv == null || isNaN(uv)) return "#9AA5B1";
    if (uv < 3)  return "#34B57A";
    if (uv < 6)  return "#E8B93A";
    if (uv < 8)  return "#F0873A";
    if (uv < 11) return "#E4573D";
    return "#B85FD1";
  }

  // Turns a weather code (a number from the API) into readable text.
  function weatherCodeToText(code) {
    const map = {
      0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
      45: "Fog", 48: "Depositing fog",
      51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
      61: "Light rain", 63: "Rain", 65: "Heavy rain",
      71: "Light snow", 73: "Snow", 75: "Heavy snow",
      80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
      95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
    };
    return map[code] || "—";
  }

  // ---------- SMALL DOM HELPERS ----------
  const $ = (id) => document.getElementById(id);
  const qa = (sel) => document.querySelectorAll(sel);

  function showBanner(msg, isError) {
    const el = $("status-banner");
    el.textContent = msg;
    el.classList.remove("hidden");
    el.classList.toggle("error", !!isError);
  }
  function hideBanner() { $("status-banner").classList.add("hidden"); }

  // ============================================================
  // STEP 1: LOCATION PERMISSION SCREEN
  // ============================================================
  function initPermissionFlow() {
    $("btn-allow-location").addEventListener("click", requestGeolocation);
    $("btn-manual-location").addEventListener("click", () => {
      $("permission-overlay").classList.add("hidden");
      $("manual-overlay").classList.remove("hidden");
    });
    $("btn-back-to-allow").addEventListener("click", () => {
      $("manual-overlay").classList.add("hidden");
      $("permission-overlay").classList.remove("hidden");
    });
    $("btn-manual-submit").addEventListener("click", submitManualLocation);
    $("manual-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitManualLocation();
    });
  }

  // Asks the browser for the device's real GPS/network location.
  // This is the browser's built-in Geolocation API — no coordinates
  // are hard-coded anywhere in this file.
  function requestGeolocation() {
    if (!navigator.geolocation) {
      showManualFallback("Location services aren't available in this browser.");
      return;
    }
    $("permission-status").classList.remove("hidden");
    $("permission-status").textContent = "Detecting your location…";

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Success: we now have the device's actual latitude/longitude.
        state.lat = pos.coords.latitude;
        state.lon = pos.coords.longitude;
        enterApp();
      },
      () => {
        // Denied or failed: fall back to manual entry.
        showManualFallback("Location access is required for personalized UV information.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function showManualFallback(message) {
    $("permission-overlay").classList.add("hidden");
    $("manual-overlay").classList.remove("hidden");
    if (message) {
      const err = $("manual-error");
      err.textContent = message;
      err.classList.remove("hidden");
    }
  }

  // Lets the user type a place name instead of using GPS.
  // Uses Open-Meteo's free geocoding API to turn the name into
  // real coordinates (no API key required).
  async function submitManualLocation() {
    const val = $("manual-input").value.trim();
    const err = $("manual-error");
    if (!val) {
      err.textContent = "Enter a location to continue";
      err.classList.remove("hidden");
      return;
    }
    err.classList.add("hidden");
    $("btn-manual-submit").textContent = "Searching…";
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(val)}&count=1`
      );
      const data = await res.json();
      if (!data.results || !data.results.length) {
        err.textContent = "Location not found. Try a different name.";
        err.classList.remove("hidden");
        $("btn-manual-submit").textContent = "Get UV Information";
        return;
      }
      const r = data.results[0];
      state.lat = r.latitude;
      state.lon = r.longitude;
      state.locationName = [r.name, r.admin1, r.country].filter(Boolean).join(", ");
      enterApp();
    } catch (e) {
      err.textContent = "Couldn't search right now. Check your connection and try again.";
      err.classList.remove("hidden");
      $("btn-manual-submit").textContent = "Get UV Information";
    }
  }

  // ============================================================
  // STEP 2: ENTER THE APP — load data once we have coordinates
  // ============================================================
  function enterApp() {
    $("permission-overlay").classList.add("hidden");
    $("manual-overlay").classList.add("hidden");
    $("app").classList.remove("hidden");
    loadAllData();
  }

  async function loadAllData() {
    hideBanner();
    $("location-name").textContent = "Locating you…";
    try {
      // If we don't already have a place name (e.g. came from GPS,
      // not manual search), look one up from the coordinates.
      if (!state.locationName) {
        state.locationName = await reverseGeocode(state.lat, state.lon);
      }
      $("location-name").textContent = state.locationName;
      $("location-coords").textContent =
        `Latitude: ${state.lat.toFixed(4)}°  ·  Longitude: ${state.lon.toFixed(4)}°`;

      await fetchWeatherAndUV(state.lat, state.lon);
      renderAll();
    } catch (e) {
      showBanner("Live environmental data is temporarily unavailable. Please try again later.", true);
    }
  }

  // Converts coordinates back into a readable place name
  // (this is "reverse" geocoding — coordinates to name).
  async function reverseGeocode(lat, lon) {
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&count=1`
      );
      const data = await res.json();
      if (data.results && data.results.length) {
        const r = data.results[0];
        return [r.name, r.admin1, r.country].filter(Boolean).join(", ");
      }
    } catch (e) { /* fall through to coordinate display below */ }
    return `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
  }

  // Fetches live temperature, humidity, wind, cloud cover and UV
  // Index from Open-Meteo — a free weather API that needs no key.
  async function fetchWeatherAndUV(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,weather_code,uv_index` +
      `&hourly=uv_index&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("weather fetch failed");
    const data = await res.json();

    state.current = {
      temp: Math.round(data.current.temperature_2m),
      condition: weatherCodeToText(data.current.weather_code),
      humidity: Math.round(data.current.relative_humidity_2m),
      wind: Math.round(data.current.wind_speed_10m),
      cloud: Math.round(data.current.cloud_cover),
      uv: data.current.uv_index,
    };

    const times = data.hourly.time;
    const uvs = data.hourly.uv_index;
    state.hourly = times.map((t, i) => ({ time: t, uv: uvs[i] }));
    state.hourlyIsLive = true;
  }

  // ============================================================
  // RENDER: writes state.* values onto the screen
  // ============================================================
  function renderAll() {
    renderHero();
    renderWeather();
    renderTimeline();
    renderSafety($("safety-grid-home"), true);
    renderSafety($("safety-grid-full"), false);
  }

  function renderHero() {
    const uv = state.current.uv;
    const risk = riskFor(uv);
    $("uv-number").textContent = uv != null ? Math.round(uv) : "--";
    const pill = $("uv-risk-pill");
    pill.textContent = `🔴 Risk: ${risk.label}`;
    $("uv-protection").textContent = `Protection: ${risk.protection}`;
    $("uv-updated").textContent = "Updated just now";

    const pct = Math.min(uv / 11, 1);
    const arcLen = 163; // matches the SVG semicircle's path length
    $("uv-arc-fill").setAttribute("stroke-dasharray", `${pct * arcLen} 300`);
    $("uv-arc-fill").style.stroke = riskHex(uv);
  }

  function renderWeather() {
    const c = state.current;
    $("w-temp").textContent = `${c.temp}°C`;
    $("w-condition").textContent = c.condition;
    $("w-humidity").textContent = `${c.humidity}%`;
    $("w-wind").textContent = `${c.wind} km/h`;
    $("w-cloud").textContent = `${c.cloud}%`;
  }

  function renderTimeline() {
    const wrap = $("uv-timeline");
    wrap.innerHTML = "";
    const targets = [8, 10, 12, 14, 16, 18]; // the hours we show on the timeline
    const maxUv = Math.max(...state.hourly.map(h => h.uv), 1);

    targets.forEach((hour) => {
      const entry = state.hourly.find(h => new Date(h.time).getHours() === hour);
      const uv = entry ? entry.uv : null;
      const heightPct = uv != null ? Math.max((uv / Math.max(maxUv, 11)) * 100, 6) : 6;
      const color = uv != null ? riskHex(uv) : "rgba(255,255,255,0.25)";

      const item = document.createElement("div");
      item.className = "tl-item";
      item.innerHTML = `
        <span class="tl-val">${uv != null ? Math.round(uv) : "–"}</span>
        <div class="tl-bar-track"><div class="tl-bar" style="height:${heightPct}%; background:${color};"></div></div>
        <span class="tl-time">${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? "AM" : "PM"}</span>
      `;
      wrap.appendChild(item);
    });

    // Scientific honesty: tell the user plainly whether this timeline
    // is live hourly API data or an illustrative fallback.
    const note = $("peak-uv-note");
    note.textContent = state.hourlyIsLive
      ? "☀️ Peak UV period — based on today's live hourly forecast for your location. UV exposure is generally highest around the middle of the day."
      : "☀️ Illustrative pattern (live hourly data unavailable) — UV exposure is generally highest around the middle of the day.";
  }

  // ---------- SAFETY RECOMMENDATION CARDS ----------
  const SAFETY_ITEMS = [
    { title: "Sunscreen", desc: "Use broad-spectrum sunscreen with an appropriate SPF.", emoji: "🧴" },
    { title: "Sunglasses", desc: "Wear UV-protective sunglasses.", emoji: "🕶️" },
    { title: "Protective clothing", desc: "Cover exposed skin when appropriate.", emoji: "👕" },
    { title: "Seek shade", desc: "Reduce prolonged exposure to direct sunlight.", emoji: "🌳" },
    { title: "Choose safer times", desc: "Plan outdoor activities when UV levels are lower.", emoji: "🕐" },
    { title: "Stay hydrated", desc: "Especially during hot weather and prolonged activity.", emoji: "💧" },
  ];

  function renderSafety(container, limitFour) {
    if (!container) return;
    const uv = state.current ? state.current.uv : 0;
    const risk = riskFor(uv);
    const emphasize = risk.key === "high" || risk.key === "vhigh" || risk.key === "extreme";
    const items = limitFour ? SAFETY_ITEMS.slice(0, 4) : SAFETY_ITEMS;
    container.innerHTML = "";
    items.forEach((it) => {
      const card = document.createElement("div");
      card.className = "safety-card" + (emphasize ? " emphasized" : "");
      card.innerHTML = `
        <span class="safety-emoji">${it.emoji}</span>
        <div class="safety-title">${it.title}</div>
        <div class="safety-desc">${it.desc}</div>
      `;
      container.appendChild(card);
    });
  }

  // ============================================================
  // 🎤 UV ASSISTANT
  // A UVShield-specific assistant (not a general voice assistant).
  // It answers questions using the app's *current* live state —
  // it never makes up a UV/weather number of its own.
  // ============================================================

  let recognition = null;       // the browser's SpeechRecognition object, created once
  let isRecording = false;

  function initAssistant() {
    $("btn-mic").addEventListener("click", toggleVoiceInput);
    $("btn-assistant-send").addEventListener("click", handleTypedSubmit);
    $("assistant-text-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleTypedSubmit();
    });
    qa(".chip").forEach((chip) => {
      chip.addEventListener("click", () => askAssistant(chip.dataset.q));
    });
    setupSpeechRecognition();
  }

  // ---------- SPEECH RECOGNITION (voice input) ----------
  // Uses the browser's built-in Web Speech API. Not every browser
  // supports this, so we check first and fall back to typed input
  // if it's missing — the app must never break because of this.
  function setupSpeechRecognition() {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      $("assistant-mic-note").textContent = "Voice input isn't supported in this browser — you can type your question instead.";
      $("assistant-mic-note").classList.remove("hidden");
      $("btn-mic").disabled = true;
      $("btn-mic").style.opacity = "0.4";
      return;
    }
    recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      $("assistant-text-input").value = transcript;
      askAssistant(transcript);
    };
    recognition.onerror = (event) => {
      stopListeningUI();
      if (event.error === "not-allowed" || event.error === "permission-denied") {
        $("assistant-mic-note").textContent = "Microphone access was denied — you can still type your question below.";
        $("assistant-mic-note").classList.remove("hidden");
      } else {
        $("assistant-mic-note").textContent = "Didn't catch that — try again or type your question.";
        $("assistant-mic-note").classList.remove("hidden");
      }
    };
    recognition.onend = () => stopListeningUI();
  }

  function toggleVoiceInput() {
    if (!recognition) return; // unsupported — button is disabled in this case anyway
    if (isRecording) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
      isRecording = true;
      $("btn-mic").classList.add("recording");
      $("assistant-listening").classList.remove("hidden");
      $("assistant-mic-note").classList.add("hidden");
    } catch (e) {
      // start() throws if called twice in a row too quickly — safe to ignore
    }
  }

  function stopListeningUI() {
    isRecording = false;
    $("btn-mic").classList.remove("recording");
    $("assistant-listening").classList.add("hidden");
  }

  // ---------- TYPED INPUT ----------
  function handleTypedSubmit() {
    const val = $("assistant-text-input").value.trim();
    if (!val) return;
    askAssistant(val);
  }

  // ---------- CONVERSATION TRANSCRIPT ----------
  function addMessage(text, who) {
    const wrap = $("assistant-transcript");
    const empty = wrap.querySelector(".assistant-empty");
    if (empty) empty.remove();

    const bubble = document.createElement("div");
    bubble.className = "msg " + (who === "user" ? "msg-user" : "msg-assistant");
    bubble.textContent = text;
    wrap.appendChild(bubble);
    wrap.scrollTop = wrap.scrollHeight;
  }

  // Runs a question through the assistant: shows it in the
  // transcript, works out an answer from current state, shows the
  // answer, and speaks it aloud if the browser supports that.
  function askAssistant(question) {
    addMessage(question, "user");
    $("assistant-text-input").value = "";
    const answer = answerQuestion(question);
    addMessage(answer, "assistant");
    speak(answer);
  }

  // ---------- SPEECH SYNTHESIS (spoken replies) ----------
  function speak(text) {
    if (!("speechSynthesis" in window)) return; // unsupported — silently skip, text answer is already shown
    try {
      window.speechSynthesis.cancel(); // stop any reply currently being read out
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1;
      utter.pitch = 1;
      window.speechSynthesis.speak(utter);
    } catch (e) { /* speech synthesis is best-effort only */ }
  }

  // ---------- ANSWER ENGINE ----------
  // Matches the question against known intents and answers using
  // state.* (live data) or fixed educational text. Never invents
  // a UV/weather number that isn't already in `state`.
  function answerQuestion(rawQuestion) {
    const q = rawQuestion.toLowerCase();
    const uv = state.current ? state.current.uv : null;
    const risk = riskFor(uv);
    const haveLiveData = state.current != null;

    // No live data at all yet (e.g. API failed) — be upfront about it
    // for any question that needs a live number.
    const needsLiveData = /uv index|uv level|weather|temperature|humid|wind|cloud|safe to go|safe outside|risk/.test(q);
    if (needsLiveData && !haveLiveData) {
      return "I don't have live UV or weather data right now — it may still be loading, or the last request failed. Try the refresh button, then ask again.";
    }

    // --- Current UV Index ---
    if (/uv index|uv level|current uv|what.?s the uv/.test(q)) {
      return `The current UV Index at your location is ${Math.round(uv)}, which is ${risk.label}. ${risk.protection}.`;
    }

    // --- Is it safe to go outside ---
    if (/safe to go|safe outside|go outside|okay to go out/.test(q)) {
      if (risk.key === "low") return `Yes — the UV Index here is ${Math.round(uv)} (Low), so minimal protection is needed for most people.`;
      if (risk.key === "moderate") return `It's reasonably safe with some precautions — the UV Index is ${Math.round(uv)} (Moderate). Protection is recommended during midday hours.`;
      if (risk.key === "high") return `Take care — the UV Index is ${Math.round(uv)} (High). Protection is recommended: shade, sunscreen and sunglasses.`;
      if (risk.key === "vhigh") return `Be cautious — the UV Index is ${Math.round(uv)} (Very High). Extra protection is needed if you're outdoors for long.`;
      if (risk.key === "extreme") return `It's best to avoid prolonged sun exposure right now — the UV Index is ${Math.round(uv)} (Extreme).`;
      return "I don't have a current UV reading to judge that yet.";
    }

    // --- Protection advice ---
    if (/protection|what should i (wear|take|use)|sunscreen|how (do|can) i protect/.test(q)) {
      return `At a UV Index of ${Math.round(uv)} (${risk.label}), recommended protection: ${risk.protection}. In general — seek shade, wear protective clothing, UV-blocking sunglasses, and broad-spectrum sunscreen when UV is Moderate or above.`;
    }

    // --- Weather ---
    if (/weather|temperature|humid|wind|cloud/.test(q)) {
      const c = state.current;
      return `Right now it's ${c.temp}°C and ${c.condition.toLowerCase()}, with ${c.humidity}% humidity, wind at ${c.wind} km/h, and ${c.cloud}% cloud cover.`;
    }

    // --- UV-A / UV-B / UV-C educational ---
    if (/uv-?a\b/.test(q)) {
      return "UV-A has a longer wavelength and reaches Earth's surface in large amounts. It contributes to skin and eye exposure and is associated with premature skin ageing.";
    }
    if (/uv-?b\b/.test(q)) {
      return "UV-B reaches the surface too, is strongly affected by the ozone layer, and is a major contributor to sunburn — it can damage skin and eyes.";
    }
    if (/uv-?c\b/.test(q)) {
      return "UV-C is very energetic and harmful, but natural solar UV-C is essentially absorbed by the atmosphere and ozone layer — it normally doesn't reach Earth's surface.";
    }
    if (/which uv|types of uv|uv types/.test(q)) {
      return "Surface UV exposure mainly involves UV-A and UV-B. The UV Index reflects the sunburn-producing UV reaching the ground — it isn't a direct reading of just one UV type.";
    }

    // --- Ozone ---
    if (/ozone/.test(q)) {
      return "The ozone layer absorbs much of the Sun's harmful ultraviolet radiation — especially UV-B, and essentially all solar UV-C — before it reaches Earth's surface. That's why protecting it matters for human health, skin, eyes, and the environment.";
    }

    // --- UV Index meaning ---
    if (/what is the uv index|what does uv index mean|uv index mean/.test(q)) {
      return "The UV Index is a measure of the sunburn-producing ultraviolet radiation reaching the ground at a location — not a direct reading of one single UV type. Higher numbers mean greater potential for skin and eye damage in a given amount of time outdoors.";
    }

    // --- Location ---
    if (/where am i|my location|current location/.test(q)) {
      return state.locationName ? `You're currently at ${state.locationName}.` : "I don't have your location yet.";
    }

    // Fallback — be honest that the question wasn't understood.
    return "I can answer questions about your current UV Index, weather, UV-A/B/C, ozone, and protection. Could you rephrase that?";
  }

  // ============================================================
  // NAVIGATION between the 5 tabs
  // ============================================================
  function initNav() {
    qa(".tab").forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.view));
    });
    $("link-ozone-teaser").addEventListener("click", () => switchView("ozone"));
    $("link-assistant-teaser").addEventListener("click", () => switchView("assistant"));
    $("btn-refresh").addEventListener("click", refreshData);
  }

  function switchView(name) {
    qa(".view").forEach((v) => v.classList.add("hidden"));
    $(`view-${name}`).classList.remove("hidden");
    qa(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    window.scrollTo({ top: 0 });
  }

  async function refreshData() {
    const btn = $("btn-refresh");
    btn.classList.add("spinning");
    try {
      await fetchWeatherAndUV(state.lat, state.lon);
      renderAll();
      hideBanner();
    } catch (e) {
      showBanner("Live environmental data is temporarily unavailable. Please try again later.", true);
    } finally {
      setTimeout(() => btn.classList.remove("spinning"), 400);
    }
  }

  // ============================================================
  // START
  // ============================================================
  document.addEventListener("DOMContentLoaded", () => {
    initPermissionFlow();
    initNav();
    initAssistant();
  });
})();
