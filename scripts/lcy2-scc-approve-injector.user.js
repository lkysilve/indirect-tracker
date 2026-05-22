// ==UserScript==
// @name         LCY2 SCC Approve Injector from Indirect Tracker
// @namespace    https://lkysilve.github.io/indirect-tracker/
// @version      8.17.0
// @description  Import Indirect Tracker Shift Planner roles into SCC. Ignores planner-only roles IT WS and Jam Buster. Maps PT to Tote Runner.
// @author       lkysilve
// @match        https://staffingcommandcenter-eu.aka.amazon.com/LCY2/plan/SINGLES_PACK/Singles/OB*
// @match        https://staffingcommandcenter-eu.aka.amazon.com/LCY2/plan/SINGLES_PACK/Singles/OB
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /********************************************************************
   * CONFIG
   ********************************************************************/

  const VERSION = "8.17.0";

  const WAREHOUSE_ID = "LCY2";
  const ZONE = "Singles";
  const SCHEDULE_NAME = "OB";
  const PROCESS = "SINGLES_PACK";

  const DEFAULT_TRACKER_URL =
    "https://lkysilve.github.io/indirect-tracker/data.json";

  const LS_DATA_URL = "lcy2_scc_tracker_data_url_v817";
  const LS_LAST_APPROVE_PAYLOAD = "lcy2_scc_last_approve_payload_v817";
  const LS_LAST_APPROVE_RESPONSE = "lcy2_scc_last_approve_response_v817";

  /********************************************************************
   * ROLE MAPPING
   ********************************************************************/

  const ROLE_TO_SCC_PROCESS = {
    "SLAM": "SLAM",

    "PG": "PROCESS_GUIDE",
    "PROCESS GUIDE": "PROCESS_GUIDE",

    "PS": "PROBLEM_SOLVER",
    "PROBLEM SOLVER": "PROBLEM_SOLVER",

    "WATER SPIDER": "WATER_SPIDER",
    "WATERSPIDER": "WATER_SPIDER",
    "WS": "WATER_SPIDER",

    // Shift Planner PT = SCC Tote Runner
    "PT": "TOTE_RUNNER",
    "TR": "TOTE_RUNNER",
    "TOTE RUNNER": "TOTE_RUNNER",

    "TEAM LEAD": "TEAM_LEAD",
    "TL": "TEAM_LEAD"
  };

  // Planner-only roles. These remain in the tracker but are NOT sent to SCC.
  // IT WS does not exist in SCC.
  // Jam Buster does not exist in SCC.
  const ROLE_IGNORE_FOR_SCC = new Set([
    "IT WS",
    "ITWS",
    "IT WATERSIDER",
    "IT WATER SPIDER",

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
    "TEAM_LEAD": "Team Lead"
  };

  function normalizeRole(role) {
    return String(role || "")
      .trim()
      .toUpperCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ");
  }

  function plannerRoleToSccProcess(role) {
    const key = normalizeRole(role);
    if (!key) return null;
    if (ROLE_IGNORE_FOR_SCC.has(key)) return null;
    return ROLE_TO_SCC_PROCESS[key] || null;
  }

  function isPlannerOnlyRole(role) {
    return ROLE_IGNORE_FOR_SCC.has(normalizeRole(role));
  }

  /********************************************************************
   * BASIC HELPERS
   ********************************************************************/

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(...args) {
    console.log("[LCY2 SCC Injector]", ...args);
  }

  function warn(...args) {
    console.warn("[LCY2 SCC Injector]", ...args);
  }

  function err(...args) {
    console.error("[LCY2 SCC Injector]", ...args);
  }

  function toast(message, type = "info", ms = 4500) {
    let box = document.getElementById("lcy2-scc-injector-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "lcy2-scc-injector-toast";
      box.style.cssText = `
        position:fixed;
        right:18px;
        bottom:24px;
        z-index:2147483647;
        max-width:420px;
        font-family:Arial,sans-serif;
      `;
      document.body.appendChild(box);
    }

    const item = document.createElement("div");
    const bg =
      type === "error" ? "#b91c1c" :
      type === "success" ? "#047857" :
      type === "warn" ? "#b45309" :
      "#0f172a";

    item.style.cssText = `
      margin-top:8px;
      padding:10px 12px;
      border-radius:10px;
      color:#fff;
      background:${bg};
      box-shadow:0 8px 24px rgba(0,0,0,.25);
      font-size:13px;
      font-weight:800;
      white-space:pre-wrap;
    `;
    item.textContent = message;
    box.appendChild(item);

    setTimeout(() => {
      item.remove();
    }, ms);
  }

  function safeJsonParse(value, fallback = null) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function getStoredJson(key) {
    return safeJsonParse(localStorage.getItem(key), null);
  }

  function setStoredJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function normalizeLogin(login) {
    return String(login || "")
      .trim()
      .toLowerCase();
  }

  function getText(el) {
    return String(el?.textContent || "").trim();
  }

  function todayIsoFromInputOrPage() {
    const input = document.querySelector("#lcy2-scc-plan-date");
    if (input?.value) return input.value;

    const select = document.querySelector("select");
    const text = select?.selectedOptions?.[0]?.textContent || "";
    const match = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
    if (match) {
      const date = new Date(`${match[1]} ${match[2]}, ${match[3]}`);
      if (!Number.isNaN(date.getTime())) return toIsoDate(date);
    }

    return toIsoDate(new Date());
  }

  function toIsoDate(date) {
    const d = new Date(date);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function dateKeyVariants(iso) {
    const [y, m, d] = iso.split("-");
    const dd = String(Number(d));
    const mm = String(Number(m));
    return [
      iso,
      `${d}/${m}/${y}`,
      `${dd}/${mm}/${y}`,
      `${d}-${m}-${y}`,
      `${dd}-${mm}-${y}`,
      `${y}/${m}/${d}`,
      `${y}${m}${d}`
    ];
  }

  function walk(obj, visitor, path = []) {
    if (!obj || typeof obj !== "object") return;
    visitor(obj, path);

    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, visitor, path.concat(String(i))));
    } else {
      Object.entries(obj).forEach(([k, v]) => walk(v, visitor, path.concat(k)));
    }
  }

  function getLikelyLogin(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return (
      obj.login ||
      obj.username ||
      obj.userName ||
      obj.alias ||
      obj.employeeLogin ||
      obj.associateLogin ||
      obj.nameLogin ||
      obj.user ||
      ""
    );
  }

  function getLikelyRole(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return "";
    return (
      obj.role ||
      obj.roleName ||
      obj.trainedRole ||
      obj.plannerRole ||
      obj.category ||
      obj.board ||
      obj.process ||
      obj.indirectRole ||
      ""
    );
  }

  function getLikelyEmployeeId(obj) {
    if (!obj || typeof obj !== "object") return "";
    return String(
      obj.employeeId ||
      obj.associateId ||
      obj.associatedId ||
      obj.id ||
      obj.personId ||
      obj.fclmId ||
      obj.badgeId ||
      ""
    ).trim();
  }

  /********************************************************************
   * NETWORK CAPTURE
   ********************************************************************/

  function installFetchCapture() {
    if (window.__lcy2SccInjectorFetchCaptureInstalled) return;
    window.__lcy2SccInjectorFetchCaptureInstalled = true;

    const originalFetch = window.fetch;

    window.fetch = async function patchedFetch(input, init) {
      const url =
        typeof input === "string"
          ? input
          : input && input.url
            ? input.url
            : "";

      const method = String(init?.method || "GET").toUpperCase();

      let requestBody = init?.body;

      const result = await originalFetch.apply(this, arguments);

      try {
        if (url.includes("/approve") && method === "POST") {
          const bodyText =
            typeof requestBody === "string"
              ? requestBody
              : requestBody
                ? String(requestBody)
                : "";

          const parsedPayload = safeJsonParse(bodyText, null);
          if (parsedPayload && parsedPayload.warehouseId === WAREHOUSE_ID) {
            setStoredJson(LS_LAST_APPROVE_PAYLOAD, {
              time: Date.now(),
              source: "fetch",
              url,
              payload: parsedPayload
            });
            log("Captured /approve request payload", parsedPayload);
          }

          const clone = result.clone();
          const responseText = await clone.text();
          const parsedResponse = safeJsonParse(responseText, null);

          if (parsedResponse) {
            setStoredJson(LS_LAST_APPROVE_RESPONSE, {
              time: Date.now(),
              source: "fetch",
              url,
              response: parsedResponse
            });
            log("Captured /approve response", parsedResponse);
          }
        }
      } catch (e) {
        warn("Fetch capture failed", e);
      }

      return result;
    };
  }

  function installXhrCapture() {
    if (window.__lcy2SccInjectorXhrCaptureInstalled) return;
    window.__lcy2SccInjectorXhrCaptureInstalled = true;

    const OriginalXHR = window.XMLHttpRequest;

    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let method = "";
      let url = "";
      let body = "";

      const originalOpen = xhr.open;
      xhr.open = function patchedOpen(m, u) {
        method = String(m || "GET").toUpperCase();
        url = String(u || "");
        return originalOpen.apply(xhr, arguments);
      };

      const originalSend = xhr.send;
      xhr.send = function patchedSend(b) {
        body = typeof b === "string" ? b : b ? String(b) : "";

        xhr.addEventListener("load", () => {
          try {
            if (url.includes("/approve") && method === "POST") {
              const parsedPayload = safeJsonParse(body, null);
              if (parsedPayload && parsedPayload.warehouseId === WAREHOUSE_ID) {
                setStoredJson(LS_LAST_APPROVE_PAYLOAD, {
                  time: Date.now(),
                  source: "xhr",
                  url,
                  payload: parsedPayload
                });
                log("Captured XHR /approve request payload", parsedPayload);
              }

              const parsedResponse = safeJsonParse(xhr.responseText, null);
              if (parsedResponse) {
                setStoredJson(LS_LAST_APPROVE_RESPONSE, {
                  time: Date.now(),
                  source: "xhr",
                  url,
                  response: parsedResponse
                });
                log("Captured XHR /approve response", parsedResponse);
              }
            }
          } catch (e) {
            warn("XHR capture failed", e);
          }
        });

        return originalSend.apply(xhr, arguments);
      };

      return xhr;
    }

    window.XMLHttpRequest = WrappedXHR;
  }

  /********************************************************************
   * CURRENT SCC PAGE DETAILS
   ********************************************************************/

  function getCurrentPlanIdFromPage() {
    const bodyText = document.body.innerText || "";
    const match = bodyText.match(/SCC Plan ID:\s*(LCY2-[a-f0-9-]+)/i);
    return match ? match[1] : "";
  }

  function getCurrentIntervalFromLastPayloadOrPage() {
    const captured = getStoredJson(LS_LAST_APPROVE_PAYLOAD);
    const payload = captured?.payload;

    const currentPlanId = getCurrentPlanIdFromPage();

    if (
      payload &&
      payload.planId &&
      (!currentPlanId || payload.planId === currentPlanId) &&
      payload.planInterval
    ) {
      return payload.planInterval;
    }

    return payload?.planInterval || null;
  }

  function approvalTimeToRequestValue(value) {
    if (!value) return Date.now() / 1000;
    const n = Number(value);
    if (!Number.isFinite(n)) return Date.now() / 1000;
    if (n > 1000000000000) return n / 1000;
    return n;
  }

  function getBaseApprovalPayload() {
    const capturedPayload = getStoredJson(LS_LAST_APPROVE_PAYLOAD);
    const capturedResponse = getStoredJson(LS_LAST_APPROVE_RESPONSE);

    const currentPlanId = getCurrentPlanIdFromPage();

    if (
      capturedResponse?.response?.leoPlanApproval &&
      (!currentPlanId || capturedResponse.response.leoPlanApproval.planId === currentPlanId)
    ) {
      const a = capturedResponse.response.leoPlanApproval;

      return {
        warehouseId: a.warehouseId || WAREHOUSE_ID,
        zone: a.approvalGroupName || ZONE,
        scheduleName: a.scheduleName || SCHEDULE_NAME,
        process: a.department || PROCESS,
        planId: a.planId || currentPlanId,
        planInterval: {
          startTime: Math.floor(Number(a.workInterval?.startTime || 0) / 1000),
          endTime: Math.floor(Number(a.workInterval?.endTime || 0) / 1000),
          shiftName: getCurrentShiftName()
        },
        lastApprovalTime: approvalTimeToRequestValue(a.approvalTime),
        employeeIdToIndirectProcessMap: clonePlain(a.employeeIdToIndirectProcessMap || {}),
        employeeIdToStationIdsMap: clonePlain(a.employeeIdToStationIdsMap || {}),
        stationIdToLaneStationMap: clonePlain(a.stationIdToLaneStationMap || {}),
        stationIdToAssignedRoleMap: clonePlain(
          a.stationIdToAssignedRoleMap || a.stationIdToRole || {}
        )
      };
    }

    if (
      capturedPayload?.payload &&
      (!currentPlanId || capturedPayload.payload.planId === currentPlanId)
    ) {
      return clonePlain(capturedPayload.payload);
    }

    if (capturedPayload?.payload) {
      return clonePlain(capturedPayload.payload);
    }

    return null;
  }

  function clonePlain(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  function getCurrentShiftName() {
    const select = document.querySelector("select");
    const text = select?.selectedOptions?.[0]?.textContent || "";
    if (/night/i.test(text)) return "NIGHT";
    if (/day/i.test(text)) return "DAY";
    return "NIGHT";
  }

  async function lockScc() {
    const res = await fetch(`/lock/${WAREHOUSE_ID}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "*/*"
      }
    });

    const text = await res.text();
    log("/lock response", res.status, text);

    if (!res.ok) {
      throw new Error(`/lock failed ${res.status}: ${text}`);
    }

    return text;
  }

  async function postApprove(payload) {
    log("POST /approve payload", payload);

    const res = await fetch("/approve", {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    const json = safeJsonParse(text, null);

    log("POST /approve response", res.status, json || text);

    if (!res.ok) {
      throw new Error(`/approve failed ${res.status}: ${text}`);
    }

    return json || text;
  }

  /********************************************************************
   * TRACKER DATA PARSING
   ********************************************************************/

  async function fetchTrackerData() {
    const url =
      document.getElementById("lcy2-scc-data-url")?.value?.trim() ||
      localStorage.getItem(LS_DATA_URL) ||
      DEFAULT_TRACKER_URL;

    localStorage.setItem(LS_DATA_URL, url);

    const bust = url.includes("?") ? `&_=${Date.now()}` : `?_=${Date.now()}`;
    const res = await fetch(url + bust, {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) {
      throw new Error(`Tracker data fetch failed ${res.status}`);
    }

    return await res.json();
  }

  function buildEmployeeIdMap(data) {
    const map = new Map();

    walk(data, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;

      const login = normalizeLogin(getLikelyLogin(node));
      const id = getLikelyEmployeeId(node);

      if (login && id && /^\d+$/.test(id)) {
        map.set(login, id);
      }
    });

    return map;
  }

  function findDayCandidates(data, isoDate) {
    const variants = new Set(dateKeyVariants(isoDate).map((x) => x.toLowerCase()));
    const candidates = [];

    walk(data, (node, path) => {
      if (!node || typeof node !== "object") return;

      const lastKey = path[path.length - 1];
      if (lastKey && variants.has(String(lastKey).toLowerCase())) {
        candidates.push(node);
        return;
      }

      if (!Array.isArray(node)) {
        const possibleDate =
          node.date ||
          node.planDate ||
          node.dayDate ||
          node.selectedDate ||
          node.isoDate ||
          node.day;

        if (possibleDate && variants.has(String(possibleDate).toLowerCase())) {
          candidates.push(node);
        }
      }
    });

    return candidates;
  }

  function collectPlannerEntriesFromDay(dayObj) {
    const entries = [];

    function add(role, item) {
      const login = normalizeLogin(getLikelyLogin(item));
      if (!login) return;

      const rawRole = role || getLikelyRole(item);
      if (!rawRole) return;

      entries.push({
        login,
        role: String(rawRole).trim(),
        raw: item
      });
    }

    function scanRoleContainer(container) {
      if (!container || typeof container !== "object") return;

      if (Array.isArray(container)) {
        container.forEach((item) => {
          const role = getLikelyRole(item);
          if (role) add(role, item);
        });
        return;
      }

      Object.entries(container).forEach(([key, value]) => {
        const keyRole = normalizeRole(key);
        const looksLikeRole =
          ROLE_TO_SCC_PROCESS[keyRole] ||
          ROLE_IGNORE_FOR_SCC.has(keyRole) ||
          ["SLAM", "PG", "PS", "PT", "WS", "WATER SPIDER", "PROBLEM SOLVER", "PROCESS GUIDE", "TEAM LEAD", "JAM BUSTER", "IT WS"].includes(keyRole);

        if (looksLikeRole) {
          if (Array.isArray(value)) {
            value.forEach((item) => add(key, item));
          } else if (value && typeof value === "object") {
            const inner =
              value.logins ||
              value.items ||
              value.people ||
              value.associates ||
              value.selected ||
              value.rows ||
              value.entries ||
              value.planned;

            if (Array.isArray(inner)) {
              inner.forEach((item) => add(key, item));
            } else {
              walk(value, (n) => {
                if (!n || typeof n !== "object" || Array.isArray(n)) return;
                const login = getLikelyLogin(n);
                if (login) add(key, n);
              });
            }
          } else if (typeof value === "string") {
            add(key, value);
          }
        }
      });
    }

    const likelyContainers = [
      dayObj.roles,
      dayObj.roleBoard,
      dayObj.roleBoards,
      dayObj.boards,
      dayObj.plan,
      dayObj.planned,
      dayObj.assignments,
      dayObj.shiftPlanner,
      dayObj.indirects,
      dayObj.categories,
      dayObj
    ];

    likelyContainers.forEach(scanRoleContainer);

    walk(dayObj, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const login = getLikelyLogin(node);
      const role = getLikelyRole(node);
      if (login && role) add(role, node);
    });

    const seen = new Set();
    return entries.filter((e) => {
      const key = `${e.login}|${normalizeRole(e.role)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extractPlannerEntries(data, isoDate) {
    const candidates = findDayCandidates(data, isoDate);

    let entries = [];
    for (const dayObj of candidates) {
      entries = entries.concat(collectPlannerEntriesFromDay(dayObj));
    }

    if (!entries.length) {
      const variants = new Set(dateKeyVariants(isoDate).map((x) => x.toLowerCase()));
      walk(data, (node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const login = getLikelyLogin(node);
        const role = getLikelyRole(node);
        const date =
          node.date ||
          node.planDate ||
          node.dayDate ||
          node.selectedDate ||
          node.isoDate ||
          node.day;

        if (login && role && date && variants.has(String(date).toLowerCase())) {
          entries.push({
            login: normalizeLogin(login),
            role: String(role).trim(),
            raw: node
          });
        }
      });
    }

    const seen = new Set();
    entries = entries.filter((e) => {
      const key = `${e.login}|${normalizeRole(e.role)}`;
      if (!e.login || !e.role || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return entries;
  }

  function buildPlannerSccMap(entries, employeeIdMap) {
    const planned = [];
    const ignored = [];
    const missingIds = [];

    for (const entry of entries) {
      const normalizedRole = normalizeRole(entry.role);

      if (isPlannerOnlyRole(normalizedRole)) {
        ignored.push(entry);
        continue;
      }

      const sccProcess = plannerRoleToSccProcess(normalizedRole);

      if (!sccProcess) {
        ignored.push(entry);
        continue;
      }

      const employeeId = employeeIdMap.get(normalizeLogin(entry.login));

      if (!employeeId) {
        missingIds.push(entry);
        continue;
      }

      planned.push({
        login: normalizeLogin(entry.login),
        employeeId,
        plannerRole: entry.role,
        sccProcess
      });
    }

    return { planned, ignored, missingIds };
  }

  /********************************************************************
   * APPROVE BUILDING
   ********************************************************************/

  function removeEmployeeEverywhere(payload, employeeId) {
    if (!employeeId) return;

    if (payload.employeeIdToIndirectProcessMap) {
      delete payload.employeeIdToIndirectProcessMap[employeeId];
    }

    if (payload.employeeIdToStationIdsMap) {
      delete payload.employeeIdToStationIdsMap[employeeId];
    }
  }

  function buildApprovePayloadFromPlanner(basePayload, plannedItems) {
    const payload = clonePlain(basePayload);

    payload.warehouseId = payload.warehouseId || WAREHOUSE_ID;
    payload.zone = payload.zone || ZONE;
    payload.scheduleName = payload.scheduleName || SCHEDULE_NAME;
    payload.process = payload.process || PROCESS;
    payload.planId = payload.planId || getCurrentPlanIdFromPage();

    payload.employeeIdToIndirectProcessMap =
      payload.employeeIdToIndirectProcessMap || {};

    payload.employeeIdToStationIdsMap =
      payload.employeeIdToStationIdsMap || {};

    payload.stationIdToLaneStationMap =
      payload.stationIdToLaneStationMap || {};

    payload.stationIdToAssignedRoleMap =
      payload.stationIdToAssignedRoleMap ||
      payload.stationIdToRole ||
      {};

    if (!payload.planInterval) {
      payload.planInterval = getCurrentIntervalFromLastPayloadOrPage();
    }

    payload.lastApprovalTime = approvalTimeToRequestValue(
      payload.lastApprovalTime || Date.now() / 1000
    );

    let changed = 0;
    let movedExisting = 0;

    for (const item of plannedItems) {
      const beforeIndirect =
        payload.employeeIdToIndirectProcessMap[item.employeeId];

      const beforeStation =
        payload.employeeIdToStationIdsMap[item.employeeId];

      if (beforeIndirect !== item.sccProcess || beforeStation) {
        changed++;
      }

      if (beforeIndirect && beforeIndirect !== item.sccProcess) {
        movedExisting++;
      }

      removeEmployeeEverywhere(payload, item.employeeId);
      payload.employeeIdToIndirectProcessMap[item.employeeId] = item.sccProcess;
    }

    return {
      payload,
      changed,
      movedExisting
    };
  }

  async function liveDirectApprove() {
    const isoDate = todayIsoFromInputOrPage();
    setStatus(`Loading tracker plan for ${isoDate}...`, "info");

    const data = await fetchTrackerData();
    const employeeIdMap = buildEmployeeIdMap(data);
    const entries = extractPlannerEntries(data, isoDate);
    const built = buildPlannerSccMap(entries, employeeIdMap);

    renderPlanSummary(built);

    if (!built.planned.length) {
      setStatus(
        `No SCC-sendable planner roles found for ${isoDate}. IT WS and Jam Buster are ignored.`,
        "error"
      );
      toast("No SCC-sendable planner roles found.", "error");
      return;
    }

    const basePayload = getBaseApprovalPayload();

    if (!basePayload) {
      setStatus(
        "No SCC approval base found. Do one normal SCC Review + Approve once, then try Live Direct Approve again.",
        "error"
      );
      alert(
        "No SCC approval base found.\n\nDo one normal SCC Review + Approve once on this plan so the script can capture the safe SCC payload, then try Live Direct Approve again."
      );
      return;
    }

    const currentPlanId = getCurrentPlanIdFromPage();
    if (currentPlanId && basePayload.planId && currentPlanId !== basePayload.planId) {
      const ok = confirm(
        "The captured SCC approval payload is for a different plan.\n\n" +
        `Current page plan: ${currentPlanId}\n` +
        `Captured plan: ${basePayload.planId}\n\n` +
        "Press OK only if you are sure this is safe."
      );

      if (!ok) return;
    }

    const { payload, changed, movedExisting } =
      buildApprovePayloadFromPlanner(basePayload, built.planned);

    const finalCount = Object.keys(payload.employeeIdToIndirectProcessMap || {}).length;

    const confirmText =
      "LIVE DIRECT APPROVE will send SCC POST /approve now.\n\n" +
      "Mode: MERGE\n" +
      `Planner SCC roles: ${built.planned.length}\n` +
      `Ignored planner-only roles: ${built.ignored.length}\n` +
      `Missing employee IDs: ${built.missingIds.length}\n` +
      `Changed planner roles: ${changed}\n` +
      `Moved from old role/station: ${movedExisting}\n` +
      `Final SCC indirects sent: ${finalCount}\n\n` +
      "Ignored roles include IT WS and Jam Buster.\n\n" +
      `Plan: ${payload.planId || "(unknown)"}\n\n` +
      "Continue?";

    if (!confirm(confirmText)) return;

    setStatus("Locking SCC plan...", "info");
    await lockScc();

    setStatus("Sending SCC /approve...", "info");
    const response = await postApprove(payload);

    const approvalSeq =
      response?.approvalIdSequence ||
      response?.leoPlanApproval?.approvalIdSequence ||
      [];

    const approvedIndirects =
      response?.approvedEmployeeIdToIndirectProcess ||
      response?.leoPlanApproval?.employeeIdToIndirectProcessMap ||
      {};

    const responseIndirectCount = Object.keys(approvedIndirects || {}).length;

    if (Array.isArray(approvalSeq) && approvalSeq.length) {
      setStatus(
        `SCC accepted. Approval changes: ${approvalSeq.length}. Refresh SCC to verify.`,
        "success"
      );
      toast("SCC accepted. Refresh/check SCC.", "success");
    } else if (responseIndirectCount) {
      setStatus(
        `SCC returned indirect map with ${responseIndirectCount} roles. Refresh SCC to verify.`,
        "success"
      );
      toast("SCC returned indirect roles. Refresh/check SCC.", "success");
    } else {
      setStatus(
        "SCC accepted the request but returned no approval changes. If the page did not change, SCC may already match or the base payload is stale.",
        "warn"
      );
      toast("SCC returned no approval changes.", "warn", 7000);
    }
  }

  /********************************************************************
   * UI
   ********************************************************************/

  function injectStyles() {
    if (document.getElementById("lcy2-scc-injector-style")) return;

    const style = document.createElement("style");
    style.id = "lcy2-scc-injector-style";
    style.textContent = `
      #lcy2-scc-tracker-btn {
        position: absolute;
        top: 118px;
        left: 8px;
        z-index: 999999;
        padding: 4px 12px;
        border: 1px solid #047857;
        border-radius: 3px;
        background: #059669;
        color: #fff;
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 1px 2px rgba(0,0,0,.25);
      }

      #lcy2-scc-tracker-btn:hover {
        background: #047857;
      }

      #lcy2-scc-panel {
        position: fixed;
        top: 118px;
        right: 18px;
        width: 375px;
        max-height: calc(100vh - 150px);
        overflow: auto;
        z-index: 2147483646;
        background: #f8fafc;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        box-shadow: 0 14px 42px rgba(15,23,42,.28);
        font-family: Arial, sans-serif;
        color: #0f172a;
      }

      #lcy2-scc-panel.lcy2-collapsed {
        width: auto;
        max-height: none;
        overflow: hidden;
      }

      #lcy2-scc-panel.lcy2-collapsed .lcy2-scc-body {
        display: none;
      }

      .lcy2-scc-head {
        background: #0f172a;
        color: #fff;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-weight: 900;
        font-size: 13px;
        cursor: move;
      }

      .lcy2-scc-head button {
        background: #334155;
        color: #fff;
        border: 0;
        border-radius: 8px;
        padding: 2px 8px;
        font-weight: 900;
        cursor: pointer;
      }

      .lcy2-scc-body {
        padding: 12px;
      }

      .lcy2-scc-label {
        font-size: 11px;
        font-weight: 900;
        margin: 8px 0 4px;
      }

      .lcy2-scc-input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 8px;
        font-size: 12px;
        background: #fff;
      }

      .lcy2-scc-row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 8px;
      }

      .lcy2-scc-btn {
        border: 1px solid #cbd5e1;
        border-radius: 9px;
        padding: 8px 10px;
        background: #fff;
        color: #0f172a;
        font-weight: 900;
        cursor: pointer;
        font-size: 12px;
      }

      .lcy2-scc-btn:hover {
        background: #f1f5f9;
      }

      .lcy2-scc-btn-green {
        background: #22c55e;
        border-color: #16a34a;
        color: #052e16;
      }

      .lcy2-scc-btn-green:hover {
        background: #16a34a;
        color: #fff;
      }

      .lcy2-scc-note {
        border: 1px dashed #cbd5e1;
        border-radius: 10px;
        padding: 9px;
        background: #fff;
        font-size: 11px;
        line-height: 1.35;
        margin-top: 10px;
      }

      .lcy2-scc-status {
        border-radius: 10px;
        padding: 9px;
        font-size: 12px;
        font-weight: 800;
        margin-top: 10px;
        white-space: pre-wrap;
      }

      .lcy2-scc-status.info {
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        color: #1e3a8a;
      }

      .lcy2-scc-status.success {
        background: #dcfce7;
        border: 1px solid #86efac;
        color: #14532d;
      }

      .lcy2-scc-status.warn {
        background: #fef3c7;
        border: 1px solid #f59e0b;
        color: #78350f;
      }

      .lcy2-scc-status.error {
        background: #fee2e2;
        border: 1px solid #fca5a5;
        color: #7f1d1d;
      }

      .lcy2-scc-pillrow {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }

      .lcy2-scc-pill {
        border-radius: 999px;
        background: #e2e8f0;
        padding: 5px 8px;
        font-size: 11px;
        font-weight: 900;
      }

      .lcy2-scc-rolebox {
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #fff;
        padding: 8px;
        margin-top: 8px;
        font-size: 12px;
      }

      .lcy2-scc-rolebox b {
        display: block;
        margin-bottom: 4px;
      }

      .lcy2-scc-small {
        font-size: 11px;
        color: #475569;
        line-height: 1.3;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureTrackerButton() {
    if (document.getElementById("lcy2-scc-tracker-btn")) return;

    const btn = document.createElement("button");
    btn.id = "lcy2-scc-tracker-btn";
    btn.textContent = "Tracker";
    btn.title = "Open Indirect Tracker SCC importer";
    btn.addEventListener("click", () => togglePanel());

    document.body.appendChild(btn);
  }

  function ensurePanel() {
    if (document.getElementById("lcy2-scc-panel")) return;

    const panel = document.createElement("div");
    panel.id = "lcy2-scc-panel";
    panel.style.display = "none";

    const storedUrl = localStorage.getItem(LS_DATA_URL) || DEFAULT_TRACKER_URL;
    const isoDate = toIsoDate(new Date());

    panel.innerHTML = `
      <div class="lcy2-scc-head" id="lcy2-scc-head">
        <span>INDIRECT TRACKER → SCC v${VERSION}</span>
        <button id="lcy2-scc-collapse" type="button">−</button>
      </div>

      <div class="lcy2-scc-body">
        <div class="lcy2-scc-label">Tracker data.json URL</div>
        <input id="lcy2-scc-data-url" class="lcy2-scc-input" value="${escapeHtml(storedUrl)}">

        <div class="lcy2-scc-label">Plan date</div>
        <input id="lcy2-scc-plan-date" class="lcy2-scc-input" type="date" value="${escapeHtml(isoDate)}">

        <div class="lcy2-scc-row">
          <button class="lcy2-scc-btn" id="lcy2-scc-load" type="button">Load plan</button>
          <button class="lcy2-scc-btn lcy2-scc-btn-green" id="lcy2-scc-direct" type="button">Live direct approve</button>
        </div>

        <div class="lcy2-scc-note">
          Uses tracker Shift Planner roles and sends SCC <b>POST /approve</b>.<br>
          <b>PT</b> is sent as <b>Tote Runner</b>.<br>
          <b>IT WS</b> and <b>Jam Buster</b> are ignored because SCC does not have those roles.
        </div>

        <div id="lcy2-scc-status" class="lcy2-scc-status info">
          Not armed. Load the plan first.
        </div>

        <div id="lcy2-scc-summary"></div>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById("lcy2-scc-collapse").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("lcy2-collapsed");
    });

    document.getElementById("lcy2-scc-load").addEventListener("click", async () => {
      try {
        await loadAndRenderPlan();
      } catch (e) {
        err(e);
        setStatus(e.message || String(e), "error");
      }
    });

    document.getElementById("lcy2-scc-direct").addEventListener("click", async () => {
      try {
        await liveDirectApprove();
      } catch (e) {
        err(e);
        setStatus(e.message || String(e), "error");
        toast(e.message || String(e), "error", 8000);
      }
    });

    makeDraggable(panel, document.getElementById("lcy2-scc-head"));
  }

  function togglePanel() {
    ensurePanel();
    const panel = document.getElementById("lcy2-scc-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  }

  function setStatus(message, type = "info") {
    const el = document.getElementById("lcy2-scc-status");
    if (!el) return;
    el.className = `lcy2-scc-status ${type}`;
    el.textContent = message;
  }

  async function loadAndRenderPlan() {
    const isoDate = todayIsoFromInputOrPage();

    setStatus(`Loading tracker plan for ${isoDate}...`, "info");

    const data = await fetchTrackerData();
    const employeeIdMap = buildEmployeeIdMap(data);
    const entries = extractPlannerEntries(data, isoDate);
    const built = buildPlannerSccMap(entries, employeeIdMap);

    renderPlanSummary(built);

    setStatus(
      `Loaded ${built.planned.length} SCC-sendable roles.\nIgnored planner-only: ${built.ignored.length}\nMissing IDs: ${built.missingIds.length}`,
      built.planned.length ? "success" : "warn"
    );
  }

  function renderPlanSummary(built) {
    const target = document.getElementById("lcy2-scc-summary");
    if (!target) return;

    const byRole = {};
    for (const item of built.planned) {
      byRole[item.sccProcess] = byRole[item.sccProcess] || [];
      byRole[item.sccProcess].push(item);
    }

    let html = `
      <div class="lcy2-scc-pillrow">
        <span class="lcy2-scc-pill">${built.planned.length} planned</span>
        <span class="lcy2-scc-pill">${built.ignored.length} ignored</span>
        <span class="lcy2-scc-pill">${built.missingIds.length} missing IDs</span>
      </div>
    `;

    for (const [role, items] of Object.entries(byRole)) {
      html += `
        <div class="lcy2-scc-rolebox">
          <b>${escapeHtml(SCC_PROCESS_LABEL[role] || role)} ${items.length}</b>
          <div class="lcy2-scc-small">${escapeHtml(items.map((x) => x.login).join(", "))}</div>
        </div>
      `;
    }

    if (built.ignored.length) {
      html += `
        <div class="lcy2-scc-rolebox">
          <b>Ignored planner-only</b>
          <div class="lcy2-scc-small">${escapeHtml(
            built.ignored.map((x) => `${x.login} (${x.role})`).join(", ")
          )}</div>
        </div>
      `;
    }

    if (built.missingIds.length) {
      html += `
        <div class="lcy2-scc-rolebox">
          <b>Missing employee IDs</b>
          <div class="lcy2-scc-small">${escapeHtml(
            built.missingIds.map((x) => `${x.login} (${x.role})`).join(", ")
          )}</div>
        </div>
      `;
    }

    target.innerHTML = html;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${Math.max(0, startLeft + dx)}px`;
      panel.style.top = `${Math.max(0, startTop + dy)}px`;
      panel.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
      document.body.style.userSelect = "";
    });
  }

  /********************************************************************
   * INIT
   ********************************************************************/

  function init() {
    installFetchCapture();
    installXhrCapture();
    injectStyles();
    ensurePanel();
    ensureTrackerButton();

    log(`v${VERSION} loaded`);
  }

  init();
})();
