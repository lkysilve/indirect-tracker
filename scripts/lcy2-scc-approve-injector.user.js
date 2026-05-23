// ==UserScript==
// @name         LCY2 SCC Approve Injector from Indirect Tracker
// @namespace    lcy2-scc-approve-injector
// @version      8.31.0
// @description  Stable approve flow with lazy UI boot, no page-load slowdown, SCC-style panel/button aligned with SCC action buttons and placed left of SCC legend, PT->Tote Runner, IT WS/Jam Buster ignored.
// @match        https://staffingcommandcenter-eu.aka.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      lkysilve.github.io
// @connect      raw.githubusercontent.com
// @connect      fclm-portal.amazon.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  /******************************************************************
   * LCY2 SCC Approve Injector v8.31 lazy UI boot + live approve flow
   *
   * What we learned from SCC:
   * - Dragging/moving users changes the page locally.
   * - Review opens the confirmation modal.
   * - The real backend save happens on:
   *      POST /approve
   * - The request contains the correct planId, interval, station maps, etc.
   *
   * This script uses the live SCC latest-approval payload and sends /approve
   * directly from your tracker Shift Planner. If a planned login is already in
   * another SCC role, v8.31 follows SCC's real flow: unlock old role, lock tracker role, then approve.
   *
   * Workflow:
   * 1) Load plan from GitHub data.json.
   * 2) Fetch FCLM IDs if needed.
   * 3) Choose Merge or Replace mode.
   * 4) Click LIVE DIRECT APPROVE.
   *
   * Safety:
   * - It never stores cookies/tokens.
   * - It asks for confirmation before sending /approve.
   * - It blocks /approve if IDs are missing.
   ******************************************************************/

  const DEFAULT_DATA_URL = "https://lkysilve.github.io/indirect-tracker/data.json";
  const STORE_KEY = "lcy2_scc_approve_injector_v4";
  const ID_CACHE_KEY = "lcy2_scc_login_employee_id_cache_v1";
  const APPROVE_TEMPLATE_KEY = "lcy2_scc_last_approve_template_v1";
  const WAREHOUSE_ID = "LCY2";
  const SCC_APP_TOKEN = "SCC_FRONTEND_APP_v2";
  const PAGE_BRIDGE_FN = "__LCY2_SCC_APPROVE_INJECTOR_PROCESS_BODY__";
  const PAGE_HOOK_FLAG = "__LCY2_SCC_APPROVE_INJECTOR_PAGE_HOOK_V810__";
  const FCLM_ROSTER_URL = "https://fclm-portal.amazon.com/employee/employeeRoster?reportFormat=HTML&warehouseId=LCY2&employeeStatusActive=true";

  const ROLE_TO_SCC_PROCESS = {
    "SLAM": "SLAM",
    "PG": "PROCESS_GUIDE",
    "PROCESS GUIDE": "PROCESS_GUIDE",
    "PS": "PROBLEM_SOLVER",
    "PROBLEM SOLVER": "PROBLEM_SOLVER",
    "WATER SPIDER": "WATER_SPIDER",
    "WS": "WATER_SPIDER",
    "PT": "TOTE_RUNNER",
    "TR": "TOTE_RUNNER",
    "TOTE RUNNER": "TOTE_RUNNER",
    "TEAM LEAD": "TEAM_LEAD",
    "TL": "TEAM_LEAD",
    "JAM BUSTER": "JAM_BUSTER",
    "JAMBUSTER": "JAM_BUSTER"
  };

  // Planner roles that should be visible in your tracker but should NOT be sent to SCC.
  // IT WS is not a real SCC indirect process, so the SCC injector ignores it.
  const ROLE_IGNORE_FOR_SCC = new Set([
    "IT WS",
    "ITWS",
    "IT WATER SPIDER",
    "IT WATERSPIDER",
    "JAM BUSTER",
    "JAMBUSTER",
    "JAM-BUSTER",
    "JB"
  ]);

  const SCC_PROCESS_LABEL = {
    "SLAM": "SLAM",
    "PROCESS_GUIDE": "Process Guide",
    "PROBLEM_SOLVER": "Problem Solver",
    "WATER_SPIDER": "Water Spider",
    "TOTE_RUNNER": "Tote Runner",
    "TEAM_LEAD": "Team Lead",
    "JAM_BUSTER": "Jam Buster"
  };

  const ROLE_ALIAS_HELP = [
    ["PT", "Tote Runner"],
    ["WS", "Water Spider"],
    ["IT WS", "Ignored by SCC"],
    ["Jam Buster", "Ignored by SCC"]
  ];

  let trackerData = null;
  let currentDate = "";
  let currentPlan = [];
  let armed = false;
  let lastInterceptSummary = "";
  let launcherButton = null;
  let panelOpen = false;
  let booted = false;
  let launchRepositionTimer = 0;
  let templateStatusTimer = 0;

  function clean(v) {
    return String(v ?? "").trim();
  }

  function norm(v) {
    return clean(v).toLowerCase().replace(/\s+/g, " ");
  }

  function roleKey(v) {
    return clean(v).toUpperCase();
  }

  function ignoreRoleForScc(role) {
    return ROLE_IGNORE_FOR_SCC.has(roleKey(role));
  }

  function toSccProcess(role) {
    if (ignoreRoleForScc(role)) return "";
    return ROLE_TO_SCC_PROCESS[roleKey(role)] || roleKey(role).replace(/\s+/g, "_");
  }

  function processLabel(process) {
    const key = roleKey(process);
    return SCC_PROCESS_LABEL[key] || key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  function roleAliasLabel(role) {
    const roleText = clean(role);
    if (ignoreRoleForScc(roleText)) return `${roleText} ignored by SCC`;
    const process = toSccProcess(roleText);
    const sccText = processLabel(process);
    return roleKey(roleText).replace(/\s+/g, "_") === roleKey(process)
      ? sccText
      : `${roleText} → ${sccText}`;
  }

  function roleAliasHelpHtml() {
    return ROLE_ALIAS_HELP.map(([planner, scc]) =>
      `<span class="lcy2-alias-chip">${escapeHtml(planner)} → ${escapeHtml(scc)}</span>`
    ).join("");
  }

  function todayIso() {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0")
    ].join("-");
  }

  function dateKeyVariants(date) {
    const iso = clean(date);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return [iso];
    const y = m[1], mm = m[2], dd = m[3];
    const d = String(Number(dd));
    const mo = String(Number(mm));
    return [
      iso,
      `${dd}/${mm}/${y}`,
      `${d}/${mo}/${y}`,
      `${dd}-${mm}-${y}`,
      `${d}-${mo}-${y}`,
      `${y}/${mm}/${dd}`,
      `${y}${mm}${dd}`
    ];
  }

  function getSettings() {
    try {
      return {
        dataUrl: DEFAULT_DATA_URL,
        date: todayIso(),
        mode: "merge",
        finalConfirm: true,
        ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}")
      };
    } catch {
      return { dataUrl: DEFAULT_DATA_URL, date: todayIso(), mode: "merge", finalConfirm: true };
    }
  }

  function saveSettings(partial) {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...getSettings(), ...partial }));
  }

  function escapeHtml(v) {
    return clean(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(msg, bad = false) {
    let el = document.getElementById("lcy2ApproveInjectorToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "lcy2ApproveInjectorToast";
      el.style.cssText = `
        position:fixed;right:18px;bottom:18px;z-index:99999999;
        background:#111827;color:white;padding:7px 10px;border-radius:2px;
        font-family:Arial,Helvetica,sans-serif;font-weight:600;font-size:12px;box-shadow:0 8px 22px rgba(0,0,0,.22);
        max-width:620px;
      `;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = bad ? "#991b1b" : "#111827";
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.remove(), 6000);
  }

  function setStatus(msg, bad = false) {
    const el = document.getElementById("lcy2ApproveInjectorStatus");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("bad", !!bad);
  }

  function isNumericEmployeeId(v) {
    const s = clean(v);
    return /^\d{6,12}$/.test(s) ? s : "";
  }

  function getIdCache() {
    const merged = {};
    const keys = [
      ID_CACHE_KEY,
      "lcy2_scc_login_employee_id_map_v823",
      "lcy2_scc_login_employee_id_map_v824",
      "lcy2_scc_login_employee_id_map_v822",
      "lcy2_scc_login_employee_id_map_v821"
    ];

    for (const key of keys) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
        for (const [login, id] of Object.entries(obj)) {
          const l = clean(login).toLowerCase();
          const e = isNumericEmployeeId(id);
          if (l && e) merged[l] = e;
        }
      } catch {}
    }

    return merged;
  }

  function saveIdCache(cache) {
    localStorage.setItem(ID_CACHE_KEY, JSON.stringify(cache || {}));
    try {
      localStorage.setItem("lcy2_scc_login_employee_id_map_v823", JSON.stringify(cache || {}));
    } catch {}
  }

  function lookupCachedEmployeeId(login) {
    return isNumericEmployeeId(getIdCache()[clean(login).toLowerCase()] || "");
  }

  function addToIdCache(login, employeeId) {
    const l = clean(login).toLowerCase();
    const id = isNumericEmployeeId(employeeId);
    if (!l || !id) return false;
    const cache = getIdCache();
    cache[l] = id;
    saveIdCache(cache);
    return true;
  }

  function getLogin(p) {
    return clean(
      p?.login ??
      p?.Login ??
      p?.alias ??
      p?.employeeLogin ??
      p?.associateLogin ??
      p?.userId ??
      p?.userID ??
      p?.user ??
      p?.username ??
      p?.ldap ??
      p?.uid ??
      p?.workerLogin ??
      p?.personLogin ??
      p?.["User ID"] ??
      p?.["User Id"] ??
      p?.["user id"] ??
      ""
    ).toLowerCase().replace(/[^a-z0-9._-]/g, "");
  }

  function getEmployeeId(p) {
    if (!p || typeof p !== "object") return "";

    const preferredKeys = [
      "employeeId",
      "employeeID",
      "employee_id",
      "employeeNumber",
      "EmployeeID",
      "EmployeeId",
      "Employee ID",
      "employee id",
      "associateId",
      "associateID",
      "associate_id",
      "associatedId",
      "associatedID",
      "associated_id",
      "personId",
      "personID",
      "person_id",
      "fclmId",
      "fclmID",
      "fclm_id",
      "badgeEmployeeId",
      "badgeBarcodeId",
      "badgeBarcodeID",
      "Badge Barcode ID",
      "badgeId",
      "Badge ID",
      "emplId",
      "empId",
      "empID",
      "workerId",
      "workerID",
      "aaId",
      "aaID"
    ];

    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(p, key)) {
        const id = isNumericEmployeeId(p[key]);
        if (id) return id;
      }
    }

    for (const [key, value] of Object.entries(p)) {
      if (/(employee|associate|assoc|person|fclm|badge|empl|emp|worker|user|aa).*id|^id$/i.test(key)) {
        const id = isNumericEmployeeId(value);
        if (id) return id;
      }
    }

    // Shallow nested fallback: some tracker rows store details/profile nested.
    for (const value of Object.values(p)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const key of preferredKeys) {
        const id = isNumericEmployeeId(value[key]);
        if (id) return id;
      }
    }

    // Do not use p.id blindly because tracker rows often store UUIDs there.
    return "";
  }

  function allPeopleFromData(data) {
    const lists = [
      data?.people,
      data?.logins,
      data?.employees,
      data?.employeeList,
      data?.rows,
      data?.trackerRows,
      data?.manualList,
      data?.pool,
      data?.associates,
      data?.profiles
    ].filter(Array.isArray);

    if (Array.isArray(data?.tabs)) {
      data.tabs.forEach(tab => {
        if (Array.isArray(tab.people)) lists.push(tab.people);
        if (Array.isArray(tab.rows)) lists.push(tab.rows);
        if (Array.isArray(tab.logins)) lists.push(tab.logins);
      });
    }

    if (Array.isArray(data?.customTabs)) {
      data.customTabs.forEach(tab => {
        if (Array.isArray(tab.people)) lists.push(tab.people);
        if (Array.isArray(tab.rows)) lists.push(tab.rows);
        if (Array.isArray(tab.logins)) lists.push(tab.logins);
      });
    }

    const out = [];
    const seen = new Set();

    lists.flat().forEach(p => {
      if (!p || typeof p !== "object") return;
      const login = getLogin(p);
      if (!login || seen.has(login)) return;
      seen.add(login);
      out.push(p);
    });

    return out;
  }

  function objectHasLogin(obj, login) {
    if (!obj || typeof obj !== "object") return false;
    const wanted = clean(login).toLowerCase();
    if (!wanted) return false;

    const possibleLogins = [
      obj.login,
      obj.Login,
      obj.alias,
      obj.employeeLogin,
      obj.associateLogin,
      obj.userId,
      obj.userID,
      obj.user,
      obj.username,
      obj.ldap,
      obj.uid,
      obj.workerLogin,
      obj.personLogin,
      obj["User ID"],
      obj["User Id"],
      obj["user id"]
    ];

    return possibleLogins.some(v => clean(v).toLowerCase() === wanted);
  }

  function findNumericEmployeeIdDeep(root, login) {
    const wanted = clean(login).toLowerCase();
    if (!wanted || !root) return "";

    const seen = new Set();
    const stack = [root];
    let safety = 0;

    while (stack.length && safety++ < 100000) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (objectHasLogin(cur, wanted)) {
        const id = getEmployeeId(cur);
        if (id) return id;
      }

      if (Array.isArray(cur)) {
        for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      } else {
        for (const v of Object.values(cur)) {
          if (v && typeof v === "object") stack.push(v);
        }
      }
    }

    return "";
  }

  function getPersonFromDataByLogin(data, login) {
    const wanted = clean(login).toLowerCase();
    return allPeopleFromData(data).find(p => getLogin(p) === wanted) || null;
  }

  function getEmployeeIdForLogin(login) {
    const person = getPersonFromDataByLogin(trackerData, login);
    return (person ? getEmployeeId(person) : "") || findNumericEmployeeIdDeep(trackerData, login) || lookupCachedEmployeeId(login);
  }

  function requestText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          anonymous: false,
          headers: { "Accept": "application/json,text/plain,*/*" },
          onload: res => {
            if (res.status >= 200 && res.status < 300) resolve(res.responseText);
            else reject(new Error("GET failed " + res.status + " for " + url));
          },
          onerror: () => reject(new Error("Network error loading " + url)),
          ontimeout: () => reject(new Error("Timeout loading " + url))
        });
        return;
      }

      fetch(url, { cache: "no-store", credentials: "include" })
        .then(res => {
          if (!res.ok) throw new Error("GET failed " + res.status + " for " + url);
          return res.text();
        })
        .then(resolve, reject);
    });
  }

  function parseFclmRosterHtmlForIds(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = Array.from(doc.querySelectorAll("tr"));
    const map = {};

    rows.forEach(row => {
      const cells = Array.from(row.querySelectorAll("td,th")).map(td => clean(td.textContent));
      if (cells.length < 3) return;

      // Standard FCLM roster columns:
      // Photo | Employee ID | User ID | Employee Name | ...
      if (isNumericEmployeeId(cells[1]) && /^[a-z][a-z0-9]{2,20}$/i.test(cells[2] || "")) {
        map[cells[2].toLowerCase()] = isNumericEmployeeId(cells[1]);
        return;
      }

      let employeeId = "";
      let login = "";

      for (const cell of cells) {
        if (!employeeId) employeeId = isNumericEmployeeId(cell);
        if (!login && /^[a-z][a-z0-9]{2,20}$/i.test(cell) && !/^(active|amzn|blue|white|login|employee)$/i.test(cell)) {
          login = cell.toLowerCase();
        }
      }

      if (login && employeeId) map[login] = employeeId;
    });

    return map;
  }

  async function fetchFclmRosterIds() {
    setStatus("Fetching numeric employee IDs from FCLM roster...");
    const html = await requestText(FCLM_ROSTER_URL);

    if (/signin|login|midway|sso/i.test(html.slice(0, 2000)) && !/Employee ID|User ID|employee-roster/i.test(html)) {
      throw new Error("FCLM returned a login page. Open the roster in another tab first, then try again.");
    }

    const map = parseFclmRosterHtmlForIds(html);
    const count = Object.keys(map).length;

    if (!count) throw new Error("Could not parse employee IDs from FCLM roster HTML.");

    const cache = getIdCache();
    Object.assign(cache, map);
    saveIdCache(cache);

    hydratePlanEmployeeIds();

    renderPlan();
    const missing = missingItems().length;
    setStatus(`Fetched ${count} FCLM IDs. Missing in loaded plan: ${missing}`, !!missing);
    toast(`Fetched ${count} FCLM IDs${missing ? " — " + missing + " still missing" : ""}`, !!missing);
  }

  function parseTrackerPlan(data, date) {
    const book = data?.plannerBook || {};
    const variants = dateKeyVariants(date);
    const plans = book?.plans || data?.plannerState?.plans || data?.shiftPlanner?.plans || {};
    let plan = {};

    for (const key of variants) {
      if (plans && plans[key]) { plan = plans[key]; break; }
    }

    if (!Object.keys(plan || {}).length) {
      plan = data?.plannerState || data?.shiftPlanner || {};
    }

    const columns = plan?.columns || plan?.roles || {};
    const roles = Object.keys(columns).length
      ? Object.keys(columns)
      : Array.isArray(data?.roles)
        ? data.roles
        : [];

    const out = [];

    for (const role of roles) {
      const col = columns[role] || { required: 0, assigned: [] };
      const assigned = Array.isArray(col.assigned)
        ? col.assigned
        : Array.isArray(col.logins)
          ? col.logins
          : [];

      const logins = assigned.map(item => {
        const login = typeof item === "string" ? clean(item).toLowerCase() : getLogin(item);
        const idFromItem = typeof item === "object" ? getEmployeeId(item) : "";
        return {
          login,
          note: typeof item === "object" ? clean(item.note || item.notes || item.location || item.locationNote) : "",
          employeeId: idFromItem
        };
      }).filter(x => x.login);

      const process = toSccProcess(role);

      // Ignore planner-only roles like IT WS. They can stay in the tracker, but
      // they should not create /lock or /approve changes in SCC.
      if (!process) continue;

      if (!logins.length && !Number(col.required || 0)) continue;

      out.push({
        role,
        process,
        required: Number(col.required || 0),
        logins
      });
    }

    return out;
  }

  function hydratePlanEmployeeIds() {
    currentPlan.forEach(role => {
      role.logins.forEach(item => {
        if (!isNumericEmployeeId(item.employeeId)) {
          item.employeeId = getEmployeeIdForLogin(item.login);
        }
      });
    });
  }

  function buildPlannerMap() {
    hydratePlanEmployeeIds();

    const map = {};
    const missing = [];

    for (const role of currentPlan) {
      const process = toSccProcess(role.role);
      if (!process) continue;
      for (const item of role.logins) {
        const id = isNumericEmployeeId(item.employeeId);
        if (!id) {
          missing.push({ role: role.role, login: item.login });
          continue;
        }
        map[id] = process;
      }
    }

    return { map, missing };
  }

  function missingItems() {
    hydratePlanEmployeeIds();
    return currentPlan.flatMap(role =>
      !toSccProcess(role.role)
        ? []
        : role.logins
          .filter(x => !isNumericEmployeeId(x.employeeId))
          .map(x => ({ role: role.role, login: x.login }))
    );
  }

  async function loadTrackerData() {
    const dataUrl = clean(document.getElementById("lcy2InjectorDataUrl")?.value || DEFAULT_DATA_URL);
    const date = clean(document.getElementById("lcy2InjectorDate")?.value || todayIso());
    const mode = document.querySelector("input[name='lcy2InjectorMode']:checked")?.value || "merge";
    const finalConfirm = !!document.getElementById("lcy2InjectorFinalConfirm")?.checked;

    saveSettings({ dataUrl, date, mode, finalConfirm });
    currentDate = date;

    setStatus("Loading tracker data...");
    const text = await requestText(dataUrl + (dataUrl.includes("?") ? "&" : "?") + "t=" + Date.now());
    trackerData = JSON.parse(text);
    currentPlan = parseTrackerPlan(trackerData, date);
    hydratePlanEmployeeIds();

    const total = currentPlan.reduce((a, r) => a + r.logins.length, 0);
    const missing = missingItems().length;

    renderPlan();
    setStatus(`Loaded ${total} planned logins for ${date}${missing ? ` — ${missing} missing numeric IDs` : ""}`, !!missing);
    toast(`Loaded ${total} planned logins${missing ? ` — ${missing} missing IDs` : ""}`, !!missing);
  }

  function approvePath(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname === "/approve";
    } catch {
      return String(url || "") === "/approve";
    }
  }

  async function readFetchBody(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
      return bodyToText(init.body);
    }

    if (typeof Request !== "undefined" && input instanceof Request) {
      try { return await input.clone().text(); }
      catch { return ""; }
    }

    return "";
  }

  async function bodyToText(body) {
    try {
      if (body == null) return "";
      if (typeof body === "string") return body;
      if (body instanceof Blob) return await body.text();
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) {
        const obj = {};
        for (const [k, v] of body.entries()) obj[k] = String(v);
        return JSON.stringify(obj);
      }
      return JSON.stringify(body);
    } catch {
      return "";
    }
  }

  function currentMode() {
    return document.querySelector("input[name='lcy2InjectorMode']:checked")?.value || getSettings().mode || "merge";
  }

  function blockResponse(message) {
    setStatus(message, true);
    toast(message, true);
    return new Response(JSON.stringify({ blockedByLCY2SccInjector: true, message }), {
      status: 499,
      statusText: "Blocked by LCY2 SCC Approve Injector",
      headers: { "Content-Type": "application/json" }
    });
  }

  function applyMapsToPayload(originalPayload, indirectMap, stationMap) {
    const modified = {
      ...originalPayload,
      employeeIdToIndirectProcessMap: indirectMap,
      employeeIdToStationIdsMap: stationMap
    };

    // In case SCC adds nested approval objects in future.
    if (modified.leoPlanApproval && typeof modified.leoPlanApproval === "object") {
      modified.leoPlanApproval = {
        ...modified.leoPlanApproval,
        employeeIdToIndirectProcessMap: indirectMap,
        employeeIdToStationIdsMap: stationMap
      };
    }

    return normalizeApproveRequestPayload(modified);
  }

  function buildModifiedApprovePayload(originalPayload) {
    originalPayload = normalizeApproveRequestPayload(cloneJson(originalPayload));
    const { map: plannerMap, missing } = buildPlannerMap();

    if (missing.length) {
      return {
        ok: false,
        error:
          `Blocked: ${missing.length} planned logins have no numeric employee ID. ` +
          `Click Fetch FCLM IDs first. Missing: ` +
          missing.slice(0, 8).map(x => `${x.login} (${x.role})`).join(", ") +
          (missing.length > 8 ? ` +${missing.length - 8} more` : "")
      };
    }

    const plannerIds = Object.keys(plannerMap);
    const plannerCount = plannerIds.length;
    if (!plannerCount) {
      return { ok: false, error: "Blocked: tracker plan is empty. Load plan first." };
    }

    const mode = currentMode();
    const existing = originalPayload.employeeIdToIndirectProcessMap || {};
    const existingStationMap = originalPayload.employeeIdToStationIdsMap || {};

    // Planned logins must win.
    // If an employee is already locked in another indirect role, SCC can ignore a
    // one-shot role swap. v8.3 therefore prepares a clear step first:
    //   1) remove planned IDs from old indirect/station assignment
    //   2) send the final tracker role assignment
    const finalMap = mode === "replace" ? { ...plannerMap } : { ...existing, ...plannerMap };
    const finalStationMap = { ...existingStationMap };

    const clearMap = { ...existing };
    const clearStationMap = { ...existingStationMap };

    let changedIndirectCount = 0;
    let alreadyCorrectCount = 0;
    let removedStationCount = 0;
    let movedExistingCount = 0;
    let newAssignmentCount = 0;

    const movedExisting = [];
    const removedStations = [];

    plannerIds.forEach(id => {
      if (existing[id] === plannerMap[id]) {
        alreadyCorrectCount++;
      } else {
        changedIndirectCount++;
        if (existing[id]) {
          movedExistingCount++;
          movedExisting.push({ id, from: existing[id], to: plannerMap[id] });
        } else {
          newAssignmentCount++;
        }
      }

      if (Object.prototype.hasOwnProperty.call(finalStationMap, id)) {
        removedStations.push({ id, stationIds: finalStationMap[id] });
        delete finalStationMap[id];
        removedStationCount++;
      }

      // The clear step removes planned IDs from both old indirect roles and old stations.
      delete clearMap[id];
      delete clearStationMap[id];
    });

    const finalPayload = applyMapsToPayload(originalPayload, finalMap, finalStationMap);
    const clearPayload = applyMapsToPayload(originalPayload, clearMap, clearStationMap);

    return {
      ok: true,
      payload: finalPayload,
      clearPayload,
      mode,
      plannerMap,
      plannerIds,
      plannerCount,
      existingCount: Object.keys(existing).length,
      finalCount: Object.keys(finalMap).length,
      clearCount: Object.keys(clearMap).length,
      changedIndirectCount,
      alreadyCorrectCount,
      removedStationCount,
      movedExistingCount,
      newAssignmentCount,
      movedExisting,
      removedStations
    };
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function isApprovePayload(payload) {
    return !!(
      payload &&
      typeof payload === "object" &&
      payload.warehouseId === WAREHOUSE_ID &&
      payload.zone === "Singles" &&
      payload.scheduleName === "OB" &&
      payload.process === "SINGLES_PACK" &&
      payload.planId &&
      payload.planInterval &&
      payload.employeeIdToIndirectProcessMap
    );
  }

  function cloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function normalizeSecondsValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    // SCC /approve request wants seconds. Some saved objects can accidentally
    // contain milliseconds. Convert 13-digit millisecond values to seconds.
    return n > 9999999999 ? n / 1000 : n;
  }

  function normalizeApproveRequestPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;

    if (payload.planInterval && typeof payload.planInterval === "object") {
      // SCC /approve planInterval uses seconds.
      payload.planInterval.startTime = normalizeSecondsValue(payload.planInterval.startTime);
      payload.planInterval.endTime = normalizeSecondsValue(payload.planInterval.endTime);
    }

    // Important v8.8:
    // Do NOT force lastApprovalTime to seconds. Manual SCC captures can send it
    // as the raw approvalTime value from /getLatestApprovals, which is often ms.
    // SCC has accepted both shapes before, but matching the live page is safer.
    if (!payload.lastApprovalTime &&
        payload.leoPlanApproval &&
        payload.leoPlanApproval.approvalTime) {
      payload.lastApprovalTime = payload.leoPlanApproval.approvalTime;
    }

    return payload;
  }

  function clearApproveTemplate() {
    localStorage.removeItem(APPROVE_TEMPLATE_KEY);
    refreshTemplateStatus();
    setStatus("Direct approve template cleared. Seed it again with one normal SCC Review + Approve.", true);
    toast("Template cleared. Do one normal Review + Approve to seed it again.", true);
  }

  function saveApproveTemplate(payload, source = "captured") {
    if (!isApprovePayload(payload)) return false;

    const normalizedPayload = normalizeApproveRequestPayload(cloneJson(payload));

    const template = {
      savedAt: new Date().toISOString(),
      source,
      planId: normalizedPayload.planId,
      planInterval: normalizedPayload.planInterval,
      payload: normalizedPayload
    };

    try {
      localStorage.setItem(APPROVE_TEMPLATE_KEY, JSON.stringify(template));
      refreshTemplateStatus();
      return true;
    } catch (e) {
      console.warn("[LCY2 SCC Injector] Could not save /approve template", e);
      return false;
    }
  }

  function getApproveTemplate() {
    try {
      const template = JSON.parse(localStorage.getItem(APPROVE_TEMPLATE_KEY) || "null");
      if (!template || !isApprovePayload(template.payload)) return null;
      return template;
    } catch {
      return null;
    }
  }

  function getCurrentPagePlanId() {
    const text = document.body ? document.body.textContent || "" : "";

    // Strict SCC plan id format. Do NOT use /LCY2-[a-z0-9-]+/ because the page
    // text has no separator after the id, so it can accidentally capture words like
    // ZoneCancelSendMessageMoveUnassign...
    const uuidPattern = "LCY2-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const afterLabel = new RegExp("SCC\\s+Plan\\s+ID:\\s*(" + uuidPattern + ")", "i").exec(text);
    if (afterLabel) return afterLabel[1];

    const anywhere = new RegExp("\\b(" + uuidPattern + ")\\b", "i").exec(text);
    return anywhere ? anywhere[1] : "";
  }

  function describeTemplate(template) {
    if (!template) return "No /approve template saved yet. To seed it once: make one normal SCC change, Review, then Approve.";
    const saved = template.savedAt ? new Date(template.savedAt).toLocaleString() : "unknown time";
    const intv = template.planInterval || {};
    const count = Object.keys(template.payload?.employeeIdToIndirectProcessMap || {}).length;
    return `Template saved ${saved}. Plan ${template.planId}. Existing indirects: ${count}.`;
  }

  function refreshTemplateStatus() {
    const el = document.getElementById("lcy2TemplateStatus");
    if (!el) return;

    const template = getApproveTemplate();
    const currentPlanId = getCurrentPagePlanId();

    if (!template) {
      el.textContent = "Direct approve template: not saved yet.";
      el.classList.add("bad");
      return;
    }

    const same = currentPlanId && template.planId === currentPlanId;
    el.textContent =
      `Direct approve template: saved for ${template.planId}` +
      (currentPlanId ? (same ? " — matches current SCC plan." : ` — current SCC plan is ${currentPlanId}, so direct approve is blocked.`) : "");
    el.classList.toggle("bad", !!currentPlanId && !same);
  }

  function selectedScheduleText() {
    const selects = [...document.querySelectorAll("select")];
    for (const sel of selects) {
      const txt = clean(sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : sel.value);
      if (/\b(day|night)\b/i.test(txt) && /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(txt)) return txt;
    }

    const bodyText = document.body ? document.body.textContent || "" : "";
    const m = bodyText.match(/[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}\s*\|\s*(?:Day|Night)\s*\|\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*(?:BST|GMT)?(?:\s*-\s*Active)?/);
    return m ? m[0] : "";
  }

  function parseSccScheduleText(text) {
    text = clean(text);
    const monthMap = {
      jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
      may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
      oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
    };

    const re = /([A-Z][a-z]{2,8})\s+(\d{1,2}),\s+(\d{4})\s*\|\s*(Day|Night)\s*\|\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(BST|GMT)?/i;
    const m = text.match(re);
    if (!m) return null;

    const mon = monthMap[m[1].toLowerCase()];
    if (mon == null) return null;

    const day = Number(m[2]);
    const year = Number(m[3]);
    const shiftName = m[4].toUpperCase();
    const sh = Number(m[5]);
    const sm = Number(m[6]);
    const eh = Number(m[7]);
    const em = Number(m[8]);
    const tz = (m[9] || "").toUpperCase();
    const offsetHours = tz === "BST" ? 1 : 0;

    let startMs = Date.UTC(year, mon, day, sh - offsetHours, sm, 0);
    let endMs = Date.UTC(year, mon, day, eh - offsetHours, em, 0);
    if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;

    return {
      startTime: Math.round(startMs / 1000),
      endTime: Math.round(endMs / 1000),
      shiftName,
      text
    };
  }

  function currentSccInterval() {
    const text = selectedScheduleText();
    const parsed = parseSccScheduleText(text);
    if (parsed) return parsed;

    const template = getApproveTemplate();
    if (template && template.payload && template.payload.planInterval) {
      const pi = template.payload.planInterval;
      return {
        startTime: normalizeSecondsValue(pi.startTime),
        endTime: normalizeSecondsValue(pi.endTime),
        shiftName: pi.shiftName || "NIGHT",
        text: "fallback from saved template"
      };
    }

    return null;
  }

  function inferSinglesProcessPath(stationId) {
    stationId = clean(stationId);
    if (/SmartPac/i.test(stationId)) return "PPSmartPacPaper";
    if (/SINGLES_EAST/i.test(stationId)) return "PPSingleMedium2";
    if (/SINGLES_WEST/i.test(stationId)) return "PPSingleMedium";

    const n = Number((stationId.match(/^ws(\d+)$/i) || [])[1]);
    if (Number.isFinite(n)) {
      if (n >= 100 && n <= 124) return "PPSingleNoSLAM2";
      if (n >= 158 && n <= 174) return "PPSingleNoSLAM";
    }

    return "PPSingleMedium";
  }

  function makeLaneStationMapFromAssignedRoleMap(assignedRoleMap) {
    const out = {};
    for (const [stationId, assignedRole] of Object.entries(assignedRoleMap || {})) {
      const role = assignedRole || "PACK";
      out[stationId] = {
        sccStation: {
          stationId,
          type: role === "PACK" ? "PACK" : role,
          zone: null,
          processPath: inferSinglesProcessPath(stationId)
        },
        role
      };
    }
    return out;
  }

  async function fetchLiveSinglesApproval() {
    const interval = currentSccInterval();
    if (!interval) {
      throw new Error("Could not read the selected SCC interval from the dropdown.");
    }

    setStatus(`Fetching live SCC approvals for ${interval.text}...`);

    const res = await fetch("/getLatestApprovals/LCY2?scheduleName=OB", {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "*/*",
        "Content-Type": "application/json;charset=UTF-8",
        "App-Token": SCC_APP_TOKEN,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify({
        startTime: interval.startTime,
        endTime: interval.endTime,
        shiftName: interval.shiftName
      })
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!res.ok) {
      console.error("[LCY2 SCC Injector] /getLatestApprovals failed:", res.status, text);
      throw new Error(`/getLatestApprovals failed ${res.status}`);
    }

    const singles = json && json.Singles;
    if (!singles || singles.department !== "SINGLES_PACK" || singles.approvalGroupName !== "Singles") {
      console.error("[LCY2 SCC Injector] /getLatestApprovals response missing Singles:", json);
      throw new Error("Live SCC approvals did not include Singles/SINGLES_PACK.");
    }

    const currentPlanId = getCurrentPagePlanId();
    if (currentPlanId && singles.planId && currentPlanId !== singles.planId) {
      throw new Error(`Live approval planId does not match current SCC page. Live=${singles.planId}, page=${currentPlanId}`);
    }

    return { singles, interval, raw: json };
  }

  function buildApprovePayloadFromLiveSingles(singles, interval) {
    const work = singles.workInterval || {};
    const start = normalizeSecondsValue(work.startTime || interval.startTime);
    const end = normalizeSecondsValue(work.endTime || interval.endTime);
    const seq = Array.isArray(singles.approvalIdSequence) ? singles.approvalIdSequence : [];

    const payload = {
      warehouseId: WAREHOUSE_ID,
      zone: "Singles",
      scheduleName: "OB",
      process: "SINGLES_PACK",
      planId: singles.planId,
      planInterval: {
        startTime: start,
        endTime: end,
        shiftName: interval.shiftName || "NIGHT"
      },
      // Keep the raw live approvalTime shape. Manual SCC captures use this as lastApprovalTime.
      lastApprovalTime: singles.approvalTime || 0,
      employeeIdToIndirectProcessMap: cloneJson(singles.employeeIdToIndirectProcessMap || {}),
      employeeIdToStationIdsMap: cloneJson(singles.employeeIdToStationIdsMap || {}),
      stationIdToLaneStationMap:
        cloneJson(singles.stationIdToLaneStationMap ||
        makeLaneStationMapFromAssignedRoleMap(singles.stationIdToAssignedRoleMap || {})),
      stationIdToAssignedRoleMap: cloneJson(singles.stationIdToAssignedRoleMap || {}),

      // Manual SCC /approve uses previousApprovalIdSequence, not approvalIdSequence.
      previousApprovalIdSequence: seq.slice(),
      replanId: null,
      employeeIdToProhibitedRoleOverridesMap: {},
      trainingOverrideUpdates: {
        overridesToCreate: [],
        overridesToCancel: []
      }
    };

    return normalizeApproveRequestPayload(payload);
  }

  function plannerEntriesFromCurrentPlan() {
    hydratePlanEmployeeIds();

    const out = [];
    const seen = new Set();

    currentPlan.forEach(role => {
      const process = toSccProcess(role.role);
      if (!process) return;
      role.logins.forEach(item => {
        const id = isNumericEmployeeId(item.employeeId);
        if (!id) return;
        if (seen.has(id)) return;
        seen.add(id);
        out.push({
          id,
          login: item.login,
          role: role.role,
          process
        });
      });
    });

    return out;
  }

  function sccHeaders(json = false) {
    return json ? {
      "Accept": "*/*",
      "Content-Type": "application/json;charset=UTF-8",
      "App-Token": SCC_APP_TOKEN,
      "X-Requested-With": "XMLHttpRequest"
    } : {
      "Accept": "*/*",
      "App-Token": SCC_APP_TOKEN,
      "X-Requested-With": "XMLHttpRequest"
    };
  }

  async function sccFetch(path, options = {}, label = path) {
    const method = clean(options.method || "GET").toUpperCase();
    const hasBody = Object.prototype.hasOwnProperty.call(options, "body");
    const res = await fetch(path, {
      method,
      credentials: "include",
      headers: sccHeaders(hasBody),
      body: hasBody ? options.body : undefined
    });

    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}

    console.log(`[LCY2 SCC Injector] ${label} response:`, parsed);

    if (!res.ok) {
      console.error(`[LCY2 SCC Injector] ${label} failed:`, res.status, parsed);
      throw new Error(`${label} failed ${res.status}`);
    }

    return parsed;
  }

  async function fetchAssociateIndirectLocks() {
    const locks = await sccFetch(`/getAssociateIndirectLocks/${WAREHOUSE_ID}`, { method: "GET" }, "GET indirect locks");
    return Array.isArray(locks) ? locks : [];
  }

  function locksForAssociate(locks, associateId) {
    const id = clean(associateId);
    return (locks || []).filter(l => clean(l.associateId) === id);
  }

  function bestLockForAssociate(locks, associateId) {
    const mine = locksForAssociate(locks, associateId);
    if (!mine.length) return null;

    // Prefer the lock SCC would use for this page: OB + Singles.
    return mine.find(l => clean(l.scheduleName).toUpperCase() === "OB" && clean(l.stationApprovalGroup) === "Singles") ||
      mine.find(l => clean(l.scheduleName).toUpperCase() === "OB") ||
      mine.find(l => clean(l.stationApprovalGroup) === "Singles") ||
      mine[0];
  }

  function lockMatchesTracker(lock, process) {
    return !!(
      lock &&
      clean(lock.warehouseId) === WAREHOUSE_ID &&
      clean(lock.stationApprovalGroup) === "Singles" &&
      clean(lock.scheduleName).toUpperCase() === "OB" &&
      roleKey(lock.leoProcess) === roleKey(process)
    );
  }

  async function unlockAssociateIndirect(associateId) {
    const id = isNumericEmployeeId(associateId);
    if (!id) throw new Error(`Cannot unlock invalid associate ID: ${associateId}`);
    return sccFetch(`/unlock/${WAREHOUSE_ID}/${encodeURIComponent(id)}`, { method: "GET" }, `UNLOCK ${id}`);
  }

  async function lockAssociateIndirect(associateId, process) {
    const id = isNumericEmployeeId(associateId);
    if (!id) throw new Error(`Cannot lock invalid associate ID: ${associateId}`);

    const body = {
      warehouseId: WAREHOUSE_ID,
      stationApprovalGroup: "Singles",
      scheduleName: "OB",
      associateId: id,
      leoProcess: process
    };

    console.log("[LCY2 SCC Injector] LOCK payload:", body);

    return sccFetch(`/lock/${WAREHOUSE_ID}`, {
      method: "POST",
      body: JSON.stringify(body)
    }, `LOCK ${id} -> ${process}`);
  }

  async function syncTrackerLocksToScc(plannerEntries) {
    const result = {
      alreadyCorrect: 0,
      unlocked: 0,
      locked: 0,
      changed: 0,
      failed: 0,
      details: []
    };

    let locks = await fetchAssociateIndirectLocks();

    for (const entry of plannerEntries) {
      const currentLock = bestLockForAssociate(locks, entry.id);

      if (lockMatchesTracker(currentLock, entry.process)) {
        result.alreadyCorrect++;
        result.details.push({ ...entry, action: "already-correct", before: currentLock });
        continue;
      }

      try {
        if (currentLock) {
          setStatus(`Unlocking ${entry.login || entry.id} from ${currentLock.stationApprovalGroup || "?"} / ${processLabel(currentLock.leoProcess || "?")}...`);
          await unlockAssociateIndirect(entry.id);
          result.unlocked++;
          await sleep(250);
        }

        setStatus(`Locking ${entry.login || entry.id} to ${processLabel(entry.process)}...`);
        const lockResponse = await lockAssociateIndirect(entry.id, entry.process);
        if (lockResponse !== true && clean(lockResponse).toLowerCase() !== "true") {
          console.warn("[LCY2 SCC Injector] Lock response was not boolean true:", lockResponse);
        }
        result.locked++;
        result.changed++;
        result.details.push({ ...entry, action: currentLock ? "unlock-lock" : "lock", before: currentLock || null });

        // Refresh the lock cache so the next associate is based on latest SCC state.
        try { locks = await fetchAssociateIndirectLocks(); } catch {}
      } catch (e) {
        result.failed++;
        result.details.push({ ...entry, action: "failed", before: currentLock || null, error: e.message || String(e) });
        throw e;
      }
    }

    return result;
  }

  async function waitForTrackerLocks(plannerEntries) {
    for (let attempt = 1; attempt <= 8; attempt++) {
      await sleep(attempt <= 2 ? 500 : 900);
      const locks = await fetchAssociateIndirectLocks();
      const missing = plannerEntries.filter(entry => !lockMatchesTracker(bestLockForAssociate(locks, entry.id), entry.process));

      console.log("[LCY2 SCC Injector] lock-state poll", {
        attempt,
        missing: missing.map(x => `${x.login || x.id}:${x.process}`)
      });

      if (!missing.length) return { ok: true, locks };
    }

    return { ok: false, locks: await fetchAssociateIndirectLocks() };
  }


  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isEmptyApprovalResponse(parsed) {
    const indirectResponseCount = parsed && parsed.approvedEmployeeIdToIndirectProcess
      ? Object.keys(parsed.approvedEmployeeIdToIndirectProcess).length
      : 0;

    return !!(
      parsed &&
      typeof parsed === "object" &&
      (!parsed.leoPlanApproval) &&
      (!parsed.approvalIdSequence || parsed.approvalIdSequence.length === 0) &&
      indirectResponseCount === 0
    );
  }

  function responseIndirectCount(parsed) {
    return parsed && parsed.approvedEmployeeIdToIndirectProcess
      ? Object.keys(parsed.approvedEmployeeIdToIndirectProcess).length
      : 0;
  }

  function plannedIdsAreClear(singles, plannedIds) {
    const indirect = singles && singles.employeeIdToIndirectProcessMap ? singles.employeeIdToIndirectProcessMap : {};
    const station = singles && singles.employeeIdToStationIdsMap ? singles.employeeIdToStationIdsMap : {};

    return plannedIds.every(id =>
      !Object.prototype.hasOwnProperty.call(indirect, id) &&
      !Object.prototype.hasOwnProperty.call(station, id)
    );
  }

  async function waitForClearState(plannedIds, minApprovalTime) {
    const minTime = normalizeSecondsValue(minApprovalTime || 0);

    for (let attempt = 1; attempt <= 8; attempt++) {
      await sleep(attempt <= 2 ? 800 : 1300);

      try {
        const fresh = await fetchLiveSinglesApproval();
        const approvalTime = normalizeSecondsValue(fresh.singles.approvalTime || 0);
        const isClear = plannedIdsAreClear(fresh.singles, plannedIds);

        console.log("[LCY2 SCC Injector] clear-state poll", {
          attempt,
          isClear,
          approvalTime,
          minTime,
          indirects: Object.keys(fresh.singles.employeeIdToIndirectProcessMap || {}).length,
          plannedIds
        });

        if (isClear && (!minTime || approvalTime >= minTime)) {
          return fresh.singles;
        }
      } catch (e) {
        console.warn("[LCY2 SCC Injector] clear-state poll failed", attempt, e);
      }
    }

    return null;
  }

  async function postApprovePayload(payload, label) {
    const sendPayload = normalizeApproveRequestPayload(cloneJson(payload));

    // Manual SCC /approve sends previousApprovalIdSequence. It does not send the
    // live approvalIdSequence field itself.
    if (!Array.isArray(sendPayload.previousApprovalIdSequence) && Array.isArray(sendPayload.approvalIdSequence)) {
      sendPayload.previousApprovalIdSequence = sendPayload.approvalIdSequence.slice();
    }
    delete sendPayload.approvalIdSequence;
    if (sendPayload.leoPlanApproval) delete sendPayload.leoPlanApproval.approvalIdSequence;

    if (!sendPayload.employeeIdToProhibitedRoleOverridesMap) sendPayload.employeeIdToProhibitedRoleOverridesMap = {};
    if (!sendPayload.trainingOverrideUpdates) {
      sendPayload.trainingOverrideUpdates = { overridesToCreate: [], overridesToCancel: [] };
    }
    if (!Object.prototype.hasOwnProperty.call(sendPayload, "replanId")) sendPayload.replanId = null;

    console.log(`[LCY2 SCC Injector] ${label} /approve payload:`, sendPayload);

    const res = await fetch("/approve", {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "*/*",
        "Content-Type": "application/json;charset=UTF-8",
        "App-Token": SCC_APP_TOKEN,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify(sendPayload)
    });

    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}

    console.log(`[LCY2 SCC Injector] ${label} /approve response:`, parsed);

    if (!res.ok) {
      throw new Error(`${label} /approve failed ${res.status}`);
    }

    return parsed;
  }

  function approvalResponseToSingles(parsed) {
    if (!parsed || !parsed.leoPlanApproval) return null;
    const a = parsed.leoPlanApproval;

    // v8.5 important:
    // After the CLEAR step, SCC's ROOT response fields are the fresh approved state:
    //   approvedEmployeeIdToIndirectProcess
    //   approvedEmployeeIdToStationIds
    //   stationIdToRole
    // The nested leoPlanApproval can still look like the submitted/old request on
    // some SCC responses. If we rebuild final assign from the nested map, the
    // script thinks the person is still in the old role and SCC returns no changes.
    const rootIndirectMap = parsed.approvedEmployeeIdToIndirectProcess || null;
    const rootStationMap = parsed.approvedEmployeeIdToStationIds || null;
    const rootStationRoleMap = parsed.stationIdToRole || null;
    const rootApprovalIds = parsed.approvalIdSequence || null;

    return {
      planId: a.planId,
      approvalTime: parsed.approvalTime || a.approvalTime,
      workInterval: a.workInterval,
      employeeIdToIndirectProcessMap: rootIndirectMap || a.employeeIdToIndirectProcessMap || {},
      employeeIdToStationIdsMap: rootStationMap || a.employeeIdToStationIdsMap || {},
      stationIdToAssignedRoleMap: rootStationRoleMap || a.stationIdToAssignedRoleMap || {},
      approvalIdSequence: rootApprovalIds || a.approvalIdSequence || [],
      department: a.department || "SINGLES_PACK",
      approvalGroupName: a.approvalGroupName || "Singles"
    };
  }

  async function liveDirectApproveNow() {
    armed = false;
    renderPlan();

    const { map: plannerMap, missing } = buildPlannerMap();
    const plannerEntries = plannerEntriesFromCurrentPlan();

    if (missing.length) {
      const msg =
        `Blocked: ${missing.length} planned logins have no numeric employee ID. ` +
        `Click Fetch FCLM IDs first. Missing: ` +
        missing.slice(0, 8).map(x => `${x.login} (${x.role})`).join(", ") +
        (missing.length > 8 ? ` +${missing.length - 8} more` : "");
      setStatus(msg, true);
      toast(msg, true);
      return;
    }

    if (!plannerEntries.length) {
      setStatus("Blocked: tracker plan is empty. Load plan first.", true);
      toast("Tracker plan is empty", true);
      return;
    }

    const { singles, interval } = await fetchLiveSinglesApproval();
    let basePayload = buildApprovePayloadFromLiveSingles(singles, interval);
    let preview = buildModifiedApprovePayload(basePayload);

    if (!preview.ok) {
      setStatus(preview.error, true);
      toast(preview.error, true);
      return;
    }

    // This shows the user what will happen before any unlock/lock/approve calls.
    const currentLocks = await fetchAssociateIndirectLocks();
    const lockChanges = plannerEntries.map(entry => {
      const before = bestLockForAssociate(currentLocks, entry.id);
      return {
        ...entry,
        before,
        correct: lockMatchesTracker(before, entry.process)
      };
    });

    const toChange = lockChanges.filter(x => !x.correct).length;
    const alreadyCorrectLocks = lockChanges.length - toChange;

    const summary =
      `LIVE DIRECT APPROVE will run the real SCC flow now.

` +
      `Flow: unlock old indirect role → lock tracker role → approve plan
` +
      `Role aliases are applied automatically, e.g. PT → Tote Runner.

` +
      `Mode: ${preview.mode.toUpperCase()}
` +
      `Tracker planned indirects: ${preview.plannerCount}
` +
      `SCC indirects currently approved: ${preview.existingCount}
` +
      `Final indirects to approve: ${preview.finalCount}
` +
      `Locks already correct: ${alreadyCorrectLocks}
` +
      `Locks to change/create: ${toChange}
` +
      `Station assignments removed for planned logins: ${preview.removedStationCount}
` +
      `
Plan: ${singles.planId}
` +
      `Interval: ${interval.text}

` +
      `Continue?`;

    if (!window.confirm(summary)) {
      setStatus("Live Direct Approve cancelled.");
      return;
    }

    let finalParsed = null;
    let lockResult = null;
    let lockWait = null;
    let finalLockCheck = null;
    let finalResult = null;

    try {
      // 1) Make SCC's actual indirect lock state match the tracker plan first.
      setStatus("Step 1/3: syncing SCC indirect locks to tracker plan...");
      lockResult = await syncTrackerLocksToScc(plannerEntries);

      // 2) Wait briefly so SCC catches up before building the final approval payload.
      setStatus("Step 2/3: verifying SCC lock state...");
      lockWait = await waitForTrackerLocks(plannerEntries);
      if (!lockWait.ok) {
        console.warn("[LCY2 SCC Injector] Lock state did not fully verify before approve. Continuing with final approve anyway.");
        toast("Lock state did not fully verify; continuing to approve.", true);
      }

      // 3) Fetch fresh approval base after locks, then approve final tracker map.
      setStatus("Step 3/3: fetching fresh SCC approval base and approving tracker plan...");
      const fresh = await fetchLiveSinglesApproval();
      basePayload = buildApprovePayloadFromLiveSingles(fresh.singles, fresh.interval);
      finalResult = buildModifiedApprovePayload(basePayload);
      if (!finalResult.ok) throw new Error(finalResult.error);

      console.log("[LCY2 SCC Injector] v8.10 final /approve build:", {
        lockResult,
        lockVerified: lockWait.ok,
        plannerMap,
        previousApprovalIdSequence: finalResult.payload.previousApprovalIdSequence,
        finalIndirects: finalResult.payload.employeeIdToIndirectProcessMap,
        finalStations: finalResult.payload.employeeIdToStationIdsMap
      });

      finalParsed = await postApprovePayload(finalResult.payload, "LIVE UNLOCK-LOCK FINAL APPROVE");

      // v8.10 UX: verify the final lock state after /approve. SCC can sometimes
      // return an empty /approve response even though the lock state was updated.
      // If the locks are correct, treat the operation as successful.
      setStatus("Final check: verifying planned roles are locked correctly...");
      finalLockCheck = await waitForTrackerLocks(plannerEntries);
    } catch (e) {
      console.error("[LCY2 SCC Injector] v8.10 LIVE Direct flow failed:", e);
      setStatus(e.message || "LIVE Direct Approve failed. Check Console.", true);
      toast(e.message || "LIVE Direct Approve failed", true);
      return;
    }

    const indirectResponseCount = responseIndirectCount(finalParsed);
    const emptyApproval = isEmptyApprovalResponse(finalParsed);

    const finalLockOk = finalLockCheck ? finalLockCheck.ok : (lockWait ? lockWait.ok : false);

    lastInterceptSummary =
      `LIVE Direct v8.10 done. locksChanged=${lockResult ? lockResult.changed : 0}, ` +
      `locksAlreadyCorrect=${lockResult ? lockResult.alreadyCorrect : 0}, ` +
      `locksVerified=${finalLockOk}, ` +
      `planner=${finalResult.plannerCount}, existing=${finalResult.existingCount}, final=${finalResult.finalCount}, ` +
      `changed=${finalResult.changedIndirectCount}, stationRemoved=${finalResult.removedStationCount}, responseIndirects=${indirectResponseCount}`;

    saveApproveTemplate(finalResult.payload, "live-direct-approve-sent-v8-9-clean-ux");

    if (finalLockOk) {
      setStatus(`Done: ${plannerEntries.length}/${plannerEntries.length} planned role lock(s) are correct. ${emptyApproval ? "SCC returned no approval map changes, but the lock state is correct." : "Approve response received."}`);
      toast(`Assigned ${plannerEntries.length}/${plannerEntries.length} planned role(s).`);
    } else if (emptyApproval && finalResult.changedIndirectCount > 0) {
      setStatus("SCC accepted /approve but returned no approval changes, and final lock verification failed. Refresh/check SCC, then copy console if it repeats.", true);
      toast("SCC returned no approval changes and verification failed.", true);
    } else {
      setStatus(lastInterceptSummary);
      toast("SCC unlock → lock → approve sent. Refresh/check SCC.");
    }

    renderPlan();
  }

  async function directApproveNow() {
    armed = false;
    renderPlan();

    const template = getApproveTemplate();
    if (!template) {
      setStatus("Direct approve blocked: no SCC /approve template saved yet.", true);
      toast("No /approve template saved yet. Seed it once using normal Review + Approve.", true);
      return;
    }

    const currentPlanId = getCurrentPagePlanId();
    if (currentPlanId && template.planId !== currentPlanId) {
      const msg =
        `Direct approve blocked: saved template is for a different SCC plan.\n\n` +
        `Template plan: ${template.planId}\n` +
        `Current page plan: ${currentPlanId}\n\n` +
        `Do one normal SCC Review + Approve once on this plan to seed a fresh template.`;
      setStatus("Direct approve blocked: template plan ID does not match current SCC plan.", true);
      alert(msg);
      return;
    }

    const result = buildModifiedApprovePayload(deepClone(template.payload));
    if (!result.ok) {
      setStatus(result.error, true);
      toast(result.error, true);
      return;
    }

    const summary =
      `DIRECT APPROVE will send SCC POST /approve now.\n\n` +
      `Mode: ${result.mode.toUpperCase()}\n` +
      `Planner indirects: ${result.plannerCount}\n` +
      `Existing SCC indirects in template: ${result.existingCount}\n` +
      `Final indirects sent: ${result.finalCount}\n` +
      `Plan: ${template.planId}\n\n` +
      `This bypasses the SCC Review button and commits directly. Continue?`;

    if (!window.confirm(summary)) {
      setStatus("Direct approve cancelled.");
      return;
    }

    setStatus("Sending direct SCC /approve...");
    console.log("[LCY2 SCC Injector] Direct /approve payload:", result.payload);

    const res = await fetch("/approve", {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "*/*",
        "Content-Type": "application/json;charset=UTF-8",
        "App-Token": SCC_APP_TOKEN,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify(result.payload)
    });

    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}

    if (!res.ok) {
      console.error("[LCY2 SCC Injector] Direct /approve failed:", res.status, parsed);
      setStatus(`Direct /approve failed ${res.status}. Check Console.`, true);
      toast(`Direct /approve failed ${res.status}`, true);
      return;
    }

    const emptyApproval =
      parsed &&
      typeof parsed === "object" &&
      (!parsed.leoPlanApproval) &&
      (!parsed.approvalIdSequence || parsed.approvalIdSequence.length === 0) &&
      (!parsed.approvedEmployeeIdToIndirectProcess || Object.keys(parsed.approvedEmployeeIdToIndirectProcess).length === 0);

    lastInterceptSummary =
      `Direct /approve sent. Mode=${result.mode}, planner=${result.plannerCount}, existing=${result.existingCount}, final=${result.finalCount}`;

    saveApproveTemplate(result.payload, "direct-approve-sent-v7");

    if (emptyApproval) {
      setStatus("SCC accepted /approve but returned no approval changes. The submitted map likely matched SCC's saved indirect map, or the template was stale. Try Clear template, seed again, then Direct Approve.", true);
      toast("SCC returned no approval changes. Clear/re-seed template.", true);
    } else {
      setStatus(lastInterceptSummary);
      toast("Direct SCC approve sent. Refresh/check SCC.");
    }

    renderPlan();

    console.log("[LCY2 SCC Injector] Direct /approve response:", parsed);
  }


  function installApproveHook() {
    if (window.__LCY2_SCC_APPROVE_INJECTOR_INSTALLED__) return;
    window.__LCY2_SCC_APPROVE_INJECTOR_INSTALLED__ = true;

    const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    pageWin[PAGE_BRIDGE_FN] = function processApproveBodyFromPage(originalBody) {
      let originalPayload = null;

      try {
        originalPayload = JSON.parse(originalBody || "{}");
      } catch (e) {
        if (armed) {
          return {
            action: "block",
            message: "Blocked /approve: could not parse SCC approve payload."
          };
        }
        return { action: "pass" };
      }

      // Always save a valid template, even when not armed.
      if (isApprovePayload(originalPayload)) {
        saveApproveTemplate(originalPayload, armed ? "captured-before-inject-v6" : "captured-normal-approve-v6");
        refreshTemplateStatus();
      }

      if (!armed) {
        setStatus("Captured SCC /approve template. Not armed, so normal approve passed through unchanged.");
        return { action: "pass" };
      }

      const result = buildModifiedApprovePayload(originalPayload);

      if (!result.ok) {
        armed = false;
        renderPlan();
        return { action: "block", message: result.error };
      }

      const summary =
        `SCC /approve intercepted.\n\n` +
        `Mode: ${result.mode.toUpperCase()}\n` +
        `Planner indirects: ${result.plannerCount}\n` +
        `Existing SCC indirects: ${result.existingCount}\n` +
        `Final indirects sent: ${result.finalCount}\n\n` +
        `This will commit to SCC when sent. Continue?`;

      const finalConfirm = !!document.getElementById("lcy2InjectorFinalConfirm")?.checked;

      if (finalConfirm && !window.confirm(summary)) {
        armed = false;
        renderPlan();
        return { action: "block", message: "Blocked /approve: user cancelled final confirmation." };
      }

      lastInterceptSummary =
        `Sent modified /approve. Mode=${result.mode}, planner=${result.plannerCount}, existing=${result.existingCount}, final=${result.finalCount}`;

      armed = false;
      saveApproveTemplate(result.payload, "modified-approve-sent-v6");
      renderPlan();
      setStatus(lastInterceptSummary);
      toast("Modified SCC /approve payload sent. Check SCC result.");

      console.log("[LCY2 SCC Injector v6] Original /approve payload:", originalPayload);
      console.log("[LCY2 SCC Injector v6] Modified /approve payload:", result.payload);

      return {
        action: "replace",
        body: JSON.stringify(result.payload),
        message: lastInterceptSummary
      };
    };

    // Install a page-context fetch hook. This is required because SCC's own app
    // calls window.fetch in the page context; a normal GM sandbox hook may not see it.
    const hookCode = `
      (function () {
        if (window["${PAGE_HOOK_FLAG}"]) return;
        window["${PAGE_HOOK_FLAG}"] = true;

        const BRIDGE = "${PAGE_BRIDGE_FN}";
        const originalFetch = window.fetch;

        function clean(v) { return String(v == null ? "" : v).trim(); }

        function isApproveUrl(url) {
          try {
            const u = new URL(url, location.origin);
            return u.pathname === "/approve";
          } catch (e) {
            return String(url || "") === "/approve";
          }
        }

        async function readBody(input, init) {
          try {
            if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
              const b = init.body;
              if (b == null) return "";
              if (typeof b === "string") return b;
              if (b instanceof Blob) return await b.text();
              if (b instanceof URLSearchParams) return b.toString();
              if (b instanceof FormData) {
                const obj = {};
                for (const [k, v] of b.entries()) obj[k] = String(v);
                return JSON.stringify(obj);
              }
              return JSON.stringify(b);
            }
            if (typeof Request !== "undefined" && input instanceof Request) {
              return await input.clone().text();
            }
          } catch (e) {
            console.warn("[LCY2 SCC Injector page hook] Could not read body", e);
          }
          return "";
        }

        window.fetch = async function lcy2PatchedFetch(input, init) {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          const method = (init && init.method) || (input && input.method) || "GET";

          if (clean(method).toUpperCase() === "POST" && isApproveUrl(url)) {
            const originalBody = await readBody(input, init);
            let decision = { action: "pass" };

            try {
              if (typeof window[BRIDGE] === "function") {
                decision = window[BRIDGE](originalBody) || { action: "pass" };
              }
            } catch (e) {
              console.error("[LCY2 SCC Injector page hook] Bridge failed", e);
              decision = { action: "block", message: "LCY2 injector bridge failed: " + (e && e.message ? e.message : e) };
            }

            if (decision.action === "block") {
              console.warn("[LCY2 SCC Injector page hook] Blocked /approve:", decision.message);
              return new Response(JSON.stringify({
                blockedByLCY2SccInjector: true,
                message: decision.message || "Blocked by LCY2 SCC injector"
              }), {
                status: 499,
                statusText: "Blocked by LCY2 SCC injector",
                headers: { "Content-Type": "application/json" }
              });
            }

            if (decision.action === "replace" && typeof decision.body === "string") {
              console.log("[LCY2 SCC Injector page hook] Replacing SCC /approve body before send.");
              if (typeof Request !== "undefined" && input instanceof Request) {
                const newReq = new Request(input, { body: decision.body });
                return originalFetch.call(this, newReq);
              }
              return originalFetch.call(this, input, Object.assign({}, init || {}, { body: decision.body }));
            }
          }

          return originalFetch.apply(this, arguments);
        };

        console.log("[LCY2 SCC Injector page hook v8.8] installed");
      })();
    `;

    const scriptEl = document.createElement("script");
    scriptEl.textContent = hookCode;
    (document.documentElement || document.head || document.body).appendChild(scriptEl);
    scriptEl.remove();

    console.log("[LCY2 SCC Approve Injector v8.8] userscript bridge + page hook installed");
  }

  function armInjector() {
    const { map, missing } = buildPlannerMap();

    if (missing.length) {
      setStatus(`Cannot arm: ${missing.length} missing numeric employee IDs. Click Fetch FCLM IDs.`, true);
      toast(`Cannot arm: ${missing.length} missing IDs`, true);
      renderPlan();
      return;
    }

    const count = Object.keys(map).length;
    if (!count) {
      setStatus("Cannot arm: no planned logins loaded.", true);
      toast("No planned logins loaded", true);
      return;
    }

    const mode = currentMode();
    const msg =
      `Arm SCC injector?\n\n` +
      `Date: ${currentDate || "(not loaded)"}\n` +
      `Planned indirects: ${count}\n` +
      `Mode: ${mode.toUpperCase()}\n\n` +
      (mode === "replace"
        ? "REPLACE means SCC's indirect role map will be replaced with the tracker plan."
        : "MERGE means tracker plan will overwrite/add planned logins but keep other SCC indirect roles.") +
      `\n\nAfter arming, click SCC Review, then Approve.`;

    if (!window.confirm(msg)) return;

    armed = true;
    renderPlan();
    setStatus(`ARMED. Now click SCC Review, then Approve. Mode: ${mode.toUpperCase()}`);
    toast("Injector armed — click SCC Review then Approve");
  }

  function disarmInjector() {
    armed = false;
    renderPlan();
    setStatus("Injector disarmed.");
  }

  function roleSummaryHtml(role) {
    const ready = role.logins.filter(x => isNumericEmployeeId(x.employeeId)).length;
    const missing = role.logins.length - ready;
    const alias = roleAliasLabel(role.role);
    const rows = role.logins.map(x => `
      <div class="lcy2-login-row ${isNumericEmployeeId(x.employeeId) ? "" : "missing"}">
        <span>${escapeHtml(x.login)}${x.note ? ` <small>(${escapeHtml(x.note)})</small>` : ""}</span>
        <code>${escapeHtml(x.employeeId || "missing ID")}</code>
      </div>
    `).join("");

    return `
      <div class="lcy2-role">
        <div class="lcy2-role-head">
          <b>${escapeHtml(role.role)} <span>${role.logins.length}/${role.required || 0}</span></b>
          <em title="Planner role → SCC role">${escapeHtml(alias)}</em>
        </div>
        <div class="lcy2-mini">${ready} IDs ready${missing ? `, ${missing} missing` : ""}</div>
        <details>
          <summary>Show logins</summary>
          <div class="lcy2-login-list">${rows || "--"}</div>
        </details>
      </div>
    `;
  }

  function renderPlan() {
    const box = document.getElementById("lcy2InjectorPlan");
    if (!box) return;
    refreshTemplateStatus();

    const total = currentPlan.reduce((a, r) => a + r.logins.length, 0);
    const missing = missingItems().length;
    const ready = total - missing;

    if (!currentPlan.length) {
      box.innerHTML = `
        <div class="lcy2-empty">No tracker plan loaded yet.</div>
      `;
      return;
    }

    box.innerHTML = `
      <div class="lcy2-total">
        <span><b>${total}</b> planned</span>
        <span><b>${ready}</b> IDs ready</span>
        <span><b class="${missing ? "bad-pill" : ""}">${missing}</b> missing</span>
      </div>
      ${currentPlan.map(roleSummaryHtml).join("")}
    `;
  }


  function textOf(el) {
    return clean((el && (el.textContent || el.value || el.getAttribute("aria-label") || el.title || el.getAttribute("data-testid"))) || "");
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  function clickableAncestor(el) {
    if (!el) return null;
    const clickable = el.closest?.("button,input[type='button'],input[type='submit'],a,[role='button'],.button,.btn,[onclick]");
    return clickable || el;
  }

  function findSccReplanButton() {
    // SCC sometimes renders these controls as real buttons, sometimes as styled spans/divs.
    // Search visible text first, then promote to the nearest clickable parent.
    const normal = Array.from(document.querySelectorAll("button,input[type='button'],input[type='submit'],a,[role='button'],.button,.btn,[onclick]"));
    let found = normal.find(el => el.id !== "lcy2SccLauncher" && /^replan$/i.test(textOf(el)) && isVisible(el));
    if (found) return clickableAncestor(found);

    const broad = Array.from(document.querySelectorAll("body *"));
    found = broad.find(el => {
      if (el.id === "lcy2SccLauncher" || el.closest?.("#lcy2ApproveInjectorPanel")) return false;
      if (!isVisible(el)) return false;
      const t = textOf(el);
      if (!/^replan$/i.test(t)) return false;
      const r = el.getBoundingClientRect();
      // Avoid random hidden/menu text; the SCC Replan button is normally in the top-right actions area.
      return r.top < Math.max(280, window.innerHeight * 0.45) && r.left > window.innerWidth * 0.45;
    });
    return clickableAncestor(found);
  }

  function findSccReviewButton() {
    const candidates = Array.from(document.querySelectorAll("button,input[type='button'],input[type='submit'],a,[role='button'],.button,.btn,[onclick],body *"));
    const found = candidates.find(el => {
      if (el.id === "lcy2SccLauncher" || el.closest?.("#lcy2ApproveInjectorPanel")) return false;
      if (!isVisible(el)) return false;
      const t = textOf(el).replace(/\s+/g, " ");
      return /^review\b/i.test(t) && el.getBoundingClientRect().left > window.innerWidth * 0.45;
    });
    return clickableAncestor(found);
  }

  function findSccActionBar() {
    const replan = findSccReplanButton();
    if (replan) return replan.parentElement || replan.closest("div") || null;
    const review = findSccReviewButton();
    if (review) return review.parentElement || review.closest("div") || null;
    return null;
  }

  function applyLauncherTextStyle(btn) {
    if (!btn) return;
    let span = btn.querySelector("#lcy2SccLauncherText");
    if (!span) {
      btn.textContent = "";
      span = document.createElement("span");
      span.id = "lcy2SccLauncherText";
      span.textContent = "Tracker";
      btn.appendChild(span);
    } else {
      span.textContent = "Tracker";
    }

    // Reset the text node harder than normal CSS. SCC injects some global
    // button/font styles; all:initial stops those inherited styles from leaking in.
    span.style.setProperty("all", "initial", "important");
    span.style.setProperty("display", "inline-block", "important");
    span.style.setProperty("font-family", "Arial, Helvetica, sans-serif", "important");
    span.style.setProperty("font-size", "11px", "important");
    span.style.setProperty("font-weight", "700", "important");
    span.style.setProperty("font-style", "normal", "important");
    span.style.setProperty("font-variant", "normal", "important");
    span.style.setProperty("font-variant-caps", "normal", "important");
    span.style.setProperty("font-feature-settings", "normal", "important");
    span.style.setProperty("font-kerning", "normal", "important");
    span.style.setProperty("font-stretch", "normal", "important");
    span.style.setProperty("line-height", "20px", "important");
    span.style.setProperty("color", "#ffffff", "important");
    span.style.setProperty("text-transform", "none", "important");
    span.style.setProperty("letter-spacing", "0", "important");
    span.style.setProperty("word-spacing", "0", "important");
    span.style.setProperty("text-shadow", "none", "important");
    span.style.setProperty("text-decoration", "none", "important");
    span.style.setProperty("white-space", "nowrap", "important");
  }

  function applyFallbackLauncherStyle(btn) {
    if (!btn) return;
    // Hard inline fallback so the button still appears even if SCC's toolbar cannot be found.
    // v8.31: force a full font reset on the launcher so SCC's global styles cannot make it look odd.
    btn.style.setProperty("all", "initial", "important");
    btn.style.setProperty("position", "fixed", "important");
    btn.style.setProperty("right", "118px", "important");
    btn.style.setProperty("top", "154px", "important");
    btn.style.setProperty("z-index", "2147483646", "important");
    btn.style.setProperty("display", "inline-flex", "important");
    btn.style.setProperty("align-items", "center", "important");
    btn.style.setProperty("justify-content", "center", "important");
    btn.style.setProperty("height", "24px", "important");
    btn.style.setProperty("min-width", "74px", "important");
    btn.style.setProperty("padding", "0 12px", "important");
    btn.style.setProperty("box-sizing", "border-box", "important");
    btn.style.setProperty("border-radius", "1px", "important");
    btn.style.setProperty("border", "1px solid #3f454b", "important");
    btn.style.setProperty("border-bottom-color", "#111827", "important");
    btn.style.setProperty("background", "#5f646b", "important");
    btn.style.setProperty("background-image", "none", "important");
    btn.style.setProperty("color", "#ffffff", "important");
    btn.style.setProperty("font", "700 11px/20px Arial, Helvetica, sans-serif", "important");
    btn.style.setProperty("font-style", "normal", "important");
    btn.style.setProperty("font-variant", "normal", "important");
    btn.style.setProperty("font-variant-caps", "normal", "important");
    btn.style.setProperty("font-feature-settings", "normal", "important");
    btn.style.setProperty("text-align", "center", "important");
    btn.style.setProperty("text-transform", "none", "important");
    btn.style.setProperty("letter-spacing", "0", "important");
    btn.style.setProperty("word-spacing", "0", "important");
    btn.style.setProperty("text-shadow", "none", "important");
    btn.style.setProperty("cursor", "pointer", "important");
    btn.style.setProperty("box-shadow", "none", "important");
    btn.style.setProperty("white-space", "nowrap", "important");
    btn.style.setProperty("appearance", "none", "important");
    btn.style.setProperty("-moz-appearance", "none", "important");
    applyLauncherTextStyle(btn);
  }

  function clearFallbackLauncherStyle(btn) {
    if (!btn) return;
    btn.removeAttribute("style");
  }

  function makeLauncherButton() {
    const btn = document.createElement("button");
    btn.id = "lcy2SccLauncher";
    btn.type = "button";
    btn.innerHTML = '<span id="lcy2SccLauncherText">Tracker</span>';
    btn.title = "Open Indirect Tracker → SCC approve";
    applyFallbackLauncherStyle(btn);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleDockedPanel();
    });
    launcherButton = btn;
    return btn;
  }


  function findExactVisibleButtonByText(label) {
    const wanted = String(label || "").trim().toLowerCase();
    const nodes = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a, div, span"));
    const matches = nodes.filter(el => {
      const txt = ((el.innerText || el.value || el.textContent || "") + "").trim().toLowerCase();
      if (txt !== wanted) return false;
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      // Ignore nav/tab/header/sidebar buttons and wrong tiny/hidden elements.
      if (r.width < 30 || r.height < 12) return false;
      // SCC Replan/Review are normally on the right half of the page.
      if (r.left < window.innerWidth * 0.55) return false;
      return true;
    });
    matches.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      // Prefer the top-right action row.
      return (br.left - ar.left) || (ar.top - br.top);
    });
    return matches[0] || null;
  }

  function findSccLegendAnchor() {
    // The empty area the user wants is immediately LEFT of SCC's status legend:
    // "At Station (LEO)  At Station (Override)  Clocked-In  Not Checked-In".
    // We only scan once when placing the launcher, not continuously, to avoid slowing SCC down.
    const nodes = Array.from(document.querySelectorAll("body *"));
    const matches = nodes.filter(el => {
      if (!el || el.id === "lcy2SccLauncher" || el.closest?.("#lcy2ApproveInjectorPanel")) return false;
      if (!isVisible(el)) return false;
      const txt = ((el.innerText || el.textContent || "") + "").replace(/\s+/g, " ").trim();
      if (!/At Station \(LEO\)/i.test(txt)) return false;
      const r = el.getBoundingClientRect();
      // Keep this targeted to the SCC top status/action row.
      if (r.top < 90 || r.top > 260) return false;
      if (r.left < window.innerWidth * 0.55) return false;
      if (r.width <= 0 || r.width > 620) return false;
      if (r.height <= 0 || r.height > 60) return false;
      return true;
    });

    matches.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      // Prefer the left-most visible legend wrapper with the smallest sensible area.
      const aArea = ar.width * ar.height;
      const bArea = br.width * br.height;
      return (ar.left - br.left) || (aArea - bArea);
    });

    return matches[0] || null;
  }

  function positionLauncherButton() {
    const btn = launcherButton || document.getElementById("lcy2SccLauncher");
    if (!btn || !document.body) return false;

    // Keep Tracker as a body-level fixed overlay. Do NOT append it inside SCC's
    // Replan/Review DOM wrapper or it can become part of SCC's hover popover.
    if (btn.parentElement !== document.body) document.body.appendChild(btn);

    btn.classList.remove("lcy2-docked-launcher");
    btn.classList.add("lcy2-floating-launcher");
    applyFallbackLauncherStyle(btn);

    // v8.31: preferred position is the empty strip immediately LEFT of SCC's status legend.
    // This is the yellow-circled area in the user's screenshot and stays clear of Replan/Review.
    const legend = findSccLegendAnchor();
    if (legend) {
      const r = legend.getBoundingClientRect();
      const bw = btn.offsetWidth || 74;
      const bh = btn.offsetHeight || 24;
      const gap = 12;

      let left = r.left - bw - gap;

      // v8.31: keep the x-position in the empty space left of the legend,
      // but align the y-position with SCC's real action buttons (Replan/Review).
      // Anchoring vertically to the legend text made the Tracker button sit too high.
      const actionAnchor = findExactVisibleButtonByText("Replan") || findSccReplanButton() || findExactVisibleButtonByText("Review") || findSccReviewButton();
      let top;
      if (actionAnchor && isVisible(actionAnchor)) {
        const ar = actionAnchor.getBoundingClientRect();
        top = ar.top + ((ar.height || 24) - bh) / 2;
      } else {
        top = r.top + ((r.height || 20) - bh) / 2 + 30;
      }

      // Keep it in the right-side empty header strip, but do not force it over Replan.
      const minLeft = Math.max(8, window.innerWidth * 0.58);
      left = Math.max(minLeft, Math.min(left, window.innerWidth - bw - 8));
      top = Math.max(90, Math.min(top, 260));

      btn.style.setProperty("position", "fixed", "important");
      btn.style.setProperty("left", Math.round(left) + "px", "important");
      btn.style.setProperty("right", "auto", "important");
      btn.style.setProperty("top", Math.round(top) + "px", "important");
      btn.style.setProperty("z-index", "2147483646", "important");
      return true;
    }

    // Fallback: if SCC changes the legend DOM, anchor left of Replan/Review.
    const replan = findExactVisibleButtonByText("Replan") || findSccReplanButton();
    const review = findExactVisibleButtonByText("Review") || findSccReviewButton();

    let target = null;
    for (const candidate of [replan, review]) {
      if (!candidate || !isVisible(candidate)) continue;
      const r = candidate.getBoundingClientRect();
      if (r.left > window.innerWidth * 0.55 && r.top > 90 && r.top < 260) {
        target = candidate;
        break;
      }
    }

    if (target) {
      const r = target.getBoundingClientRect();
      const bw = btn.offsetWidth || 74;
      const bh = btn.offsetHeight || 24;
      const gap = 10;

      let left = r.left - bw - gap;
      let top = r.top + ((r.height || 24) - bh) / 2;

      const minLeft = Math.max(8, window.innerWidth * 0.72);
      left = Math.max(minLeft, Math.min(left, window.innerWidth - bw - 8));
      top = Math.max(90, Math.min(top, 260));

      btn.style.setProperty("position", "fixed", "important");
      btn.style.setProperty("left", Math.round(left) + "px", "important");
      btn.style.setProperty("right", "auto", "important");
      btn.style.setProperty("top", Math.round(top) + "px", "important");
      btn.style.setProperty("z-index", "2147483646", "important");
      return true;
    }

    // Last fallback: top-right, just before SCC's normal action area.
    // This is still near Replan/Review, not the left side.
    btn.style.setProperty("position", "fixed", "important");
    btn.style.setProperty("left", "auto", "important");
    btn.style.setProperty("right", "240px", "important");
    btn.style.setProperty("top", "204px", "important");
    btn.style.setProperty("z-index", "2147483646", "important");
    return true;
  }

  function mountLauncherButton() {
    let existing = document.getElementById("lcy2SccLauncher");

    if (!existing) existing = makeLauncherButton();
    launcherButton = existing;
    applyFallbackLauncherStyle(existing);

    return positionLauncherButton();
  }

  function positionDockedPanel() {
    const panel = document.getElementById("lcy2ApproveInjectorPanel");
    const btn = launcherButton || document.getElementById("lcy2SccLauncher");
    if (!panel || !btn) return;

    const r = btn.getBoundingClientRect();
    const width = Math.min(390, Math.max(340, window.innerWidth - 24));
    panel.style.width = width + "px";

    const right = Math.max(8, window.innerWidth - r.right);
    const top = Math.min(Math.max(54, r.bottom + 8), Math.max(54, window.innerHeight - 160));

    panel.style.right = right + "px";
    panel.style.top = top + "px";
  }

  function openDockedPanel() {
    const panel = document.getElementById("lcy2ApproveInjectorPanel");
    if (!panel) return;
    panelOpen = true;
    panel.classList.add("open");
    positionDockedPanel();
    refreshTemplateStatus();
    renderPlan();
  }

  function closeDockedPanel() {
    const panel = document.getElementById("lcy2ApproveInjectorPanel");
    panelOpen = false;
    if (panel) panel.classList.remove("open");
  }

  function toggleDockedPanel() {
    let panel = document.getElementById("lcy2ApproveInjectorPanel");
    if (!panel) {
      try { buildPanel(); } catch (e) { console.error("[LCY2 SCC Injector v8.31] buildPanel failed", e); }
      panel = document.getElementById("lcy2ApproveInjectorPanel");
    }
    if (!panel) {
      toast("Tracker panel failed to build. Check console for v8.31 error.", true);
      return;
    }
    if (panel.classList.contains("open")) closeDockedPanel();
    else openDockedPanel();
  }

  function buildPanel() {
    if (document.getElementById("lcy2ApproveInjectorPanel")) return;

    const s = getSettings();
    const panel = document.createElement("div");
    panel.id = "lcy2ApproveInjectorPanel";
    panel.innerHTML = `
      <div class="lcy2-head">
        <b>Indirect Tracker → SCC v8.31</b>
        <button id="lcy2InjectorMin" type="button" title="Close">×</button>
      </div>
      <div class="lcy2-body">
        <input id="lcy2InjectorDataUrl" type="hidden" value="${escapeHtml(s.dataUrl)}" />
        <label class="lcy2-hidden"><input type="radio" name="lcy2InjectorMode" value="merge" checked> Merge</label>

        <div class="lcy2-row">
          <div>
            <label>Plan date</label>
            <input id="lcy2InjectorDate" type="date" value="${escapeHtml(s.date)}" />
          </div>
          <button id="lcy2InjectorLoad" type="button">Load plan</button>
        </div>

        <div id="lcy2ApproveInjectorStatus" class="lcy2-status">Ready. Load plan first.</div>

        <div class="lcy2-buttons">
          <button id="lcy2FetchFclmIds" type="button">Fetch FCLM IDs</button>
          <button id="lcy2LiveDirectApprove" type="button">Live direct approve</button>
        </div>

        <div id="lcy2InjectorPlan"></div>
      </div>
    `;

    document.body.appendChild(panel);

    const style = document.createElement("style");
    style.textContent = `
      #lcy2SccLauncher{
        all:initial !important;
        display:inline-flex !important;
        align-items:center !important;
        justify-content:center !important;
        height:24px !important;
        min-width:74px !important;
        padding:0 12px !important;
        border:1px solid #3f454b !important;
        border-bottom-color:#111827 !important;
        border-radius:1px !important;
        background:#5f646b !important;
        background-image:none !important;
        color:#fff !important;
        font:700 11px/20px Arial, Helvetica, sans-serif !important;
        font-variant:normal !important;
        font-variant-caps:normal !important;
        font-feature-settings:normal !important;
        text-transform:none !important;
        letter-spacing:0 !important;
        word-spacing:0 !important;
        text-shadow:none !important;
        text-align:center !important;
        cursor:pointer !important;
        box-shadow:none !important;
        vertical-align:middle !important;
        white-space:nowrap !important;
        appearance:none !important;
        -moz-appearance:none !important;
        box-sizing:border-box !important;
      }
      #lcy2SccLauncher #lcy2SccLauncherText{
        all:initial !important;
        display:inline-block !important;
        font:700 11px/20px Arial, Helvetica, sans-serif !important;
        font-variant:normal !important;
        font-variant-caps:normal !important;
        font-feature-settings:normal !important;
        color:#fff !important;
        text-transform:none !important;
        letter-spacing:0 !important;
        word-spacing:0 !important;
        text-shadow:none !important;
        text-decoration:none !important;
        white-space:nowrap !important;
      }
      #lcy2SccLauncher:hover{background:#4b5563 !important}
      #lcy2SccLauncher.lcy2-docked-launcher{
        margin-left:4px !important;
        margin-right:4px !important;
        position:relative !important;
        z-index:5 !important;
      }
      #lcy2SccLauncher.lcy2-floating-launcher{
        position:fixed !important;
        right:14px !important;
        top:154px !important;
        z-index:99999997 !important;
      }

      #lcy2ApproveInjectorPanel{
        display:none;
        position:fixed;
        right:12px;
        top:82px;
        width:380px;
        max-height:82vh;
        z-index:99999998;
        background:#fff;
        border:1px solid #9ca3af;
        border-radius:2px;
        box-shadow:0 8px 24px rgba(0,0,0,.22);
        overflow:hidden;
        font:12px/1.35 Arial, Helvetica, sans-serif !important;
        color:#111827 !important;
        text-transform:none !important;
        letter-spacing:0 !important;
        font-variant:normal !important;
        -webkit-font-smoothing:antialiased;
        text-rendering:optimizeLegibility;
      }
      #lcy2ApproveInjectorPanel,
      #lcy2ApproveInjectorPanel *{
        font-family:Arial, Helvetica, sans-serif !important;
        text-transform:none !important;
        letter-spacing:0 !important;
        font-variant:normal !important;
        box-sizing:border-box !important;
      }
      #lcy2ApproveInjectorPanel.open{display:block}
      #lcy2ApproveInjectorPanel .lcy2-hidden{display:none !important}

      #lcy2ApproveInjectorPanel .lcy2-head{
        height:28px;
        background:#001f33;
        color:#fff;
        padding:0 8px;
        display:flex;
        justify-content:space-between;
        align-items:center;
        border-bottom:1px solid #001427;
      }
      #lcy2ApproveInjectorPanel .lcy2-head b{
        font-size:12px !important;
        font-weight:700 !important;
        line-height:28px !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-head button{
        width:18px;
        height:18px;
        padding:0;
        border:0;
        border-radius:2px;
        background:#334155;
        color:#fff;
        font-size:13px !important;
        font-weight:700 !important;
        line-height:18px !important;
        cursor:pointer;
      }

      #lcy2ApproveInjectorPanel .lcy2-body{
        padding:8px;
        overflow:auto;
        max-height:calc(82vh - 29px);
        background:#fff;
      }
      #lcy2ApproveInjectorPanel label{
        display:block;
        margin:0 0 3px;
        color:#111827;
        font-size:11px !important;
        font-weight:700 !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-row{
        display:grid;
        grid-template-columns:1fr 94px;
        gap:6px;
        align-items:end;
        margin-bottom:6px;
      }
      #lcy2ApproveInjectorPanel input[type="text"],
      #lcy2ApproveInjectorPanel input[type="date"],
      #lcy2ApproveInjectorPanel input:not([type]){
        width:100%;
        height:24px;
        border:1px solid #b6beca;
        border-radius:2px;
        padding:2px 6px;
        background:#fff;
        color:#111827;
        font-size:12px !important;
        font-weight:400 !important;
      }
      #lcy2ApproveInjectorPanel button{
        min-height:24px;
        border:1px solid #9ca3af;
        border-radius:2px;
        background:#f3f4f6;
        color:#111827;
        padding:3px 8px;
        font-size:12px !important;
        font-weight:600 !important;
        line-height:1.1 !important;
        cursor:pointer;
      }
      #lcy2ApproveInjectorPanel button:hover{background:#e5e7eb}
      #lcy2ApproveInjectorPanel #lcy2InjectorLoad{
        background:#e5e7eb;
        color:#111827;
        border-color:#9ca3af;
      }
      #lcy2ApproveInjectorPanel #lcy2LiveDirectApprove{
        background:#15803d;
        color:#fff;
        border-color:#14532d;
      }
      #lcy2ApproveInjectorPanel #lcy2LiveDirectApprove:hover{background:#166534}
      #lcy2ApproveInjectorPanel .lcy2-buttons{
        display:flex;
        gap:5px;
        flex-wrap:wrap;
        margin:7px 0 6px;
      }

      #lcy2ApproveInjectorPanel .lcy2-status{
        margin:6px 0;
        padding:5px 7px;
        border:1px solid #cbd5e1;
        border-left:4px solid #15803d;
        border-radius:2px;
        background:#fff;
        color:#111827;
        font-size:12px !important;
        font-weight:600 !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-status.bad{
        border-color:#ef4444;
        border-left-color:#b91c1c;
        background:#fff;
        color:#991b1b;
      }

      #lcy2ApproveInjectorPanel .lcy2-total{
        display:flex;
        gap:4px;
        align-items:center;
        flex-wrap:wrap;
        padding:5px 0;
        margin:4px 0 6px;
        border-top:1px solid #e5e7eb;
        border-bottom:1px solid #e5e7eb;
      }
      #lcy2ApproveInjectorPanel .lcy2-total span{
        display:inline-flex;
        align-items:center;
        gap:4px;
        color:#374151;
        font-size:11px !important;
        font-weight:600 !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-total b{
        min-width:20px;
        height:18px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        border-radius:2px;
        background:#111827;
        color:#fff;
        padding:0 5px;
        font-size:11px !important;
        font-weight:700 !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-total b.bad-pill{background:#991b1b}

      #lcy2ApproveInjectorPanel .lcy2-role{
        border:1px solid #d1d5db;
        border-radius:2px;
        margin:6px 0;
        padding:6px;
        background:#fff;
      }
      #lcy2ApproveInjectorPanel .lcy2-role-head{
        display:flex;
        justify-content:space-between;
        gap:6px;
        align-items:center;
      }
      #lcy2ApproveInjectorPanel .lcy2-role-head b{
        font-size:12px !important;
        font-weight:700 !important;
        color:#111827 !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-role-head span{color:#b91c1c}
      #lcy2ApproveInjectorPanel .lcy2-role-head em{
        font-size:10px !important;
        color:#374151;
        font-style:normal;
        font-weight:600;
        background:#e5e7eb;
        border:1px solid #d1d5db;
        border-radius:2px;
        padding:2px 5px;
        white-space:nowrap;
      }
      #lcy2ApproveInjectorPanel .lcy2-mini{
        margin-top:3px;
        color:#4b5563;
        font-size:11px !important;
        font-weight:500 !important;
      }
      #lcy2ApproveInjectorPanel details summary{
        margin-top:4px;
        cursor:pointer;
        color:#111827;
        font-size:11px !important;
        font-weight:600 !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-login-list{margin-top:5px;display:grid;gap:2px}
      #lcy2ApproveInjectorPanel .lcy2-login-row{
        display:flex;
        justify-content:space-between;
        gap:6px;
        padding:3px 0;
        border-bottom:1px solid #e5e7eb;
        font-size:11px !important;
        color:#111827;
      }
      #lcy2ApproveInjectorPanel .lcy2-login-row.missing{color:#991b1b}
      #lcy2ApproveInjectorPanel .lcy2-login-row code{
        background:#f3f4f6;
        border:1px solid #e5e7eb;
        border-radius:2px;
        padding:1px 4px;
        color:#374151;
        font-size:10px !important;
        font-weight:500 !important;
      }
      #lcy2ApproveInjectorPanel .lcy2-login-row.missing code{
        background:#fee2e2;
        border-color:#fecaca;
        color:#991b1b;
      }
      #lcy2ApproveInjectorPanel .lcy2-empty{
        padding:12px 0;
        color:#4b5563;
        text-align:center;
        font-size:12px !important;
        font-weight:500 !important;
      }
    `;
    document.head.appendChild(style);

    document.getElementById("lcy2InjectorLoad").addEventListener("click", () => {
      loadTrackerData().catch(e => {
        console.error(e);
        setStatus(e.message || "Load failed", true);
        toast(e.message || "Load failed", true);
      });
    });

    document.getElementById("lcy2FetchFclmIds").addEventListener("click", () => {
      fetchFclmRosterIds().catch(e => {
        console.error(e);
        setStatus(e.message || "FCLM ID fetch failed", true);
        toast(e.message || "FCLM ID fetch failed", true);
      });
    });

    document.getElementById("lcy2LiveDirectApprove").addEventListener("click", () => {
      liveDirectApproveNow().catch(e => {
        console.error(e);
        setStatus(e.message || "Live Direct Approve failed", true);
        toast(e.message || "Live Direct Approve failed", true);
      });
    });

    document.querySelectorAll("input[name='lcy2InjectorMode']").forEach(el => {
      el.addEventListener("change", () => {
        saveSettings({
          mode: currentMode()
        });
      });
    });

    document.getElementById("lcy2InjectorMin").addEventListener("click", () => {
      closeDockedPanel();
    });

    renderPlan();
    refreshTemplateStatus();
  }

  function scheduleLauncherPosition(delay = 0) {
    clearTimeout(launchRepositionTimer);
    launchRepositionTimer = setTimeout(() => {
      try {
        mountLauncherButton();
        if (panelOpen) positionDockedPanel();
      } catch (e) {
        console.warn("[LCY2 SCC Injector v8.31] scheduled launcher position failed", e);
      }
    }, delay);
  }

  function startLightTimers() {
    if (templateStatusTimer) return;
    // Only refresh the panel status while the panel is open. This avoids work while SCC is loading.
    templateStatusTimer = setInterval(() => {
      if (panelOpen) refreshTemplateStatus();
    }, 5000);
  }

  function boot() {
    if (booted) return;
    if (!document.body) {
      setTimeout(boot, 150);
      return;
    }
    booted = true;

    console.info("[LCY2 SCC Injector v8.31] booting lightweight Tracker launcher");

    try {
      installApproveHook();
    } catch (e) {
      console.error("[LCY2 SCC Injector v8.31] approve hook install failed", e);
    }

    try {
      mountLauncherButton();
    } catch (e) {
      console.error("[LCY2 SCC Injector v8.31] mountLauncherButton failed, forcing fallback", e);
      const btn = launcherButton || document.getElementById("lcy2SccLauncher") || makeLauncherButton();
      if (document.body && btn.parentElement !== document.body) document.body.appendChild(btn);
      applyFallbackLauncherStyle(btn);
    }

    // v8.31 performance fix:
    // Older builds used a full-page MutationObserver plus an 800ms interval.
    // SCC is React-heavy, so that could slow or stall the first page load.
    // Now we only redock a few times after load, then on resize/scroll when needed.
    [600, 1500, 3500, 7000].forEach(ms => setTimeout(() => scheduleLauncherPosition(0), ms));

    startLightTimers();

    window.addEventListener("resize", () => scheduleLauncherPosition(150), { passive: true });
    window.addEventListener("scroll", () => {
      if (panelOpen) scheduleLauncherPosition(200);
    }, { passive: true, capture: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    setTimeout(boot, 0);
  }
})();
