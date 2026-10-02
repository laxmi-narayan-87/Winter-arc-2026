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
  let day1Template = null;
  let day1Record = null;
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
        await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2");
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
        await migrateStructuredContent();
      }
      cloudReady = true;
      window.WINTER_ARC_SUPABASE = supabase;
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
      localStorage.setItem(localKey(row.state_key), typeof row.value === "string" ? row.value : JSON.stringify(row.value));
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
        value: (() => { try { return JSON.parse(raw); } catch (_) { return String(raw); } })()
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
    renderDay1FromCloud();
  }

  async function saveStructuredState(stateKey, value) {
    if (!supabase || !currentUser) return;
    const { error } = await supabase.from("user_state").upsert(
      { user_id: currentUser.id, state_key: stateKey, value },
      { onConflict: "user_id,state_key" }
    );
    if (error) {
      console.warn("Could not save structured private state:", error.message);
      return;
    }
    localStorage.setItem(localKey(stateKey), JSON.stringify(value));
    day1Record = stateKey === "day:2026-10-01" ? value : day1Record;
    await refreshPublicSnapshot();
  }

  const refreshTimers = new Map();

  function schedulePublicRefresh(delay = 700) {
    if (!supabase || !currentUser) return;
    clearTimeout(refreshTimers.get("public"));
    refreshTimers.set("public", setTimeout(() => {
      refreshPublicSnapshot();
    }, delay));
  }

  async function saveState(stateKey, value) {
    localStorage.setItem(localKey(stateKey), String(value));
    if (!supabase || !currentUser) return;

    const previous = pendingWrites.get(stateKey) || Promise.resolve();
    const next = previous.then(async () => {
      const { error } = await supabase.from("user_state").upsert(
        { user_id: currentUser.id, state_key: stateKey, value: JSON.stringify(String(value)) },
        { onConflict: "user_id,state_key" }
      );
      if (error) {
        console.warn("Could not save private state:", error.message);
        return;
      }
      schedulePublicRefresh();
    });
    pendingWrites.set(stateKey, next.catch(() => {}));
    await next;
  }

  function getState(stateKey) {
    return localStorage.getItem(localKey(stateKey));
  }

  function clearLocalUserState() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("winterArc:") && k !== "winterArc:dark") keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  }

  async function loadDay1FromCloud() {
    const card = document.getElementById("day1-card");
    if (!card || !supabase || !currentUser) return;

    const { data: template, error: templateError } = await supabase
      .from("day_templates")
      .select("day_number,day_date,title,tasks")
      .eq("day_number", 1)
      .single();

    if (templateError) {
      card.innerHTML = '<span class="micro">Day 1 · October 1, 2026</span><h2>Day 1 unavailable</h2><p>Could not load the Day 1 template from Supabase.</p>';
      console.warn("Could not load Day 1 template:", templateError.message);
      return;
    }

    const { data: record, error: recordError } = await supabase
      .from("user_state")
      .select("value")
      .eq("state_key", "day:2026-10-01")
      .maybeSingle();

    if (recordError) {
      console.warn("Could not load Day 1 completion:", recordError.message);
    }

    day1Template = template;
    day1Record = record?.value || null;
    renderDay1FromCloud();
  }

  function renderDay1FromCloud() {
    const card = document.getElementById("day1-card");
    if (!card || !day1Template) return;

    const tasks = Array.isArray(day1Template.tasks) ? day1Template.tasks : [];
    const completedIds = new Set(
      Array.isArray(day1Record?.completed_task_ids) ? day1Record.completed_task_ids : []
    );
    const completed = tasks.filter((task) => completedIds.has(task.id)).length;

    card.innerHTML = '<span class="micro">Day 1 · October 1, 2026</span><h2>' +
      completed + ' / ' + tasks.length + ' complete ' + (completed === tasks.length && tasks.length ? '✓' : '') +
      '</h2><div class="list"></div>' +
      (day1Record ? '' : '<button class="button primary" type="button" data-sync-day1>Sync completed Day 1</button>');

    const list = card.querySelector(".list");
    tasks.forEach((task) => {
      const row = document.createElement("label");
      row.className = "row";
      const input = document.createElement("input");
      input.className = "check";
      input.type = "checkbox";
      input.checked = completedIds.has(task.id);
      input.disabled = true;
      const copy = document.createElement("span");
      copy.className = "copy";
      const title = document.createElement("b");
      title.textContent = task.title || "Task";
      const detail = document.createElement("small");
      detail.textContent = task.detail || "";
      copy.append(title, detail);
      row.append(input, copy);
      list.append(row);
    });

    const sync = card.querySelector("[data-sync-day1]");
    if (sync) {
      sync.addEventListener("click", async () => {
        const completedTaskIds = tasks.map((task) => task.id);
        await saveStructuredState("day:2026-10-01", {
          date: "2026-10-01",
          day: 1,
          status: "complete",
          completed_task_ids: completedTaskIds,
          completed_at: new Date().toISOString()
        });
        await loadDay1FromCloud();
      });
    }
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
    button.addEventListener("click", async () => {
      if (currentUser) {
        await supabase.auth.signOut();
        currentUser = null;
        clearLocalUserState();
        applyStateToPage();
        renderAuthState();
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

      const previousUserId = currentUser?.id || null;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        message.textContent = error.message;
        return;
      }
      currentUser = data.user;
      if (previousUserId && previousUserId !== currentUser.id) clearLocalUserState();
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
    if (currentUser) { applyStateToPage(); await loadDay1FromCloud(); }

    if (supabase) {
      supabase.auth.onAuthStateChange(async (_event, session) => {
        const nextUser = session?.user || null;
        if (!nextUser && currentUser) {
          clearLocalUserState();
          applyStateToPage();
        }
        currentUser = nextUser;
        renderAuthState();
        if (currentUser) { await pullCloudState(); await migrateStructuredContent(); }
        if (currentUser) await loadDay1FromCloud();
      });
    }
  }

  async function getPublicShare() {
    if (!supabase || !currentUser) return null;
    const { data, error } = await supabase.from("public_shares").select("*").eq("user_id", currentUser.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getStructuredRows(table, select = "*", order = null) {
    if (!supabase || !currentUser) throw new Error("Sign in first.");
    let query = supabase.from(table).select(select).eq("user_id", currentUser.id);
    if (order) query = query.order(order.column, { ascending: order.ascending !== false });
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function insertStructuredRow(table, row) {
    if (!supabase || !currentUser) throw new Error("Sign in first.");
    const { data, error } = await supabase.from(table).insert({ ...row, user_id: currentUser.id }).select().single();
    if (error) throw error;
    schedulePublicRefresh(100);
    return data;
  }

  async function updateStructuredRow(table, id, row) {
    if (!supabase || !currentUser) throw new Error("Sign in first.");
    const { data, error } = await supabase.from(table).update(row).eq("id", id).eq("user_id", currentUser.id).select().single();
    if (error) throw error;
    schedulePublicRefresh(100);
    return data;
  }

  async function deleteStructuredRow(table, id) {
    if (!supabase || !currentUser) throw new Error("Sign in first.");
    const { error } = await supabase.from(table).delete().eq("id", id).eq("user_id", currentUser.id);
    if (error) throw error;
    schedulePublicRefresh(100);
  }

  async function migrateStructuredContent() {
    if (!supabase || !currentUser) return;
    try {
      const [{data: skills},{data: projects},{data: milestones},{data: learning},{data: timeline}] = await Promise.all([
        supabase.from("skills").select("id").eq("user_id", currentUser.id).limit(1),
        supabase.from("projects").select("id").eq("user_id", currentUser.id).limit(1),
        supabase.from("milestones").select("id").eq("user_id", currentUser.id).limit(1),
        supabase.from("learning_entries").select("id").eq("user_id", currentUser.id).limit(1),
        supabase.from("timeline_entries").select("id").eq("user_id", currentUser.id).limit(1)
      ]);
      if (!(skills||[]).length) {
        const skillSeed=[["Python",82],["AI / ML",76],["Backend",68],["System design",58]];
        await supabase.from("skills").insert(skillSeed.map(([name,level])=>({user_id:currentUser.id,name,level})));
      }
      if (!(projects||[]).length) {
        await supabase.from("projects").insert([
          {user_id:currentUser.id,name:"DarkSense AI",description:"Dark-pattern detection through browser automation, data collection, screenshots, and machine learning.",status:"in_progress",progress:72},
          {user_id:currentUser.id,name:"Portfolio",description:"A living record of projects, experiments, skills, and work worth showing.",status:"in_progress",progress:54}
        ]);
      }
      if (!(milestones||[]).length) {
        await supabase.from("milestones").insert([
          {user_id:currentUser.id,name:"First meaningful build",description:"Something exists outside your notes."},
          {user_id:currentUser.id,name:"Ship it",description:"Put a finished version in front of someone."},
          {user_id:currentUser.id,name:"Survive a hard week",description:"Keep the minimum viable routine alive."},
          {user_id:currentUser.id,name:"Season review",description:"Look back and decide what comes next."}
        ]);
      }
      if (!(learning||[]).length) {
        await supabase.from("learning_entries").insert([
          {user_id:currentUser.id,topic:"System design",note:"Queues, caching, databases, APIs, reliability."},
          {user_id:currentUser.id,topic:"Machine learning",note:"Transformers, evaluation, data pipelines."},
          {user_id:currentUser.id,topic:"Testing & automation",note:"Selenium, test strategy, reliable automation."}
        ]);
      }
      if (!(timeline||[]).length) {
        await supabase.from("timeline_entries").insert([
          {user_id:currentUser.id,title:"Begin with intention",description:"Decide what this season is for before filling it with tasks.",status:"done"},
          {user_id:currentUser.id,title:"Build a rhythm",description:"Turn small actions into routines that can survive ordinary days.",status:"done"},
          {user_id:currentUser.id,title:"Make something real",description:"Ship a project, finish a course, publish an idea, or create evidence of progress.",status:"planned"},
          {user_id:currentUser.id,title:"Review and adjust",description:"Keep what works. Change what does not.",status:"planned"}
        ]);
      }
    } catch (error) {
      console.warn("Structured content migration skipped:", error.message);
    }
  }

  async function buildPublicSnapshot(settings) {
    if (!supabase || !currentUser) throw new Error("Sign in first.");
    const safe = {
      progress:true, streak:true, today_progress:false, daily_tasks:false, projects:false, skills:false,
      milestones:false, learning:false, timeline:false, fitness:false, notes:false,
      ...(settings || {})
    };
    const { data: rows, error } = await supabase.from("user_state").select("state_key,value").eq("user_id", currentUser.id);
    if (error) throw error;
    const state = Object.fromEntries((rows || []).map(r => [r.state_key, r.value]));
    const { data: templates, error: te } = await supabase.from("day_templates").select("day_number,day_date,title,tasks").order("day_number");
    if (te) throw te;
    const days=(templates||[]).map(t=>{
      const record=state["day:"+t.day_date]||{};
      const ids=Array.isArray(record.completed_task_ids)?record.completed_task_ids:[];
      const tasks=Array.isArray(t.tasks)?t.tasks:[];
      return {day:t.day_number,date:t.day_date,title:t.title,completed:ids.filter(id=>tasks.some(x=>x.id===id)).length,total:tasks.length,complete:tasks.length>0&&ids.length>=tasks.length,...(safe.daily_tasks?{tasks:tasks.map(x=>({title:x.title||"Task",detail:x.detail||"",complete:ids.includes(x.id)}))}:{})};
    });
    const completedDays=days.filter(d=>d.complete).length,totalTasks=days.reduce((n,d)=>n+d.total,0),completedTasks=days.reduce((n,d)=>n+d.completed,0);
    let streak=0; for(let i=days.length-1;i>=0;i--){if(!days[i].complete)break;streak++;}
    const snap={version:2,generated_at:new Date().toISOString()};
    if(safe.progress) snap.progress={days_completed:completedDays,days_total:days.length,tasks_completed:completedTasks,tasks_total:totalTasks,completion_rate:totalTasks?Math.round(completedTasks/totalTasks*100):0};
    if(safe.streak) snap.streak={current:streak};
    if(safe.today_progress){
      const todayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const today=days.find(d=>d.date===todayKey);
      if(today) snap.today={day:today.day,date:today.date,title:today.title,completed:today.completed,total:today.total,complete:today.complete,tasks:Array.isArray(today.tasks)?today.tasks:tasksForToday(templates,state,todayKey)};
    }
    if(safe.daily_tasks) snap.days=days;
    if(safe.notes && typeof state.todayNote==="string") snap.note=state.todayNote;
    if(safe.projects) snap.projects=await getStructuredRows("projects","id,name,description,status,progress,url",{column:"created_at",ascending:false});
    if(safe.skills) snap.skills=(await getStructuredRows("skills","id,name,level,evidence",{column:"name"})).map(x=>({name:x.name,level:x.level,evidence:x.evidence}));
    if(safe.milestones) snap.milestones=await getStructuredRows("milestones","id,name,description,complete,completed_at",{column:"created_at",ascending:true});
    if(safe.learning) snap.learning=await getStructuredRows("learning_entries","id,topic,note,learned_at",{column:"learned_at",ascending:false});
    if(safe.timeline) snap.timeline=await getStructuredRows("timeline_entries","id,title,description,entry_date,status",{column:"entry_date"});
    if(safe.fitness) snap.fitness=state.fitness||{};
    return snap;
  }

  function tasksForToday(templates,state,todayKey){
    const template=(templates||[]).find(t=>t.day_date===todayKey);
    if(!template) return [];
    const record=state["day:"+todayKey]||{};
    const ids=Array.isArray(record.completed_task_ids)?record.completed_task_ids:[];
    return (Array.isArray(template.tasks)?template.tasks:[]).map(x=>({title:x.title||"Task",detail:x.detail||"",complete:ids.includes(x.id)}));
  }

  async function refreshPublicSnapshot() {
    if (!supabase || !currentUser) return;
    try {
      const { data: share, error } = await supabase.from("public_shares").select("enabled,settings,share_slug,display_name").eq("user_id", currentUser.id).maybeSingle();
      if (error || !share?.enabled) return;
      const snapshot = await buildPublicSnapshot(share.settings || {});
      const { error: updateError } = await supabase.from("public_shares").update({snapshot}).eq("user_id",currentUser.id);
      if (updateError) throw updateError;
      const { error: profileError } = await supabase.from("public_share_profiles").upsert(
        {share_slug:share.share_slug,display_name:share.display_name,snapshot,updated_at:new Date().toISOString()},
        {onConflict:"share_slug"}
      );
      if (profileError) throw profileError;
    } catch (error) {
      console.warn("Could not refresh public snapshot:", error.message);
    }
  }

  async function savePublicShare({shareSlug,displayName,enabled,settings}) {
    if(!supabase || !currentUser) throw new Error("Sign in first.");
    const snapshot=await buildPublicSnapshot(settings);
    const existing=await getPublicShare();
    if(existing?.share_slug && existing.share_slug!==shareSlug){
      await supabase.from("public_share_profiles").delete().eq("share_slug",existing.share_slug);
    }
    const {data,error}=await supabase.from("public_shares").upsert(
      {user_id:currentUser.id,share_slug:shareSlug,display_name:displayName||"Winter Arc 2026",enabled:Boolean(enabled),settings:settings||{},snapshot},
      {onConflict:"user_id"}
    ).select().single();
    if(error) throw error;
    if(data.enabled){
      const {error:profileError}=await supabase.from("public_share_profiles").upsert(
        {share_slug:data.share_slug,display_name:data.display_name,snapshot:data.snapshot,updated_at:new Date().toISOString()},
        {onConflict:"share_slug"}
      );
      if(profileError) throw profileError;
    }else{
      await supabase.from("public_share_profiles").delete().eq("share_slug",data.share_slug);
    }
    return data;
  }

  window.WINTER_ARC_APP={getClient:()=>supabase,getUser:()=>currentUser,getPublicShare,buildPublicSnapshot,savePublicShare,getStructuredRows,insertStructuredRow,updateStructuredRow,deleteStructuredRow};

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
