import { REASONS, formatUsdz, shortHex, relativeTime, countdown, explorerUrl, isHash, summarize, feeOutcome } from "./format.js";

const POLL_MS = 3000;
const TOKEN_KEY = "court.operatorToken";
const APPROVER_KEY = "court.approver";
const STATUS_TONE = { RUNNING: "running", AWAITING_HUMAN: "warn", DECIDED: "", PUBLISHED: "", CLOSED: "ok", FAILED: "bad", FILER_MISMATCH: "bad" };

const state = {
  cases: new Map(),     // id -> full case JSON
  order: [],            // ids as listed
  selected: null,
  loaded: false,
  listError: null,
  open: new Set(),      // "caseId:claimId" drawers that are open
  notice: new Map(),    // caseId -> { kind, text } inline messages
  busy: new Set(),
  lastRender: new Map(),
};
const timers = []; // { node, at } countdown spans

// ---------- DOM helpers (textContent only) ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
  model: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z",
  human: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
  check: "M5 12.5l4.5 4.5L19 7.5",
  cross: "M6 6l12 12M18 6L6 18",
  help: "M9.2 9a3 3 0 1 1 4.3 2.7c-.9.5-1.5 1-1.5 2.1M12 17.5v.01",
  copy: "M9 9h10v10H9zM5 15V5h10",
  ext: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
};
function icon(name, size = 16) {
  const s = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", ICONS[name]);
  s.append(p);
  return s;
}
const chip = (status) => el("span", { class: `chip ${STATUS_TONE[status] ?? ""}`, text: status.replace(/_/g, " ") });
const mono = (text, extra = "") => el("span", { class: `mono ${extra}`, text, title: text });

function copyButton(value, label) {
  const b = el("button", { class: "icon-btn", type: "button", "aria-label": label, title: label });
  b.append(icon("copy", 14));
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(value); b.title = "Copied"; b.setAttribute("aria-label", "Copied"); setTimeout(() => { b.title = label; b.setAttribute("aria-label", label); }, 1500); } catch { b.title = "Copy failed"; }
  });
  return b;
}
function hashLink(hash, label) {
  if (!isHash(hash)) return null;
  const a = el("a", { href: explorerUrl(hash), target: "_blank", rel: "noopener noreferrer" }, label ?? shortHex(hash, 8, 6), " ", icon("ext", 12));
  return a;
}
function when(ms) {
  if (typeof ms !== "number") return "unknown";
  return relativeTime(ms, Date.now());
}

// ---------- API ----------
const token = () => { try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
async function api(path, opts = {}) {
  const headers = { accept: "application/json" };
  if (opts.method === "POST") headers["content-type"] = "application/json";
  if (opts.auth) headers["x-operator-token"] = token();
  const res = await fetch(path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: "no-store" });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data };
}

async function poll() {
  const pollDot = document.getElementById("poll");
  try {
    const list = await api("/cases");
    if (!list.ok || !Array.isArray(list.data)) throw new Error(`HTTP ${list.status}`);
    const details = await Promise.all(list.data.map((c) => api(`/cases/${encodeURIComponent(c.id)}`)));
    for (const d of details) if (d.ok && d.data) state.cases.set(d.data.id, d.data);
    state.order = list.data.map((c) => c.id).filter((id) => state.cases.has(id))
      .sort((a, b) => (state.cases.get(b).createdAt ?? 0) - (state.cases.get(a).createdAt ?? 0));
    state.listError = null;
    state.loaded = true;
    pollDot.className = "poll live";
  } catch (e) {
    state.listError = "Cannot reach the court API. Retrying.";
    pollDot.className = "poll err";
  }
  renderDocket();
  renderCase(false);
}

// ---------- Docket ----------
const docketRows = new Map(); // id -> { li, btn, id, chip, count, when }
function docketRow(id) {
  const r = {};
  r.id = el("span", { class: "di-id" });
  r.chip = el("span", { class: "chip" });
  r.seller = el("span", { class: "di-seller" });
  r.count = el("span", { class: "num" });
  r.when = el("span");
  r.btn = el("button", { class: "docket-item", type: "button", on: { click: () => select(id) } },
    el("div", { class: "row" }, r.id, r.chip), el("div", { class: "di-meta row" }, r.seller, r.count, r.when));
  r.li = el("li", { "data-id": id }, r.btn);
  return r;
}
function renderDocket() {
  const ul = document.getElementById("docket-list");
  const placeholder = (node) => { docketRows.clear(); ul.replaceChildren(node); };
  if (!state.loaded && !state.listError) { const f = document.createDocumentFragment(); for (let i = 0; i < 4; i++) f.append(el("li", { class: "skeleton" })); placeholder(f); return; }
  if (state.listError && state.order.length === 0) { placeholder(el("li", { class: "msg err", text: state.listError })); return; }
  if (state.order.length === 0) { placeholder(el("li", { class: "hint pad", text: "No cases yet. Filed disputes appear here." })); return; }
  for (const child of [...ul.children]) if (!child.dataset.id) child.remove();
  const live = new Set(state.order);
  for (const [id, r] of docketRows) if (!live.has(id)) { r.li.remove(); docketRows.delete(id); }
  state.order.forEach((id, i) => {
    let r = docketRows.get(id);
    if (!r) { r = docketRow(id); docketRows.set(id, r); }
    const c = state.cases.get(id);
    const s = summarize(c);
    r.id.textContent = shortHex(id, 10, 4);
    r.chip.className = `chip ${STATUS_TONE[c.status] ?? ""}`;
    r.chip.textContent = c.status.replace(/_/g, " ");
    r.seller.textContent = c.sellerName ?? c.seller ?? "";
    r.count.textContent = c.status === "RUNNING" && s.claims === 0 ? "Reviewing evidence" : `${s.claims} claim${s.claims === 1 ? "" : "s"} \u00b7 ${formatUsdz(s.refund)}`;
    r.when.textContent = when(c.createdAt);
    r.btn.setAttribute("aria-current", state.selected === id ? "true" : "false");
    if (ul.children[i] !== r.li) ul.insertBefore(r.li, ul.children[i] ?? null);
  });
}
function select(id) {
  state.selected = id;
  try { history.replaceState(null, "", `#${encodeURIComponent(id)}`); } catch { /* ignore */ }
  renderDocket();
  renderCase(true);
  document.getElementById("case").focus({ preventScroll: true });
}

// ---------- Case view ----------
function renderCase(force) {
  const host = document.getElementById("case");
  timers.length = 0;
  const c = state.selected ? state.cases.get(state.selected) : null;
  if (!c) {
    const msg = !state.loaded ? el("div", {}, el("strong", { text: "Loading docket" }), "Fetching cases from the court.")
      : state.order.length ? el("div", {}, el("strong", { text: "Select a case" }), "Choose a case from the docket to see its claims and evidence.")
        : el("div", {}, el("strong", { text: "No cases yet" }), "When a customer files a dispute it will appear in the docket.");
    host.replaceChildren(el("div", { class: "empty" }, msg));
    state.lastRender.clear();
    return;
  }
  const key = JSON.stringify(c) + JSON.stringify([...state.notice]) + [...state.busy].join(",") + state.selected;
  if (!force && state.lastRender.get("case") === key) return; // nothing changed: leave focus and scroll alone
  state.lastRender.set("case", key);
  const scroller = host.scrollTop;
  const active = document.activeElement;
  const refocus = active && host.contains(active) && active.dataset.focusId ? active.dataset.focusId : null;
  host.replaceChildren(el("div", { class: "stack" }, headerCard(c), complaintCard(c), claimsCard(c), reasoningCard(c), approvalCard(c), remedyCard(c)));
  host.scrollTop = scroller;
  if (refocus) host.querySelector(`[data-focus-id="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });
  tickCountdowns();
}

function headerCard(c) {
  const fee = feeOutcome(c);
  const feeTone = fee === "Refunded" || fee === "Refund due" ? "ok" : fee === "Forfeited" ? "warn" : "";
  const dd = (...k) => el("dd", {}, ...k);
  return el("section", { class: "card" },
    el("div", { class: "case-title" }, el("h1", { text: c.id }), chip(c.status)),
    c.error ? el("p", { class: "msg err", text: c.error }) : null,
    el("dl", { class: "facts" },
      el("div", {}, el("dt", { text: "Seller" }), dd(el("span", { text: c.sellerName ?? "Unknown" }), c.seller ? mono(shortHex(c.seller, 8, 6)) : null)),
      el("div", {}, el("dt", { text: "Payer" }), dd(mono(shortHex(c.payer, 8, 6)), copyButton(c.payer, "Copy payer address"))),
      el("div", {}, el("dt", { text: "Filing fee transaction" }), dd(c.feeTx ? (hashLink(c.feeTx) ?? mono(c.feeTx)) : el("span", { class: "faint", text: "None recorded" }))),
      el("div", {}, el("dt", { text: "Filing fee outcome" }), dd(el("span", { class: `chip ${feeTone}`, text: fee }), c.feeRefundTx ? hashLink(c.feeRefundTx, "refund tx") : null)),
      el("div", {}, el("dt", { text: "Filed" }), dd(el("span", { text: when(c.createdAt), title: typeof c.createdAt === "number" ? new Date(c.createdAt).toLocaleString() : "" }))),
      el("div", {}, el("dt", { text: "Transactions disputed" }), dd(el("span", { class: "num", text: String(c.txs?.length ?? 0) })))),
    null);
}

function complaintCard(c) {
  // The complaint text is not stored on the case today; show it only if the API supplies it.
  if (typeof c.complaint !== "string") return null;
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("h3", { text: "Complaint" }), el("span", { class: "chip untrusted", text: "Untrusted input" })),
    el("p", { class: "complaint", text: c.complaint }));
}

function findingOf(c, claimId) { return (c.findings ?? []).find((f) => f.claimId === claimId); }

function stateBadge(f) {
  if (!f) return el("span", { class: "faint", text: "Pending" });
  const map = {
    DIFFERENCE_CONFIRMED: ["bad", "check", "Difference confirmed"],
    NO_DIFFERENCE_FOUND: ["ok", "check", "No difference found"],
    COULD_NOT_BE_CHECKED: ["warn", "help", "Could not be checked"],
  };
  const [tone, ic, label] = map[f.state] ?? ["", "help", f.state];
  return el("div", {}, el("span", { class: `badge ${tone}` }, icon(ic, 14), label),
    f.state === "COULD_NOT_BE_CHECKED" && f.reason ? el("span", { class: "badge-reason", text: f.reason }) : null);
}
function verdictBadge(v) {
  const tone = v === "REFUND" ? "ok" : v === "ESCALATE" ? "warn" : "";
  return el("span", { class: `chip ${tone}`, text: v });
}
function decidedBy(d) {
  const label = { code: "Code", model: "Model", human: "Human" }[d] ?? d;
  return el("span", { class: "by", title: `Decided by ${label.toLowerCase()}` }, icon(d === "model" ? "model" : d === "human" ? "human" : "code", 15), label);
}

function claimsCard(c) {
  const claims = c.claims ?? [];
  let body;
  if (claims.length === 0) {
    body = el("p", { class: "hint", text: c.status === "RUNNING" ? "The court is reviewing the evidence. Claims will appear here." : "No claims were recorded for this case." });
  } else {
    const tbody = el("tbody");
    for (const claim of claims) {
      const ruling = (c.rulings ?? []).find((r) => r.claimId === claim.id);
      const r = REASONS[claim.code] ?? { name: claim.code, visa: null };
      const k = `${c.id}:${claim.id}`;
      const open = state.open.has(k);
      const toggle = el("button", { class: "btn ghost small", type: "button", "aria-expanded": String(open), "data-focus-id": `ev-${claim.id}`, on: { click: () => { open ? state.open.delete(k) : state.open.add(k); renderCase(true); } } }, open ? "Hide evidence" : "Evidence");
      tbody.append(el("tr", { class: "claim-row" },
        el("td", {}, el("span", { class: "code-id", text: claim.code }), el("span", { class: "code-name", text: r.name }), el("span", { class: "visa", text: r.visa ? `Visa ${r.visa}` : "No Visa analogue" })),
        el("td", {}, stateBadge(findingOf(c, claim.id))),
        el("td", {}, ruling ? verdictBadge(ruling.verdict) : el("span", { class: "faint", text: "Pending" })),
        el("td", {}, ruling ? ({ SELLER: "Seller", PRINCIPAL: "Customer", NONE: "None" }[ruling.liable] ?? ruling.liable) : "—"),
        el("td", { class: "amt" }, ruling ? formatUsdz(ruling.refund) : "—"),
        el("td", {}, ruling ? decidedBy(ruling.decidedBy) : "—"),
        el("td", {}, toggle)));
      if (open) tbody.append(el("tr", { class: "drawer" }, el("td", { colspan: "7" }, drawer(c, claim, ruling))));
    }
    body = el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ...["Reason code", "Finding", "Verdict", "Liable", "Refund", "Decided by", ""].map((h, i) => el("th", { class: i === 4 ? "amt" : "", text: h })))), tbody));
  }
  return el("section", { class: "card" }, el("div", { class: "card-head" }, el("h3", { text: "Claims" })), body);
}

function reasoningCard(c) {
  const rulings = c.rulings ?? [];
  if (rulings.length === 0) return null;
  const rows = rulings.map((r) => {
    const k = `why:${c.id}:${r.claimId}`;
    const open = state.open.has(k);
    const isModel = r.decidedBy === "model";
    const reason = isModel
      ? el("div", {}, el("p", { class: "rationale" + (open ? "" : " clamp3"), text: r.reason }),
          el("button", { class: "btn ghost small", type: "button", "aria-expanded": String(open), "data-focus-id": `why-${r.claimId}`, on: { click: () => { open ? state.open.delete(k) : state.open.add(k); renderCase(true); } } }, open ? "Hide model rationale" : "Show model rationale"))
      : el("p", { class: "rationale mono", text: r.reason });
    return el("li", { class: "why" },
      el("div", { class: "why-head" }, el("span", { class: "code-id", text: `${r.claimId} \u00b7 ${r.code}` }), verdictBadge(r.verdict), decidedBy(r.decidedBy)),
      reason);
  });
  return el("section", { class: "card" }, el("div", { class: "card-head" }, el("h3", { text: "Court's reasoning" })), el("ul", { class: "result-list" }, rows));
}

function prettyJson(v) { return typeof v === "string" ? v : JSON.stringify(v, null, 2); }
function evBlock(title, content) { return el("div", { class: "ev" }, el("h4", { text: title }), content); }

function drawer(c, claim, ruling) {
  const ev = c.evidence ?? {};
  const sale = ev[claim.tx];
  const receipt = ev[`receipt:${claim.tx}`];
  const acceptance = ev[`acceptance:${claim.tx}`];
  const blocks = [];
  blocks.push(evBlock("Signed request", el("pre", { text: sale?.resource ?? acceptance?.resource ?? "Not available" })));
  blocks.push(evBlock("Signed acceptance criteria", el("pre", { text: acceptance ? prettyJson({ verifier: acceptance.verifier, maxStalenessMs: acceptance.maxStalenessMs, maxDeviationBps: acceptance.maxDeviationBps, ...(acceptance.criteria ? { criteria: acceptance.criteria } : {}) }) : "No acceptance criteria were recorded" })));
  blocks.push(evBlock("Delivered body", el("pre", { text: receipt ? prettyJson(receipt.body) : "No delivery receipt was logged" })));
  if (receipt) {
    const a = receipt.anchored;
    blocks.push(evBlock("Receipt", el("div", {},
      el("div", { class: "row start" }, el("span", { class: "muted", text: "HTTP status" }), el("span", { class: "num", text: String(receipt.status) })),
      el("div", { class: "mt6" }, el("span", { class: "muted", text: "Response hash " }), el("span", { class: "mono wrap", text: receipt.responseHash })),
      el("div", { class: "mt6" }, el("span", { class: "badge " + (a === true ? "ok" : a === false ? "bad" : "warn") }, icon(a === true ? "check" : a === false ? "cross" : "help", 14), a === true ? "Anchored on chain" : a === false ? "Not anchored" : "Anchor not checked")))));
  }
  if (ruling && ruling.decidedBy !== "code") {
    blocks.push(evBlock(ruling.decidedBy === "model" ? "Model rationale" : "Ruling note", el("div", {},
      el("p", { class: "rationale", text: ruling.reason }),
      (ruling.evidence ?? []).length ? el("ul", { class: "keys" }, ...ruling.evidence.map((e) => el("li", { text: e }))) : null)));
  } else if (ruling) {
    blocks.push(evBlock("Finding reason", el("div", {}, el("p", { class: "rationale mono", text: ruling.reason }),
      (ruling.evidence ?? []).length ? el("ul", { class: "keys" }, ...ruling.evidence.map((e) => el("li", { text: e }))) : null)));
  }
  const pub = (c.publishResults ?? []).find((o) => o.tx === claim.tx && o.hash);
  const exe = (c.executeResults ?? []).find((o) => o.tx === claim.tx && o.hash);
  const anchorTx = receipt?.anchorTx ?? sale?.anchorTx;
  const links = [
    ["Payment", claim.tx], ["Anchor", anchorTx], ["Ruling", pub?.hash], ["Refund", exe?.hash],
  ].map(([label, h]) => el("span", {}, el("span", { class: "muted", text: `${label}: ` }), hashLink(h) ?? el("span", { class: "faint", text: "not yet" })));
  return el("div", {}, el("div", { class: "ev-grid" }, blocks), el("div", { class: "links" }, links));
}

// ---------- Human approval ----------
function approvalCard(c) {
  const pending = (c.rulings ?? []).filter((r) => r.verdict === "ESCALATE");
  if (pending.length === 0) return null;
  const note = state.notice.get(`${c.id}:approve`);
  const items = pending.map((r) => {
    const k = `${c.id}:${r.claimId}`;
    const can = BigInt(r.proposedRefund) > 0n;
    const act = (decision) => approve(c, r, decision);
    return el("div", { class: "approval-item" },
      el("div", {}, el("div", { class: "muted", text: `${r.claimId} · ${r.code} ${REASONS[r.code]?.name ?? ""}` }),
        el("div", { class: "amount-big", text: formatUsdz(r.proposedRefund) }),
        el("div", { class: "muted small", text: can ? "Proposed refund" : "No amount at stake" })),
      el("div", { class: "actions" },
        el("button", { class: "btn primary", type: "button", disabled: !can || state.busy.has(k), "data-focus-id": `ap-${r.claimId}`, on: { click: () => act("REFUND") } }, "Approve refund"),
        el("button", { class: "btn danger", type: "button", disabled: state.busy.has(k), on: { click: () => act("REJECT") } }, "Reject")));
  });
  return el("section", { class: "card approval" },
    el("div", { class: "card-head" }, el("h3", { text: "Human approval required" }), chip("AWAITING_HUMAN")),
    el("p", { class: "hint", text: "These claims could not be settled automatically. Your decision is bound to the amount shown." }),
    items, note ? el("p", { class: `msg ${note.kind}`, role: "alert", text: note.text }) : null);
}

function explain(res, what) {
  const msg = res.data?.error ?? `HTTP ${res.status}`;
  if (res.status === 401) return "Operator token missing or incorrect. Enter it at the top of the page.";
  if (res.status === 409) return `Not allowed right now: ${msg}.`;
  return `${what} failed: ${msg}.`;
}
async function approve(c, ruling, decision) {
  const approver = (document.getElementById("approver").value || "").trim();
  const k = `${c.id}:${ruling.claimId}`;
  const nk = `${c.id}:approve`;
  if (!approver) { state.notice.set(nk, { kind: "err", text: "Enter your approver name at the top of the page." }); renderCase(true); return; }
  state.busy.add(k); renderCase(true);
  try {
    const res = await api(`/cases/${encodeURIComponent(c.id)}/approve`, { method: "POST", auth: true, body: { claimId: ruling.claimId, decision, amount: String(ruling.proposedRefund), approver } });
    if (res.ok && res.data) { state.cases.set(c.id, res.data); state.notice.set(nk, { kind: "okmsg", text: decision === "REFUND" ? "Refund approved and recorded." : "Claim rejected and recorded." }); }
    else state.notice.set(nk, { kind: "err", text: explain(res, "Approval") });
  } catch { state.notice.set(nk, { kind: "err", text: "Network error. Nothing was changed." }); }
  state.busy.delete(k);
  renderDocket(); renderCase(true);
}

// ---------- Remedy ----------
const OUTCOME_LABEL = { published: "Published", skipped: "Skipped", already_ruled: "Already ruled", paid: "Paid", already_paid: "Already paid", objected: "Objected", not_yet: "Not yet due", failed: "Failed" };
const OUTCOME_TONE = { published: "ok", paid: "ok", already_paid: "ok", already_ruled: "", skipped: "", objected: "warn", not_yet: "warn", failed: "bad" };

function remedyCard(c) {
  const note = state.notice.get(`${c.id}:remedy`);
  const canPublish = c.status === "DECIDED" && (c.rulings ?? []).some((r) => r.verdict === "REFUND");
  const canExecute = c.status === "PUBLISHED" || c.status === "CLOSED";
  const run = (kind) => remedy(c, kind);
  const results = [];
  const add = (stage, list) => { for (const o of list ?? []) results.push([stage, o]); };
  add("Publish", c.publishResults); add("Execute", c.executeResults);
  const claimOf = (tx) => (c.rulings ?? []).find((r) => r.tx === tx)?.claimId;
  const list = results.length ? el("ul", { class: "result-list" }, ...results.map(([stage, o]) => {
    const t = el("span", { class: "chip " + (OUTCOME_TONE[o.status] ?? ""), text: OUTCOME_LABEL[o.status] ?? o.status });
    const li = el("li", {}, el("span", { class: "muted stage", text: stage }), t, mono(shortHex(o.tx, 8, 6)), claimOf(o.tx) ? el("span", { class: "faint", text: claimOf(o.tx) }) : null,
      o.hash ? hashLink(o.hash, "tx") : null, o.reason ? el("span", { class: "badge-reason", text: o.reason }) : null);
    if (o.status === "not_yet") {
      const span = el("span", { class: "num muted" });
      if (o.executableAt !== undefined) { timers.push({ node: span, at: o.executableAt }); li.append(span); }
      else li.append(el("span", { class: "faint", text: "Due time not reported" }));
    }
    return li;
  })) : el("p", { class: "hint mt12", text: "No remedy actions yet." });
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("h3", { text: "Remedy" }),
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", disabled: !canPublish || state.busy.has(`${c.id}:remedy`), "data-focus-id": "publish", on: { click: () => run("publish") } }, "Publish rulings"),
        el("button", { class: "btn primary", type: "button", disabled: !canExecute || state.busy.has(`${c.id}:remedy`), "data-focus-id": "execute", on: { click: () => run("execute") } }, "Execute refunds"))),
    el("p", { class: "hint", text: "Publish writes refund rulings on chain. Execute pays each ruling once its objection window has passed, then returns the filing fee if it is due." }),
    list,
    c.feeRefundTx ? el("p", { class: "mt12" }, el("span", { class: "muted", text: "Filing fee refund: " }), hashLink(c.feeRefundTx)) : null,
    c.feeRefundError ? el("p", { class: "msg err", text: `Filing fee refund failed: ${c.feeRefundError}` }) : null,
    note ? el("p", { class: `msg ${note.kind}`, role: "alert", text: note.text }) : null);
}
async function remedy(c, kind) {
  const k = `${c.id}:remedy`;
  state.busy.add(k); state.notice.delete(k); renderCase(true);
  try {
    const res = await api(`/cases/${encodeURIComponent(c.id)}/${kind}`, { method: "POST", auth: true, body: {} });
    if (res.data && res.data.id === c.id) state.cases.set(c.id, res.data);
    if (!res.ok) state.notice.set(k, { kind: "err", text: res.data?.id ? `Completed with a problem: ${res.data.feeRefundError ?? "see results above"}.` : explain(res, kind === "publish" ? "Publish" : "Execute") });
  } catch { state.notice.set(k, { kind: "err", text: "Network error. Check the case state before retrying." }); }
  state.busy.delete(k);
  renderDocket(); renderCase(true);
}

function tickCountdowns() {
  for (const t of timers) t.node.textContent = countdown(t.at, Date.now()) === null ? "" : `Executable in ${countdown(t.at, Date.now())}`.replace("Executable in ready now", "Ready to execute");
}

// ---------- Token form ----------
function initToken() {
  const t = document.getElementById("token"), a = document.getElementById("approver"), s = document.getElementById("token-state");
  try { t.value = sessionStorage.getItem(TOKEN_KEY) ?? ""; a.value = sessionStorage.getItem(APPROVER_KEY) ?? ""; } catch { /* storage blocked */ }
  const show = () => { s.textContent = t.value ? "Token set" : "No token"; };
  t.addEventListener("input", () => { try { t.value ? sessionStorage.setItem(TOKEN_KEY, t.value) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } show(); });
  a.addEventListener("input", () => { try { sessionStorage.setItem(APPROVER_KEY, a.value); } catch { /* ignore */ } });
  document.getElementById("token-form").addEventListener("submit", (e) => e.preventDefault());
  show();
}

// ---------- Boot ----------
initToken();
const initial = decodeURIComponent(location.hash.slice(1));
if (initial) state.selected = initial;
renderDocket(); renderCase(true);
poll();
setInterval(poll, POLL_MS);
setInterval(() => { tickCountdowns(); }, 1000);
