/* Winter Arc client
 * Private data lives in Supabase behind Auth + Postgres RLS.
 * localStorage is only a local cache/fallback; it is never the source of truth
 * once a user is signed in.
 */
(() => {
  const getConfig = () => window.WINTER_ARC_CONFIG || {};
  const hasConfig = () => {
    const config = getConfig();
    return typeof config.SUPABASE_URL === "string" &&
      config.SUPABASE_URL.startsWith("https://") &&
      !config.SUPABASE_URL.includes("PASTE_") &&
      typeof config.SUPABASE_PUBLISHABLE_KEY === "string" &&
      config.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_") &&
      !config.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");
  };

  let supabase = null;
  let currentUser = null;
  let cloudReady = false;
  const pendingWrites = new Map();

  const localKey = (key) => `winterArc:${key}`;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load Supabase client"));
      document.head.appendChild(s);
    });
  }

  async function initCloud() {
    if (!hasConfig()) return;
    try {
      if (!window.supabase) {
        await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
      }
      const config = getConfig();
      supabase = window.supabase.createClient(
        config.SUPABASE_URL,
        config.SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true
          }
        }
      );

      const { data } = await supabase.auth.getUser();
      currentUser = data?.user || null;
      if (currentUser) {
        await pullCloudState();
      }
      cloudReady = true;
      renderAuthState();
    } catch (error) {
      console.warn("Winter Arc cloud storage unavailable; using local cache.", error);
    }
  }

  async function pullCloudState() {
    if (!supabase || !currentUser) return;

    const { data, error } = await supabase
      .from("user_state")
      .select("state_key,value")
      .eq("user_id", currentUser.id);

    if (error) {
      console.warn("Could not load private state:", error.message);
      return;
    }

    const cloudKeys = new Set();
    for (const row of data || []) {
      cloudKeys.add(row.state_key);
      localStorage.setItem(localKey(row.state_key), String(row.value));
    }

    // Migrate existing local progress once, without overwriting cloud values.
    const localRows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("winterArc:")) continue;
      const stateKey = k.slice("winterArc:".length);
      if (["dark"].includes(stateKey) || cloudKeys.has(stateKey)) continue;
      const raw = localStorage.getItem(k);
      localRows.push({
        user_id: currentUser.id,
        state_key: stateKey,
        value: JSON.stringify(raw)
      });
    }

    if (localRows.length) {
      const { error: migrationError } = await supabase
        .from("user_state")
        .upsert(localRows, { onConflict: "user_id,state_key" });
      if (migrationError) {
        console.warn("Local progress migration failed:", migrationError.message);
      }
    }

    applyStateToPage();
  }

  async function saveState(stateKey, value) {
    localStorage.setItem(localKey(stateKey), String(value));

    if (!supabase || !currentUser) return;

    // Serialize writes per key so rapid slider input cannot race.
    const previous = pendingWrites.get(stateKey) || Promise.resolve();
    const next = previous.then(async () => {
      const { error } = await supabase.from("user_state").upsert(
        {
          user_id: currentUser.id,
          state_key: stateKey,
          value: JSON.stringify(String(value))
        },
        { onConflict: "user_id,state_key" }
      );
      if (error) console.warn("Could not save private state:", error.message);
    });
    pendingWrites.set(stateKey, next.catch(() => {}));
    await next;
  }

  function getState(stateKey) {
    return localStorage.getItem(localKey(stateKey));
  }

  function applyStateToPage() {
    document.querySelectorAll("[data-check]").forEach((el) => {
      const saved = getState(el.dataset.check);
      if (saved !== null) el.checked = saved === "1";
    });

    document.querySelectorAll("[data-range]").forEach((el) => {
      const saved = getState(el.dataset.range);
      if (saved !== null) {
        el.value = saved;
        const out = el.nextElementSibling;
        if (out) out.textContent = el.value + "%";
      }
    });

    document.querySelectorAll("[data-note]").forEach((el) => {
      const saved = getState(el.dataset.note);
      if (saved !== null) el.value = saved;
    });
  }

  function addAuthUI() {
    const topbar = document.querySelector(".topbar");
    if (!topbar || document.getElementById("winter-auth")) return;

    const wrap = document.createElement("div");
    wrap.id = "winter-auth";
    wrap.style.display = "flex";
    wrap.style.gap = "8px";
    wrap.style.alignItems = "center";

    const button = document.createElement("button");
    button.className = "pill";
    button.type = "button";
    button.addEventListener("click", () => {
      if (currentUser) {
        supabase.auth.signOut();
      } else {
        showAuthModal();
      }
    });

    wrap.appendChild(button);
    topbar.prepend(wrap);
    renderAuthState();
  }

  function renderAuthState() {
    const button = document.querySelector("#winter-auth button");
    if (!button) return;
    button.textContent = currentUser
      ? "↪ " + (currentUser.email || "account")
      : hasConfig()
        ? "Sign in"
        : "Cloud setup";
  }

  function showAuthModal() {
    if (!supabase) {
      alert("Add your Supabase project URL and publishable key to supabase-config.js first.");
      return;
    }
    let modal = document.getElementById("winter-auth-modal");
    if (modal) {
      modal.hidden = false;
      return;
    }

    modal = document.createElement("div");
    modal.id = "winter-auth-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:#102e5866;display:grid;place-items:center;padding:20px;";
    modal.innerHTML = `
      <div role="dialog" aria-modal="true" style="width:min(420px,100%);background:#fff9ed;border:1px solid #dec8a8;border-radius:16px;padding:22px;box-shadow:0 20px 60px #102e5840;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
          <div>
            <div style="font:11px var(--mono);color:var(--terracotta);letter-spacing:.1em;">PRIVATE CLOUD</div>
            <h2 style="font:34px var(--hand);color:var(--navy);margin:5px 0;">Your Winter Arc</h2>
          </div>
          <button type="button" data-close style="border:0;background:none;font-size:22px;">×</button>
        </div>
        <p style="font:17px var(--hand);color:var(--muted);">Sign in to sync your progress across devices.</p>
        <form id="winter-auth-form">
          <input required type="email" autocomplete="email" placeholder="Email" name="email">
          <input required type="password" minlength="8" autocomplete="current-password" placeholder="Password (8+ characters)" name="password">
          <button class="button primary" type="submit">Sign in</button>
          <button class="button" type="button" data-signup>Create account</button>
          <small id="winter-auth-message" style="font:13px var(--hand);color:var(--muted);"></small>
        </form>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector("[data-close]").addEventListener("click", () => (modal.hidden = true));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

    const form = modal.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const password = form.password.value;
      const message = modal.querySelector("#winter-auth-message");
      message.textContent = "Signing in…";

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        message.textContent = error.message;
        return;
      }
      currentUser = data.user;
      await pullCloudState();
      modal.hidden = true;
      renderAuthState();
    });

    modal.querySelector("[data-signup]").addEventListener("click", async () => {
      const email = form.email.value.trim();
      const password = form.password.value;
      const message = modal.querySelector("#winter-auth-message");
      if (!email || password.length < 8) {
        message.textContent = "Enter an email and a password with at least 8 characters.";
        return;
      }
      message.textContent = "Creating account…";
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        message.textContent = error.message;
        return;
      }
      if (data.user && data.session) {
        currentUser = data.user;
        await pullCloudState();
        modal.hidden = true;
        renderAuthState();
      } else {
        message.textContent = "Account created. Check your email if confirmation is enabled, then sign in.";
      }
    });
  }

  function bindLocalAndCloudState() {
    document.querySelectorAll("[data-check]").forEach((el) => {
      const key = el.dataset.check;
      el.checked = getState(key) === "1";
      el.addEventListener("change", () => saveState(key, el.checked ? "1" : "0"));
    });

    document.querySelectorAll("[data-range]").forEach((el) => {
      const out = el.nextElementSibling;
      const key = el.dataset.range;
      const saved = getState(key);
      if (saved !== null) el.value = saved;
      if (out) out.textContent = el.value + "%";
      el.addEventListener("input", () => {
        if (out) out.textContent = el.value + "%";
        saveState(key, el.value);
      });
    });

    document.querySelectorAll("[data-note]").forEach((el) => {
      const key = el.dataset.note;
      const saved = getState(key);
      if (saved !== null) el.value = saved;
      el.addEventListener("input", () => saveState(key, el.value));
    });
  }

  function bindTheme() {
    document.querySelectorAll("[data-theme]").forEach((b) =>
      b.addEventListener("click", () => {
        document.body.classList.toggle("dark");
        localStorage.setItem(localKey("dark"), document.body.classList.contains("dark") ? "true" : "false");
      })
    );
    if (getState("dark") === "true") document.body.classList.add("dark");
  }

  async function boot() {
    if (!window.WINTER_ARC_CONFIG) {
      try { await loadScript("supabase-config.js"); } catch (_) {}
    }
    addAuthUI();
    bindTheme();
    bindLocalAndCloudState();
    await initCloud();
    if (currentUser) applyStateToPage();

    if (supabase) {
      supabase.auth.onAuthStateChange(async (_event, session) => {
        currentUser = session?.user || null;
        renderAuthState();
        if (currentUser) await pullCloudState();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
