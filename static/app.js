/* Qiskit Circuit Mapper – frontend
 * Renders the compiled model produced by /api/compile:
 *   - physical backend (zoomable), logical qubits tracked across routing swaps
 *   - gates shown at their scheduled time (logical or native level)
 *   - timeline with per-logical-qubit lanes, play/pause, speed, step
 *   - logical circuit panel with execution tracking, hover highlighting and linking
 */
(() => {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
  const qubitColor = (i) => cssVar(SERIES[i % SERIES.length]);
  const KIND_VAR = { gate: "--k-gate", gate2: "--k-gate2", swap: "--k-swap", routing_swap: "--k-swap", measure: "--k-measure", reset: "--k-reset" };
  const kindOf = (item) => (item.kind === "gate" && item.qubits.length >= 2 ? "gate2" : item.kind);
  const kindColor = (item) => cssVar(KIND_VAR[kindOf(item)] || "--k-gate");
  const fmtTime = (ns) => {
    if (ns == null) return "–";
    if (Math.abs(ns) >= 10000) return (ns / 1000).toFixed(ns >= 100000 ? 1 : 2) + " µs";
    return String(Math.round(ns * 10) / 10) + " ns";
  };
  const fmtParam = (p) => {
    const r = p / Math.PI;
    for (const d of [1, 2, 3, 4, 6, 8]) {
      const n = r * d;
      if (Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) !== 0) {
        const k = Math.round(n);
        const num = k === 1 ? "π" : k === -1 ? "-π" : `${k}π`;
        return d === 1 ? num : `${num}/${d}`;
      }
    }
    return (Math.round(p * 1000) / 1000).toString();
  };
  const gateLabel = (name) => ({ measure: "M", reset: "R", swap: "SWAP", routing_swap: "SWAP" }[name] || name.toUpperCase());
  const bisectEnd = (arr, t) => {
    // number of items with end <= t (arr sorted by end)
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].end <= t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // -------------------------------------------------------------------- state
  const S = {
    model: null, D: null,          // raw model + derived data
    t: 0, playing: false, speed: 1, lastTick: null,
    level: "logical",              // 'logical' | 'native'
    showCircuit: false, circuitMode: "track",
    links: { qubits: new Set(), gates: new Set() },
    hover: null,                   // {type:'qubit', q} | {type:'gate', g} | {type:'swap', rid}
    selected: null,
    zoom: null, transform: d3.zoomIdentity, fitMode: false, bloch: { yaw: -0.6, pitch: 0.35 }, blochVec: null, blochColor: null, blochDrag: null,
    showUnused: true,
    examples: [], backends: [],
  };

  // ------------------------------------------------------------- derive model
  function prepare(model) {
    const L = model.logical, nL = L.num_qubits;
    const gates = L.gates;
    const routed = model.routed.map((r) => ({ ...r, level: "logical" }));
    const ops = model.ops.map((o) => ({ ...o, level: "native" }));
    const total = model.total_time || 1;
    const pulse = Math.max(total * 0.004, 1);

    // initial mapping logical -> physical
    const initial = new Array(nL).fill(null);
    Object.entries(model.layout.initial).forEach(([k, v]) => { initial[+k] = v; });
    const swaps = model.layout.swaps.slice().sort((a, b) => a.t - b.t);
    const mappingCache = [initial];
    const mappingAfter = (k) => {
      // mapping after the first k swaps
      while (mappingCache.length <= k) {
        const prev = mappingCache[mappingCache.length - 1].slice();
        const sw = swaps[mappingCache.length - 1];
        const [a, b] = sw.qubits;
        const la = prev.indexOf(a), lb = prev.indexOf(b);
        if (la >= 0) prev[la] = b;
        if (lb >= 0) prev[lb] = a;
        mappingCache.push(prev);
      }
      return mappingCache[k];
    };
    const mappingAt = (t) => {
      let k = 0;
      while (k < swaps.length && swaps[k].t <= t) k++;
      return mappingAfter(k);
    };

    // logical qubits touched by each routed record (routing swaps: whoever sits there)
    for (const r of routed) {
      if (r.origin != null) r.lqubits = gates[r.origin].qubits.slice();
      else {
        const m = mappingAt(r.start - 1e-9);
        r.lqubits = r.qubits.map((p) => m.indexOf(p)).filter((x) => x >= 0);
      }
    }
    for (const o of ops) {
      const r = routed[o.routed_id];
      o.lqubits = r ? r.lqubits : [];
    }
    // physical qubits per logical gate (for ghost markers): list of routed records
    const routedByGate = new Map();
    for (const r of routed) if (r.origin != null) {
      if (!routedByGate.has(r.origin)) routedByGate.set(r.origin, []);
      routedByGate.get(r.origin).push(r);
    }
    const opsByRouted = new Map();
    for (const o of ops) { if (!opsByRouted.has(o.routed_id)) opsByRouted.set(o.routed_id, []); opsByRouted.get(o.routed_id).push(o); }

    // timing of logical gates
    for (const g of gates) {
      const rs = routedByGate.get(g.id) || [];
      g.start = rs.length ? Math.min(...rs.map((r) => r.start)) : null;
      g.end = rs.length ? Math.max(...rs.map((r) => r.end)) : null;
    }
    // per logical qubit event list for status tracking
    const perQubit = Array.from({ length: nL }, () => []);
    for (const r of routed) for (const q of r.lqubits) perQubit[q].push(r);
    perQubit.forEach((arr) => arr.sort((a, b) => a.start - b.start || a.end - b.end));
    const statusOf = (q, t) => {
      const arr = perQubit[q];
      let last = null;
      for (const r of arr) { if (r.start <= t) last = r; else break; }
      if (!last) return "idle";
      if (last.kind === "measure" && last.end <= t) return "measured";
      return "active";
    };

    const opsByEnd = ops.slice().sort((a, b) => a.end - b.end || a.start - b.start || a.id - b.id);
    const eventsFor = (items) => {
      const set = new Set([0, total]);
      for (const it of items) { set.add(it.start); set.add(it.end); }
      return Array.from(set).sort((a, b) => a - b);
    };
    const events = { logical: eventsFor(routed), native: eventsFor(ops) };
    const starts = { logical: Array.from(new Set(routed.map((r) => r.start))).sort((a, b) => a - b),
                     native: Array.from(new Set(ops.map((o) => o.start))).sort((a, b) => a - b) };

    const simIndex = new Map();
    (model.sim.active_qubits || []).forEach((p, i) => simIndex.set(p, i));
    const everActive = new Set(model.sim.active_qubits || []);

    return { nL, gates, routed, ops, total, pulse, swaps, initial, mappingAt, routedByGate, opsByRouted, statusOf,
             opsByEnd, events, starts, simIndex, everActive, perQubit };
  }

  function activeItems(t) {
    const D = S.D;
    const items = S.level === "logical" ? D.routed : D.ops;
    return items.filter((it) => it.start <= t && (t < it.end || (it.end <= it.start && t < it.start + D.pulse)));
  }
  // is logical gate `gid` executing at time t?
  function gateRunning(gid, t = S.t) {
    const g = S.D.gates[gid];
    return !!g && g.start != null && g.start <= t && (t < g.end || (g.end <= g.start && t < g.start + S.D.pulse));
  }
  // linked gates that should currently be drawn as linked: in "track execution" mode only the running ones
  function visibleLinkedGates() {
    const all = Array.from(S.links.gates);
    return S.circuitMode === "track" ? all.filter((g) => gateRunning(g)) : all;
  }
  function frameAt(t) {
    const sim = S.model.sim;
    if (!sim.ok) return null;
    const k = bisectEnd(S.D.opsByEnd, t);
    return sim.frames[Math.min(k, sim.frames.length - 1)];
  }
  function blochOf(frame, phys) {
    if (!frame) return null;
    const i = S.D.simIndex.get(phys);
    return i == null ? null : frame.bloch[i];
  }

  // ------------------------------------------------------------- backend view
  const UNIT = 96, R = 20, R_IDLE = 9;
  const bsvg = d3.select("#backendSvg");
  const gRoot = bsvg.append("g").attr("class", "zoom-root");
  const gEdges = gRoot.append("g").attr("class", "edges");
  const gEdgesActive = gRoot.append("g").attr("class", "edges-active");
  const gNodes = gRoot.append("g").attr("class", "nodes");
  const gChips = gRoot.append("g").attr("class", "chips");
  let nodePos = [];

  S.zoom = d3.zoom().scaleExtent([0.2, 8]).on("zoom", (ev) => { S.transform = ev.transform; gRoot.attr("transform", ev.transform); drawLinks(); });
  bsvg.call(S.zoom).on("dblclick.zoom", null);

  function renderBackendStatic() {
    const B = S.model.backend;
    nodePos = B.coords.map(([x, y]) => [x * UNIT, y * UNIT]);
    gEdges.selectAll("line").data(B.edges).join("line").attr("class", "edge")
      .attr("x1", (e) => nodePos[e[0]][0]).attr("y1", (e) => nodePos[e[0]][1])
      .attr("x2", (e) => nodePos[e[1]][0]).attr("y2", (e) => nodePos[e[1]][1]);
    const nodes = gNodes.selectAll("g.node").data(d3.range(B.num_qubits)).join((enter) => {
      const g = enter.append("g").attr("class", "node");
      g.append("circle").attr("class", "halo");
      g.append("circle").attr("class", "body");
      g.append("text").attr("class", "llabel").attr("text-anchor", "middle").attr("dominant-baseline", "central");
      g.append("text").attr("class", "plabel").attr("text-anchor", "middle");
      const bg = g.append("g").attr("class", "badge-g");
      bg.append("circle").attr("class", "badge-bg").attr("r", 10);
      bg.append("text").attr("class", "badge").attr("text-anchor", "middle").attr("dominant-baseline", "central");
      return g;
    });
    nodes.attr("transform", (p) => `translate(${nodePos[p][0]},${nodePos[p][1]})`)
      .on("mouseenter", (ev, p) => onHoverPhys(p, ev)).on("mousemove", (ev) => moveTooltip(ev)).on("mouseleave", () => clearHover())
      .on("click", (ev, p) => onClickPhys(p, ev));
    fitChip(false);
  }

  function fitChip(animate = true, onlyUsed = false) {
    S.fitMode = onlyUsed;
    const svgEl = $("backendSvg");
    const w = svgEl.clientWidth, h = svgEl.clientHeight;
    let pts = nodePos;
    if (onlyUsed && S.D.everActive.size) pts = Array.from(S.D.everActive).map((p) => nodePos[p]);
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs) - UNIT, maxX = Math.max(...xs) + UNIT, minY = Math.min(...ys) - UNIT, maxY = Math.max(...ys) + UNIT * 0.8;
    const k = Math.min(onlyUsed ? 2.2 : 3, 0.92 * Math.min(w / (maxX - minX), h / (maxY - minY)));
    const tx = w / 2 - k * (minX + maxX) / 2, ty = h / 2 + 14 - k * (minY + maxY) / 2;
    const tr = d3.zoomIdentity.translate(tx, ty).scale(k);
    (animate ? bsvg.transition().duration(500) : bsvg).call(S.zoom.transform, tr);
  }

  function chipGeometry(items, t) {
    // position chips; stack when several share an anchor
    const anchors = new Map();
    const out = [];
    for (const it of items) {
      let x, y, key;
      if (it.qubits.length === 1) {
        const p = it.qubits[0];
        [x, y] = nodePos[p]; y -= R + 15; key = `n${p}`;
      } else {
        const [a, b] = it.qubits;
        x = (nodePos[a][0] + nodePos[b][0]) / 2; y = (nodePos[a][1] + nodePos[b][1]) / 2; key = `e${Math.min(a, b)}-${Math.max(a, b)}`;
      }
      const n = anchors.get(key) || 0; anchors.set(key, n + 1);
      const label = gateLabel(it.level === "native" ? it.name : it.kind === "routing_swap" ? "routing_swap" : it.name);
      const w = Math.max(30, label.length * 7.5 + 12);
      out.push({ it, x, y: y - n * 22, w, label, key: `${it.level}-${it.id}` });
    }
    // resolve remaining overlaps (e.g. a 1q chip under a chip sitting on a vertical edge) by pushing chips upwards
    out.sort((a, b) => b.y - a.y);
    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = out[i], b = out[j];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 3 && Math.abs(a.y - b.y) < 22) a.y = b.y - 22;
      }
    }
    return out;
  }

  function updateBackend() {
    if (!S.D) return;
    const t = S.t, D = S.D, B = S.model.backend;
    const mapping = D.mappingAt(t);
    const inv = new Map(); mapping.forEach((p, l) => { if (p != null) inv.set(p, l); });
    const frame = frameAt(t);
    const v0 = cssVar("--v0"), v1 = cssVar("--v1");
    const ramp = d3.interpolateLab(v0, v1);
    const hovQ = S.hover && S.hover.type === "qubit" ? S.hover.q : null;
    const hovG = S.hover && S.hover.type === "gate" ? S.hover.g : null;
    const hovSwapQs = S.hover && S.hover.type === "swap" ? S.hover.qs : null;

    gNodes.selectAll("g.node").each(function (p) {
      const g = d3.select(this);
      const l = inv.has(p) ? inv.get(p) : null;
      const used = l != null;
      const ever = D.everActive.has(p);
      g.classed("idle-phys", !used)
        .style("display", !used && !ever && !S.showUnused ? "none" : null);
      const status = used ? D.statusOf(l, t) : "idle";
      g.classed("notinit", used && status === "idle");
      g.classed("measured", used && status === "measured");
      const bl = used ? blochOf(frame, p) : null;
      const p1 = bl ? (1 - bl[2]) / 2 : null;
      const measured = frame && frame.measured[p] != null && status === "measured";
      g.select("circle.body").attr("r", used ? R : R_IDLE)
        .style("fill", used ? (status === "idle" ? null : p1 == null ? cssVar("--surface-2") : ramp(p1)) : null)
        .style("stroke", used ? qubitColor(l) : null);
      g.select("circle.halo").attr("r", used ? R + 6 : R_IDLE + 5);
      g.select("text.llabel").text(used ? `q${l}` : p)
        .style("font-size", used ? "11px" : "8px")
        .style("fill", used ? (p1 != null && p1 > 0.5 ? "#fff" : cssVar("--text-primary")) : cssVar("--text-muted"));
      g.select("text.plabel").attr("y", R + 3).text(used ? `P${p}` : "");
      const bg = g.select("g.badge-g").style("display", measured ? null : "none").attr("transform", `translate(${R - 3},${-R + 3})`);
      bg.select("text.badge").text(measured ? frame.measured[p] : "");
      const linked = used && S.showCircuit && S.links.qubits.has(l);
      const hl = used && S.showCircuit && (hovQ === l || (hovSwapQs && hovSwapQs.includes(l)));
      g.classed("linked", linked).classed("hl", hl);
    });

    // active items (chips + edges)
    const items = activeItems(t);
    const geo = chipGeometry(items, t);
    // ghost chips: hovered / linked logical gates not currently active (only when circuit shown)
    if (S.showCircuit) {
      const wanted = new Set(visibleLinkedGates());
      if (hovG != null) wanted.add(hovG);
      const activeOrigins = new Set(items.map((i) => i.origin).filter((o) => o != null));
      for (const gid of wanted) {
        if (activeOrigins.has(gid)) continue;
        const recs = D.routedByGate.get(gid) || [];
        const seen = new Set();
        for (const r of recs) {
          const key = r.qubits.join("-");
          if (seen.has(key)) continue; seen.add(key);
          geo.push(...chipGeometry([{ ...r, level: "ghost" }], t).map((c) => ({ ...c, ghost: true })));
        }
      }
    }
    const twoQ = items.filter((i) => i.qubits.length >= 2);
    gEdgesActive.selectAll("line").data(twoQ, (d) => `${d.level}-${d.id}`).join("line")
      .attr("class", "edge active2")
      .attr("x1", (d) => nodePos[d.qubits[0]][0]).attr("y1", (d) => nodePos[d.qubits[0]][1])
      .attr("x2", (d) => nodePos[d.qubits[1]][0]).attr("y2", (d) => nodePos[d.qubits[1]][1])
      .style("stroke", (d) => kindColor(d)).style("opacity", 0.55);
    // control / target end marks for 2q gates
    const marks = [];
    for (const d of twoQ) {
      const [a, b] = d.qubits;
      const dir = [nodePos[b][0] - nodePos[a][0], nodePos[b][1] - nodePos[a][1]];
      const len = Math.hypot(...dir) || 1; const u = [dir[0] / len, dir[1] / len];
      const pa = [nodePos[a][0] + u[0] * (R + 6), nodePos[a][1] + u[1] * (R + 6)];
      const pb = [nodePos[b][0] - u[0] * (R + 6), nodePos[b][1] - u[1] * (R + 6)];
      if (d.kind === "swap" || d.kind === "routing_swap") { marks.push({ k: `${d.level}-${d.id}a`, type: "x", p: pa, c: kindColor(d) }); marks.push({ k: `${d.level}-${d.id}b`, type: "x", p: pb, c: kindColor(d) }); }
      else if (/^(cx|cz|cy|ch|cp|crz|crx|cry|cu|cu1|cu3|csx|cs|csdg|ecr)$/.test(d.name)) { marks.push({ k: `${d.level}-${d.id}a`, type: "ctrl", p: pa, c: kindColor(d) }); marks.push({ k: `${d.level}-${d.id}b`, type: "tgt", p: pb, c: kindColor(d) }); }
    }
    gEdgesActive.selectAll("g.endmark").data(marks, (d) => d.k).join((enter) => {
      const g = enter.append("g").attr("class", "endmark");
      g.each(function (d) {
        const s = d3.select(this);
        if (d.type === "x") { s.append("path").attr("d", "M-5,-5L5,5M-5,5L5,-5").attr("stroke-width", 2.5).attr("fill", "none"); }
        else if (d.type === "ctrl") s.append("circle").attr("r", 5);
        else { s.append("circle").attr("r", 6).attr("fill", "none").attr("stroke-width", 2); s.append("path").attr("d", "M-6,0H6M0,-6V6").attr("stroke-width", 2); }
      });
      return g;
    }).attr("transform", (d) => `translate(${d.p[0]},${d.p[1]})`).each(function (d) { d3.select(this).selectAll("*").attr("stroke", d.c).attr("fill", function () { return this.tagName === "circle" && d.type === "ctrl" ? d.c : d3.select(this).attr("fill"); }); });

    const chips = gChips.selectAll("g.chip").data(geo, (d) => d.key + (d.ghost ? "-ghost" : "")).join((enter) => {
      const g = enter.append("g").attr("class", "chip");
      g.append("rect").attr("height", 19).attr("y", -9.5);
      g.append("text");
      return g;
    });
    chips.attr("transform", (d) => `translate(${d.x},${d.y})`)
      .classed("ghost", (d) => !!d.ghost)
      .classed("hl", (d) => S.showCircuit && hovG != null && d.it.origin === hovG)
      .classed("linked", (d) => S.showCircuit && d.it.origin != null && S.links.gates.has(d.it.origin) && (S.circuitMode !== "track" || gateRunning(d.it.origin)))
      .on("mouseenter", (ev, d) => onHoverItem(d.it, ev)).on("mousemove", (ev) => moveTooltip(ev)).on("mouseleave", () => clearHover())
      .on("click", (ev, d) => onClickItem(d.it, ev));
    chips.select("rect").attr("width", (d) => d.w).attr("x", (d) => -d.w / 2).style("fill", (d) => (d.ghost ? null : kindColor(d.it)));
    chips.select("text").text((d) => d.label);
    chips.sort((a, b) => (a.ghost ? 1 : 0) - (b.ghost ? 1 : 0));
    drawLinks();
  }

  // ------------------------------------------------------------- hover/click
  function onHoverPhys(p, ev) {
    const mapping = S.D.mappingAt(S.t); const l = mapping.indexOf(p);
    const frame = frameAt(S.t); const bl = l >= 0 ? blochOf(frame, p) : null;
    let html = `<b>Physical qubit P${p}</b>`;
    if (l >= 0) {
      const st = S.D.statusOf(l, S.t);
      html += `<br>holds <b style="color:${qubitColor(l)}">q${l}</b> · ${st === "idle" ? "not initialised" : st === "measured" ? "measured → " + (frame && frame.measured[p] != null ? frame.measured[p] : "?") : "initialised"}`;
      if (bl) html += `<br>P(|1⟩) = ${((1 - bl[2]) / 2).toFixed(3)}`;
    } else html += `<br><span class="muted">no logical qubit here</span>`;
    const qp = (S.model.backend.qubit_props || [])[p];
    if (qp && qp.t1_us != null) html += `<br><span class="muted">T1 ${qp.t1_us} µs · T2 ${qp.t2_us} µs</span>`;
    showTooltip(html, ev);
    if (l >= 0) setHover({ type: "qubit", q: l });
  }
  function onHoverItem(it, ev) {
    const g = it.origin != null ? S.D.gates[it.origin] : null;
    let html = `<b>${esc(gateLabel(it.kind === "routing_swap" ? "routing_swap" : it.name))}</b>`;
    if (it.params && it.params.length) html += ` (${it.params.map(fmtParam).join(", ")})`;
    html += `<br>${it.kind === "routing_swap" ? "inserted by the router" : `logical gate #${it.origin} <span class="muted">${esc(g ? g.name : "")} on q${it.lqubits.join(", q")}</span>`}`;
    html += `<br>physical P${it.qubits.join(", P")} · ${fmtTime(it.start)} → ${fmtTime(it.end)} (${fmtTime(it.end - it.start)})`;
    showTooltip(html, ev);
    if (it.origin != null) setHover({ type: "gate", g: it.origin });
    else setHover({ type: "swap", qs: it.lqubits, rid: it.routed_id ?? it.id });
  }
  function onClickPhys(p, ev) {
    const l = S.D.mappingAt(S.t).indexOf(p);
    if (l >= 0 && S.showCircuit && !ev.shiftKey) toggleLink("qubits", l);
    inspectQubit(l >= 0 ? l : null, p);
  }
  function onClickItem(it, ev) {
    if (it.origin != null && S.showCircuit && !ev.shiftKey) toggleLink("gates", it.origin);
    inspectItem(it);
  }
  function setHover(h) { S.hover = h; refreshHighlights(); }
  function clearHover() { S.hover = null; hideTooltip(); refreshHighlights(); }
  function refreshHighlights() { updateBackend(); updateCircuitClasses(); }
  function toggleLink(kind, id) {
    const set = S.links[kind];
    if (set.has(id)) set.delete(id); else set.add(id);
    updateLinkButtons();
    refreshHighlights();
  }
  function updateLinkButtons() {
    const allQ = S.D && S.links.qubits.size === S.D.nL;
    const gl = S.D ? S.D.gates.filter((g) => g.start != null) : [];
    const allG = gl.length && gl.every((g) => S.links.gates.has(g.id));
    $("linkQubitsBtn").textContent = allQ ? "Unlink all qubits" : "Link all qubits";
    $("linkGatesBtn").textContent = allG ? "Unlink all gates" : "Link all gates";
    $("linkQubitsBtn").classList.toggle("active", !!allQ);
    $("linkGatesBtn").classList.toggle("active", !!allG);
  }

  // ----------------------------------------------------------------- tooltip
  const tip = $("tooltip");
  function showTooltip(html, ev) { tip.innerHTML = html; tip.classList.remove("hidden"); moveTooltip(ev); }
  function moveTooltip(ev) {
    if (tip.classList.contains("hidden")) return;
    const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideTooltip() { tip.classList.add("hidden"); }

  // --------------------------------------------------------------- inspector
  function openInspector(title, html) {
    $("inspectorTitle").textContent = title; $("inspectorBody").innerHTML = html; $("inspector").classList.remove("hidden");
  }
  // Bloch sphere: orthographic 3D view, rotated by S.bloch (yaw, pitch). Drag to rotate, double-click to reset.
  function blochSvg(v, color) {
    S.blochVec = v; S.blochColor = color;
    return `<div class="bloch-box" data-bloch="thumb" title="Hold and drag to rotate · click to enlarge">${blochInner(false)}</div>`;
  }
  function blochInner(big = false) {
    const v = S.blochVec, color = S.blochColor;
    const R = 60, cx = 90, cy = 82;
    const { yaw, pitch } = S.bloch;
    const cY = Math.cos(yaw), sY = Math.sin(yaw), cP = Math.cos(pitch), sP = Math.sin(pitch);
    // rotate about z (yaw), then about x (pitch); returns [screenX, screenY, depth]; depth < 0 is the front
    const rot = ([x, y, z]) => {
      const x1 = x * cY - y * sY, y1 = x * sY + y * cY, z1 = z;
      return [x1, y1 * cP - z1 * sP, y1 * sP + z1 * cP];
    };
    const scr = (p) => { const [x, y, z] = rot(p); return [cx + R * x, cy - R * z, y]; };
    const seg = (p, q, dashedFront = false) => {
      const [x1, y1, d1] = scr(p), [x2, y2, d2] = scr(q);
      const front = d1 <= 0 && d2 <= 0;
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${front ? "var(--border-strong)" : "var(--border)"}" stroke-width="${front ? 1.2 : 1}" ${front ? "" : 'stroke-dasharray="2 3"'}/>`;
    };
    // great circle through unit vectors a and b
    const circle = (a, b) => {
      let out = "";
      const N = 48;
      for (let i = 0; i < N; i++) {
        const t1 = (i / N) * 2 * Math.PI, t2 = ((i + 1) / N) * 2 * Math.PI;
        const p = a.map((c, k) => Math.cos(t1) * c + Math.sin(t1) * b[k]);
        const q = a.map((c, k) => Math.cos(t2) * c + Math.sin(t2) * b[k]);
        out += seg(p, q);
      }
      return out;
    };
    const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    const axisLine = (dir, label) => {
      const [ex, ey, ed] = scr(dir.map((c) => c * 1.0));
      const [lx, ly] = scr(dir.map((c) => c * 1.28));
      const front = ed <= 0;
      return `<line x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="${front ? "none" : "3 3"}" opacity="${front ? 1 : 0.5}"/>
        <text class="bloch-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="10" fill="var(--text-secondary)" text-anchor="middle" dominant-baseline="central">${label}</text>`;
    };
    let svg = "";
    svg += circle(X, Y) + circle(Y, Z) + circle(X, Z);
    svg += axisLine(Z, "|0⟩") + axisLine(Z.map((c) => -c), "|1⟩") + axisLine(X, "x") + axisLine(Y, "y");
    if (v) {
      const [tx, ty] = scr(v);
      const ang = Math.atan2(ty - cy, tx - cx);
      const hx = tx, hy = ty;
      const head = `M${hx.toFixed(1)},${hy.toFixed(1)} L${(hx - 8 * Math.cos(ang - 0.4)).toFixed(1)},${(hy - 8 * Math.sin(ang - 0.4)).toFixed(1)} L${(hx - 8 * Math.cos(ang + 0.4)).toFixed(1)},${(hy - 8 * Math.sin(ang + 0.4)).toFixed(1)} Z`;
      svg += `<line x1="${cx}" y1="${cy}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${color}" stroke-width="2.5"/><path d="${head}" fill="${color}"/>`;
    }
    svg += `<circle cx="${cx}" cy="${cy}" r="2" fill="var(--text-muted)"/>`;
    const size = big ? 'width="360" height="340"' : 'width="180" height="170"';
    return `<svg class="bloch" ${size} viewBox="0 0 180 170" aria-label="Bloch sphere">${svg}</svg>`;
  }
  // Hold and drag to rotate; a click without movement opens the enlarged view.
  // Listeners live on document so they survive the inspector being re-rendered during playback.
  const DRAG_THRESHOLD = 4;
  function paintBlochs() {
    document.querySelectorAll('[data-bloch="thumb"]').forEach((el) => { el.innerHTML = blochInner(false); });
    if (S.blochOpen) $("blochPopBody").innerHTML = `<div class="bloch-box big" data-bloch="big">${blochInner(true)}</div>`;
  }
  function openBlochPopup() {
    S.blochOpen = true;
    $("blochPopBody").innerHTML = `<div class="bloch-box big" data-bloch="big">${blochInner(true)}</div>`;
    $("blochPop").classList.remove("hidden");
  }
  function closeBlochPopup() {
    S.blochOpen = false;
    $("blochPop").classList.add("hidden");
  }
  document.addEventListener("mousedown", (e) => {
    const box = e.target.closest && e.target.closest('[data-bloch]');
    if (!box) return;
    S.blochDrag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, big: box.dataset.bloch === "big" };
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!S.blochDrag) return;
    const d = S.blochDrag;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
    d.moved = true;
    S.bloch.yaw += (e.clientX - d.x) * 0.012;
    S.bloch.pitch = Math.max(-1.5, Math.min(1.5, S.bloch.pitch + (e.clientY - d.y) * 0.012));
    d.x = e.clientX; d.y = e.clientY;
    paintBlochs();
  });
  document.addEventListener("mouseup", (e) => {
    const d = S.blochDrag;
    S.blochDrag = null;
    if (d && !d.moved && !d.big && e.target.closest && e.target.closest('[data-bloch="thumb"]')) openBlochPopup();
  });
  // popup: close with the X, with a click outside the card, or Escape; double-click resets the view
  document.addEventListener("mousedown", (e) => { if (e.target.id === "blochPop") S.blochDownOutside = true; else S.blochDownOutside = false; });
  document.addEventListener("click", (e) => { if (S.blochOpen && e.target.id === "blochPop" && S.blochDownOutside) closeBlochPopup(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.blochOpen) closeBlochPopup(); });
  document.addEventListener("dblclick", (e) => {
    if (!e.target.closest || !e.target.closest('[data-bloch]')) return;
    S.bloch = { yaw: -0.6, pitch: 0.35 };
    paintBlochs();
  });

  function inspectQubit(l, p) {
    S.selected = { type: "qubit", l, p };
    renderInspector();
  }
  function inspectItem(it) {
    S.selected = { type: "item", it };
    renderInspector();
    fetchSchema(it.name, it.params, it.qubits.length, it.qubits);
  }
  function inspectLogicalGate(g) {
    S.selected = { type: "lgate", g };
    renderInspector();
    fetchSchema(g.name, g.params, g.qubits.length, null);
  }
  let schemaCache = new Map();
  async function fetchSchema(name, params, nq, qubits) {
    const key = JSON.stringify([name, params, nq, qubits, S.model.backend.name]);
    if (!schemaCache.has(key)) {
      const body = { name, params, num_qubits: nq, qubits, backend: $("backendSelect").value };
      schemaCache.set(key, fetch("/api/gate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()));
    }
    const schema = await schemaCache.get(key);
    const box = $("schemaBox");
    if (!box) return;
    let html = "";
    if (schema.error) html = `<p class="muted">${esc(schema.error)}</p>`;
    else {
      if (schema.doc) html += `<p>${esc(schema.doc)}</p>`;
      if (schema.png) html += `<img alt="gate drawing" src="${schema.png}">`;
      else if (schema.text) html += `<pre>${esc(schema.text)}</pre>`;
      if (schema.matrix) html += `<h3>Matrix</h3><table class="matrix">${schema.matrix.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
      if (schema.definition) html += `<h3>Definition (Qiskit)</h3>${schema.definition_png ? `<img alt="definition" src="${schema.definition_png}">` : `<pre>${esc(schema.definition)}</pre>`}`;
      if (schema.hardware) html += `<h3>On this backend</h3><dl class="kv"><dt>duration</dt><dd>${fmtTime(schema.hardware.duration_ns)}</dd><dt>gate error</dt><dd>${schema.hardware.error == null ? "–" : schema.hardware.error.toExponential(2)}</dd></dl>`;
    }
    box.innerHTML = html;
  }
  function renderInspector() {
    renderInspectorBody();
    if (S.blochOpen) paintBlochs();
  }
  function renderInspectorBody() {
    const sel = S.selected; if (!sel || !S.D) return;
    const D = S.D, t = S.t, frame = frameAt(t);
    const linkButton = (kind, id) => (S.showCircuit && id != null ? `<button class="btn small linkbtn" data-link="${kind}:${id}">${S.links[kind].has(id) ? "Unlink from circuit" : "Link to circuit"}</button>` : "");
    if (sel.type === "qubit") {
      const mapping = D.mappingAt(t);
      const l = sel.l != null ? sel.l : mapping.indexOf(sel.p);
      const p = l >= 0 ? mapping[l] : sel.p;
      const status = l >= 0 ? D.statusOf(l, t) : "idle";
      const bl = l >= 0 ? blochOf(frame, p) : null;
      const color = l >= 0 ? qubitColor(l) : cssVar("--text-muted");
      let html = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">${l >= 0 ? `<span class="qbadge" style="background:${color}">q${l}</span>` : ""}<span>on physical <b class="mono">P${p}</b></span>
        <span class="status-pill ${status}">${status === "idle" ? "not initialised" : status === "measured" ? "measured" : "initialised"}</span></div>`;
      if (l >= 0) {
        const hist = [`init → P${D.initial[l]}`];
        let cur = D.initial[l];
        D.swaps.forEach((sw, i) => { const m = D.mappingAt(sw.t); if (m[l] !== cur) { cur = m[l]; hist.push(`${fmtTime(sw.t)} → P${cur}`); } });
        html += `<h3>Position of q${l}</h3><div class="mono" style="font-size:11.5px">${hist.map((h, i) => `<span style="${D.swaps[i - 1] && D.swaps[i - 1].t > t ? "opacity:.45" : ""}">${esc(h)}</span>`).join(" · ")}</div>`;
      }
      if (bl) {
        const p1 = (1 - bl[2]) / 2;
        const len = Math.hypot(...bl);
        html += `<h3>Value ${S.model.sim.ok ? "(statevector)" : ""}</h3>
          <dl class="kv"><dt>P(|0⟩)</dt><dd>${(1 - p1).toFixed(4)}</dd><dt>P(|1⟩)</dt><dd>${p1.toFixed(4)}</dd>
          <dt>bloch</dt><dd>${bl.map((v) => v.toFixed(3)).join(", ")}</dd><dt>|r|</dt><dd>${len.toFixed(3)} ${len < 0.98 ? '<span class="muted">(mixed / entangled)</span>' : ""}</dd>
          ${frame && frame.measured[p] != null ? `<dt>measured</dt><dd>${frame.measured[p]}</dd>` : ""}</dl>
          <div class="pbar"><div style="width:${(p1 * 100).toFixed(1)}%"></div></div>${blochSvg(bl, color)}`;
      } else if (!S.model.sim.ok) html += `<p class="muted">${esc(S.model.sim.reason || "No simulation available.")}</p>`;
      const qp = (S.model.backend.qubit_props || [])[p] || {};
      const ro = (S.model.backend.readout_errors || {})[String(p)];
      html += `<h3>Physical qubit P${p}</h3><dl class="kv"><dt>T1</dt><dd>${qp.t1_us != null ? qp.t1_us + " µs" : "–"}</dd><dt>T2</dt><dd>${qp.t2_us != null ? qp.t2_us + " µs" : "–"}</dd><dt>frequency</dt><dd>${qp.freq_ghz != null ? qp.freq_ghz + " GHz" : "–"}</dd><dt>readout error</dt><dd>${ro ?? "–"}</dd></dl>`;
      if (l >= 0) html += linkButton("qubits", l);
      openInspector(l >= 0 ? `Qubit q${l} @ P${p}` : `Physical qubit P${p}`, html);
    } else if (sel.type === "item" || sel.type === "lgate") {
      const it = sel.it, g = sel.type === "lgate" ? sel.g : it.origin != null ? D.gates[it.origin] : null;
      const name = sel.type === "lgate" ? g.name : it.kind === "routing_swap" ? "routing SWAP" : it.name;
      const params = sel.type === "lgate" ? g.params : it.params;
      let html = `<div style="margin-bottom:6px"><span class="qbadge" style="background:${sel.type === "lgate" ? (g.qubits.length > 1 ? cssVar("--k-gate2") : cssVar("--k-gate")) : kindColor(it)}">${esc(gateLabel(name === "routing SWAP" ? "routing_swap" : name))}</span>
        ${params.length ? `<span class="mono">(${params.map(fmtParam).join(", ")})</span>` : ""}</div>`;
      const dl = [];
      if (g) dl.push(["logical gate", `#${g.id} ${esc(g.name)} on q${g.qubits.join(", q")}${g.clbits.length ? ` → c${g.clbits.join(", c")}` : ""}`]);
      if (sel.type === "lgate") {
        dl.push(["time", g.start == null ? "–" : `${fmtTime(g.start)} → ${fmtTime(g.end)}`]);
        const recs = D.routedByGate.get(g.id) || [];
        dl.push(["physical", recs.map((r) => `P${r.qubits.join(",P")}`).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || "–"]);
      } else {
        dl.push(["physical qubits", `P${it.qubits.join(", P")}`]);
        if (it.lqubits && it.lqubits.length) dl.push(["logical qubits", `q${it.lqubits.join(", q")}`]);
        dl.push(["start", fmtTime(it.start)], ["end", fmtTime(it.end)], ["duration", fmtTime(it.end - it.start)]);
        if (it.kind === "routing_swap") dl.push(["role", "moves logical qubits between physical qubits"]);
      }
      html += `<dl class="kv">${dl.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
      // native decomposition
      let ops = [];
      if (sel.type === "lgate") (D.routedByGate.get(g.id) || []).forEach((r) => ops.push(...(D.opsByRouted.get(r.id) || [])));
      else if (it.level === "logical") ops = D.opsByRouted.get(it.id) || [];
      if (ops.length && (sel.type === "lgate" || it.level === "logical")) {
        html += `<h3>Native ops (${ops.length})</h3><ul class="oplist">${ops.slice(0, 40).map((o) => `<li><span class="dot" style="background:${kindColor(o)}"></span>${esc(o.name)}${o.params.length ? `(${o.params.map(fmtParam).join(",")})` : ""} P${o.qubits.join(",P")} <span class="muted">${fmtTime(o.start)} +${fmtTime(o.duration)}</span></li>`).join("")}${ops.length > 40 ? `<li class="muted">… ${ops.length - 40} more</li>` : ""}</ul>`;
      }
      html += `<h3>Qiskit schema</h3><div id="schemaBox"><p class="muted">loading…</p></div>`;
      if (g) html += linkButton("gates", g.id);
      openInspector(sel.type === "lgate" ? `Gate #${g.id} ${g.name}` : `${name} on P${it.qubits.join(",P")}`, html);
      // (re)fill the schema box: the promise is cached, so repeated renders are cheap
      if (sel.type === "lgate") fetchSchema(g.name, g.params, g.qubits.length, null);
      else fetchSchema(it.name, it.params, it.qubits.length, it.qubits);
    }
    $("inspectorBody").querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", () => { const [k, id] = b.dataset.link.split(":"); toggleLink(k, +id); renderInspector(); }));
  }

  // ---------------------------------------------------------------- timeline
  const tsvg = d3.select("#timelineSvg");
  const TL = { left: 36, right: 12, top: 16, bottom: 4 };
  let tlScale = null;
  function renderTimelineStatic() {
    tsvg.selectAll("*").remove();
    if (!S.D) return;
    const D = S.D;
    const w = $("timelineSvg").clientWidth;
    const nLanes = D.nL;
    const laneH = Math.max(7, Math.min(12, (96 - TL.top - TL.bottom) / nLanes));
    const h = TL.top + TL.bottom + laneH * nLanes + 2;
    tsvg.attr("height", h);
    $("timelineSvg").style.height = h + "px";
    tlScale = d3.scaleLinear().domain([0, D.total]).range([TL.left, w - TL.right]);
    const unit = D.total >= 10000 ? "µs" : "ns";
    const axis = d3.axisTop(tlScale).ticks(Math.max(4, Math.min(12, w / 110))).tickSize(3).tickFormat((v) => (unit === "µs" ? (v / 1000).toFixed(1) : v));
    tsvg.append("g").attr("class", "tl-axis").attr("transform", `translate(0,${TL.top})`).call(axis).select(".domain").remove();
    tsvg.append("text").attr("class", "tl-lane-label").attr("x", 2).attr("y", TL.top - 5).text(unit);
    tsvg.append("rect").attr("class", "tl-track").attr("x", TL.left).attr("y", TL.top).attr("width", w - TL.left - TL.right).attr("height", laneH * nLanes).attr("rx", 3);
    const lanes = tsvg.append("g").attr("class", "lanes");
    for (let q = 0; q < nLanes; q++) {
      lanes.append("text").attr("class", "tl-lane-label").attr("x", TL.left - 4).attr("y", TL.top + laneH * q + laneH / 2).attr("text-anchor", "end").attr("dominant-baseline", "central").attr("fill", qubitColor(q)).style("fill", qubitColor(q)).text(`q${q}`).style("display", laneH >= 9 ? null : "none");
    }
    const items = S.level === "logical" ? D.routed : D.ops;
    const bars = [];
    for (const it of items) for (const q of it.lqubits) bars.push({ it, q });
    tsvg.append("g").attr("class", "bars").selectAll("rect").data(bars).join("rect").attr("class", "tl-bar")
      .attr("x", (d) => tlScale(d.it.start)).attr("y", (d) => TL.top + laneH * d.q + 1)
      .attr("width", (d) => Math.max(1.5, tlScale(d.it.end) - tlScale(d.it.start) - 0.5)).attr("height", laneH - 2).attr("rx", 1)
      .style("fill", (d) => kindColor(d.it))
      .on("mouseenter", (ev, d) => onHoverItem(d.it, ev)).on("mousemove", (ev) => moveTooltip(ev)).on("mouseleave", () => clearHover())
      .on("click", (ev, d) => { ev.stopPropagation(); seek(d.it.start); inspectItem(d.it); });
    // event ticks
    tsvg.append("g").attr("class", "events").selectAll("line").data(D.starts[S.level]).join("line").attr("class", "tl-event")
      .attr("x1", (d) => tlScale(d)).attr("x2", (d) => tlScale(d)).attr("y1", TL.top - 3).attr("y2", TL.top);
    // hit area for seeking
    const hit = tsvg.append("rect").attr("class", "tl-hit").attr("x", TL.left).attr("y", 0).attr("width", w - TL.left - TL.right).attr("height", h);
    const seekFromEvent = (ev) => { const [x] = d3.pointer(ev, tsvg.node()); seek(tlScale.invert(Math.max(TL.left, Math.min(w - TL.right, x)))); };
    hit.on("click", seekFromEvent);
    tsvg.call(d3.drag().filter(() => true).on("start drag", (ev) => { const x = Math.max(TL.left, Math.min(w - TL.right, ev.x)); seek(tlScale.invert(x)); }));
    const cur = tsvg.append("g").attr("class", "cursor");
    cur.append("line").attr("class", "tl-cursor").attr("y1", TL.top - 8).attr("y2", h);
    cur.append("path").attr("class", "tl-cursor-head").attr("d", "M-5,0L5,0L0,6Z").attr("transform", `translate(0,${TL.top - 9})`);
    updateTimeline();
  }
  function updateTimeline() {
    if (!tlScale) return;
    const x = tlScale(S.t);
    tsvg.select("g.cursor").attr("transform", `translate(${x},0)`);
    tsvg.selectAll("rect.tl-bar").classed("done", (d) => d.it.end <= S.t && d.it.end > d.it.start || (d.it.end <= d.it.start && d.it.start + S.D.pulse <= S.t));
    // fixed decimals and one shared unit, so the readout never changes width
    const big = S.D.total >= 10000;
    const fx = (ns) => (big ? (ns / 1000).toFixed(2) + " µs" : ns.toFixed(1) + " ns");
    $("timeNow").textContent = fx(S.t);
    $("timeTotal").textContent = fx(S.D.total);
    const act = activeItems(S.t);
    const names = act.slice(0, 6).map((a) => `${gateLabel(a.kind === "routing_swap" ? "routing_swap" : a.name)}${a.qubits.length > 1 ? "" : ""} P${a.qubits.join(",")}`);
    $("eventReadout").textContent = act.length ? `${act.length} active: ${names.join(" · ")}${act.length > 6 ? " …" : ""}` : S.t >= S.D.total ? "finished" : "idle";
  }

  // ---------------------------------------------------------------- playback
  function seek(t) {
    S.t = Math.max(0, Math.min(S.D ? S.D.total : 0, t));
    renderAll();
  }
  function renderAll() {
    if (!S.D) return;
    updateBackend(); updateTimeline(); updateCircuitClasses(); if (S.selected) renderInspector();
  }
  function tick(ts) {
    if (!S.playing) return;
    if (S.lastTick != null) {
      const dt = (ts - S.lastTick) / 1000;
      const rate = (S.D.total / 30) * S.speed; // 1x = whole circuit in 30 s
      S.t += dt * rate;
      if (S.t >= S.D.total) { S.t = S.D.total; setPlaying(false); }
      renderAll();
    }
    S.lastTick = ts;
    if (S.playing) requestAnimationFrame(tick);
  }
  function setPlaying(on) {
    if (!S.D) return;
    if (on && S.t >= S.D.total) S.t = 0;
    S.playing = on; S.lastTick = null;
    $("playBtn").innerHTML = on ? "&#x23F8;" : "&#x25B6;";
    if (on) requestAnimationFrame(tick);
  }
  function stepEvent(dir) {
    const ev = S.D.events[S.level];
    const eps = 1e-6;
    let target;
    if (dir > 0) target = ev.find((e) => e > S.t + eps);
    else { const before = ev.filter((e) => e < S.t - eps); target = before.length ? before[before.length - 1] : 0; }
    if (target == null) target = S.D.total;
    setPlaying(false); seek(target);
  }

  // ------------------------------------------------------------ logical view
  const csvg = d3.select("#circuitSvg");
  const CG = { left: 150, cw: 46, rh: 38, top: 16 };
  function renderCircuitStatic() {
    csvg.selectAll("*").remove();
    if (!S.D) return;
    const D = S.D, L = S.model.logical;
    const cols = Math.max(1, L.columns);
    const hasC = L.num_clbits > 0;
    const w = CG.left + cols * CG.cw + 30, h = CG.top + (D.nL + (hasC ? 1 : 0)) * CG.rh + 10;
    csvg.attr("width", w).attr("height", h);
    const yq = (q) => CG.top + q * CG.rh + CG.rh / 2;
    const yc = CG.top + D.nL * CG.rh + CG.rh / 2;
    const xg = (c) => CG.left + c * CG.cw + CG.cw / 2;
    // wires
    const wires = csvg.append("g");
    for (let q = 0; q < D.nL; q++) wires.append("line").attr("class", "wire").attr("x1", CG.left - 6).attr("x2", w - 10).attr("y1", yq(q)).attr("y2", yq(q)).style("stroke", qubitColor(q));
    if (hasC) { wires.append("line").attr("class", "cwire").attr("x1", CG.left - 6).attr("x2", w - 10).attr("y1", yc - 2).attr("y2", yc - 2); wires.append("line").attr("class", "cwire").attr("x1", CG.left - 6).attr("x2", w - 10).attr("y1", yc + 2).attr("y2", yc + 2); wires.append("text").attr("class", "tl-lane-label").attr("x", 8).attr("y", yc).attr("dominant-baseline", "central").text(`c (${L.num_clbits})`); }
    // qubit labels
    const labels = csvg.append("g").selectAll("g.qlabel").data(d3.range(D.nL)).join("g").attr("class", "qlabel").attr("transform", (q) => `translate(8,${yq(q)})`)
      .on("mouseenter", (ev, q) => { setHover({ type: "qubit", q }); showTooltip(`<b style="color:${qubitColor(q)}">q${q}</b> · currently on P${D.mappingAt(S.t)[q]}`, ev); })
      .on("mousemove", (ev) => moveTooltip(ev)).on("mouseleave", () => clearHover())
      .on("click", (ev, q) => { if (!ev.shiftKey) toggleLink("qubits", q); inspectQubit(q, D.mappingAt(S.t)[q]); });
    labels.append("rect").attr("width", 30).attr("height", 18).attr("y", -9).style("fill", (q) => qubitColor(q));
    labels.append("text").attr("x", 15).text((q) => `q${q}`);
    labels.append("text").attr("class", "pos").attr("x", 36).attr("y", -4).text("");
    labels.append("text").attr("class", "st").attr("x", 36).attr("y", 8).text("");
    // gates
    const gg = csvg.append("g").selectAll("g.lg-gate").data(D.gates).join("g")
      .attr("class", (g) => `lg-gate ${g.qubits.length > 1 ? "two" : ""} ${g.name === "measure" ? "meas" : ""} ${g.name === "swap" ? "swap" : ""}`)
      .on("mouseenter", (ev, g) => { setHover({ type: "gate", g: g.id }); showTooltip(`<b>${esc(g.name.toUpperCase())}</b>${g.params.length ? ` (${g.params.map(fmtParam).join(", ")})` : ""} on q${g.qubits.join(", q")}<br>${g.start == null ? "" : `${fmtTime(g.start)} → ${fmtTime(g.end)}`}`, ev); })
      .on("mousemove", (ev) => moveTooltip(ev)).on("mouseleave", () => clearHover())
      .on("click", (ev, g) => { if (!ev.shiftKey) toggleLink("gates", g.id); inspectLogicalGate(g); });
    gg.each(function (g) {
      const s = d3.select(this), x = xg(g.column);
      const qs = g.qubits, lo = Math.min(...qs), hi = Math.max(...qs);
      const box = (q, label, param) => {
        const wdt = Math.max(30, label.length * 7.5 + 10);
        s.append("rect").attr("class", "box").attr("x", x - wdt / 2).attr("y", yq(q) - 14).attr("width", wdt).attr("height", 28);
        s.append("text").attr("x", x).attr("y", yq(q) + (param ? -4 : 0)).text(label);
        if (param) s.append("text").attr("class", "param").attr("x", x).attr("y", yq(q) + 7).text(param);
      };
      const ctrl = (q) => s.append("circle").attr("class", "ctrl").attr("r", 4.5).attr("cx", x).attr("cy", yq(q));
      const tgt = (q) => { s.append("circle").attr("class", "target").attr("r", 9).attr("cx", x).attr("cy", yq(q)); s.append("path").attr("class", "tcross").attr("d", `M${x - 9},${yq(q)}H${x + 9}M${x},${yq(q) - 9}V${yq(q) + 9}`); };
      const swapx = (q) => s.append("path").attr("class", "swapx").attr("d", `M${x - 6},${yq(q) - 6}L${x + 6},${yq(q) + 6}M${x - 6},${yq(q) + 6}L${x + 6},${yq(q) - 6}`);
      const vert = (y1, y2) => s.insert("line", ":first-child").attr("class", "vert").attr("x1", x).attr("x2", x).attr("y1", y1).attr("y2", y2);
      const param = g.params.length ? g.params.map(fmtParam).join(",") : null;
      const name = g.name;
      if (name === "measure") {
        vert(yq(qs[0]), hasC ? yc : yq(qs[0]) + 14);
        box(qs[0], "M", null);
        if (hasC) s.append("path").attr("class", "tcross").attr("d", `M${x - 4},${yc - 6}L${x},${yc}L${x + 4},${yc - 6}`).style("stroke", "var(--k-measure)").style("fill", "none");
      } else if (qs.length === 1) box(qs[0], name.toUpperCase(), param);
      else if (name === "swap") { vert(yq(lo), yq(hi)); swapx(qs[0]); swapx(qs[1]); }
      else if (name === "cx" || name === "ccx" || name === "mcx" || name === "c3x" || name === "c4x") { vert(yq(lo), yq(hi)); qs.slice(0, -1).forEach(ctrl); tgt(qs[qs.length - 1]); }
      else if (name === "cz" || name === "ccz") { vert(yq(lo), yq(hi)); qs.forEach(ctrl); }
      else if (name === "cswap") { vert(yq(lo), yq(hi)); ctrl(qs[0]); swapx(qs[1]); swapx(qs[2]); }
      else if (/^(c|mc)/.test(name) && qs.length >= 2) { vert(yq(lo), yq(hi)); qs.slice(0, -1).forEach(ctrl); box(qs[qs.length - 1], name.replace(/^c+|^mc/, "").toUpperCase() || name.toUpperCase(), param); }
      else { // generic multi-qubit box spanning the range
        vert(yq(lo), yq(hi));
        const wdt = Math.max(34, name.length * 7.5 + 10);
        s.append("rect").attr("class", "box").attr("x", x - wdt / 2).attr("y", yq(lo) - 14).attr("width", wdt).attr("height", yq(hi) - yq(lo) + 28);
        s.append("text").attr("x", x).attr("y", (yq(lo) + yq(hi)) / 2 + (param ? -4 : 0)).text(name.toUpperCase());
        if (param) s.append("text").attr("class", "param").attr("x", x).attr("y", (yq(lo) + yq(hi)) / 2 + 7).text(param);
        qs.forEach((q, i) => s.append("text").attr("class", "param").attr("x", x - wdt / 2 + 6).attr("y", yq(q)).attr("text-anchor", "start").text(i));
      }
      const yTop = Math.min(yq(lo), ...(name === "measure" && hasC ? [] : [])) - 17, yBot = (name === "measure" && hasC ? yc : yq(hi)) + 17;
      s.insert("rect", ":first-child").attr("class", "hit").attr("x", x - CG.cw / 2 + 2).attr("y", yTop).attr("width", CG.cw - 4).attr("height", yBot - yTop);
    });
    updateCircuitClasses();
  }
  function updateCircuitClasses() {
    if (!S.D || !S.showCircuit) { drawLinks(); return; }
    const D = S.D, t = S.t, track = S.circuitMode === "track";
    const hovQ = S.hover && S.hover.type === "qubit" ? S.hover.q : null;
    const hovG = S.hover && S.hover.type === "gate" ? S.hover.g : null;
    const hovSwap = S.hover && S.hover.type === "swap" ? S.hover.qs : null;
    const mapping = D.mappingAt(t);
    csvg.selectAll("g.lg-gate")
      .classed("done", (g) => track && g.end != null && g.end <= t && (g.end > g.start || g.start + D.pulse <= t))
      .classed("running", (g) => track && g.start != null && g.start <= t && (t < g.end || (g.end <= g.start && t < g.start + D.pulse)))
      .classed("hl", (g) => hovG === g.id).classed("linked", (g) => S.links.gates.has(g.id));
    csvg.selectAll("g.qlabel").classed("hl", (q) => hovQ === q || (hovSwap && hovSwap.includes(q))).classed("linked", (q) => S.links.qubits.has(q))
      .each(function (q) {
        const s = d3.select(this);
        const st = D.statusOf(q, t);
        s.select("text.pos").text(track ? `@ P${mapping[q]}` : `init P${D.initial[q]}`);
        s.select("text.st").text(track ? (st === "idle" ? "○ not init." : st === "measured" ? "☑ measured" : "● initialised") : "");
      });
    drawLinks();
  }

  // --------------------------------------------------------------- link lines
  const overlay = d3.select("#linkOverlay");
  function centerOf(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  function drawLinks() {
    overlay.selectAll("*").remove();
    if (!S.D || !S.showCircuit || $("circuitPanel").classList.contains("hidden")) return;
    const D = S.D, t = S.t, mapping = D.mappingAt(t);
    const lines = [];
    const vp = $("viewport").getBoundingClientRect();
    const nodeEls = gNodes.selectAll("g.node").nodes();
    const chipEls = gChips.selectAll("g.chip").nodes();
    const chipData = gChips.selectAll("g.chip").data();
    const addQubit = (q, hover) => {
      const p = mapping[q]; if (p == null) return;
      const lab = csvg.selectAll("g.qlabel").nodes()[q]; if (!lab) return;
      const nodeEl = nodeEls[p]; if (!nodeEl || nodeEl.style.display === "none") return;
      const [x2, y2] = centerOf(nodeEl.querySelector("circle.body"));
      if (x2 < vp.left || x2 > vp.right || y2 < vp.top || y2 > vp.bottom) return;
      const [x1, y1] = centerOf(lab.querySelector("rect"));
      lines.push({ x1, y1, x2, y2, c: qubitColor(q), hover });
    };
    const addGate = (gid, hover) => {
      const gEl = csvg.selectAll("g.lg-gate").nodes()[gid]; if (!gEl) return;
      const [x1, y1] = centerOf(gEl.querySelector("rect.hit"));
      chipData.forEach((d, i) => {
        if (d.it.origin !== gid) return;
        const [x2, y2] = centerOf(chipEls[i].querySelector("rect"));
        if (x2 < vp.left || x2 > vp.right || y2 < vp.top || y2 > vp.bottom) return;
        lines.push({ x1, y1, x2, y2, c: kindColor(d.it), hover });
      });
    };
    S.links.qubits.forEach((q) => addQubit(q, false));
    visibleLinkedGates().forEach((g) => addGate(g, false));
    if (S.hover) {
      if (S.hover.type === "qubit" && !S.links.qubits.has(S.hover.q)) addQubit(S.hover.q, true);
      if (S.hover.type === "gate" && !S.links.gates.has(S.hover.g)) addGate(S.hover.g, true);
      if (S.hover.type === "swap") S.hover.qs.forEach((q) => { if (!S.links.qubits.has(q)) addQubit(q, true); });
    }
    overlay.selectAll("path").data(lines).join("path").attr("class", (d) => `link-line ${d.hover ? "hover" : ""}`)
      .attr("d", (d) => { const my = (d.y1 + d.y2) / 2; return `M${d.x1},${d.y1} C${d.x1},${my} ${d.x2},${my} ${d.x2},${d.y2}`; })
      .style("stroke", (d) => d.c);
  }

  // -------------------------------------------------------------------- modal
  function showModal(title, bodyHtml, buttons = [{ label: "OK", primary: true }]) {
    $("modalTitle").textContent = title; $("modalBody").innerHTML = bodyHtml;
    const foot = $("modalFoot"); foot.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button"); btn.className = `btn ${b.primary ? "primary" : "ghost"}`; btn.textContent = b.label;
      btn.onclick = () => { if (!b.onClick || b.onClick() !== false) hideModal(); };
      foot.appendChild(btn);
    }
    $("modal").classList.remove("hidden");
  }
  function hideModal() { $("modal").classList.add("hidden"); }
  $("modalClose").onclick = hideModal;
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) hideModal(); });

  // ----------------------------------------------------------------- compile
  let qasmText = null;
  let initialCompilePending = true;
  async function compile() {
    const btn = $("compileBtn"); btn.disabled = true; btn.textContent = "Compiling…";
    setPlaying(false);
    $("inspector").classList.add("hidden");
    S.selected = null;
    const circuit = $("circuitSelect").value === "__qasm__" ? { kind: "qasm", text: qasmText || "" } : { kind: "example", id: $("circuitSelect").value, n: +$("nInput").value };
    const body = { backend: $("backendSelect").value, circuit, seed: +$("seedInput").value, layout_method: $("layoutSelect").value, initial: initialCompilePending };
    initialCompilePending = false;
    try {
      const res = await fetch("/api/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const model = await res.json();
      if (!res.ok || model.error) throw new Error(model.error || res.statusText);
      loadModel(model);
      if (!model.sim.ok) {
        showModal("Circuit too large to simulate", `<span class="warn-icon">⚠️</span><p>${esc(model.sim.reason)}</p><p class="muted">Gates, timing and qubit positions are still shown; only the qubit values and Bloch spheres are unavailable.</p>`);
      }
    } catch (err) {
      showModal("Compilation failed", `<p>${esc(err.message)}</p>`);
    } finally {
      btn.disabled = new URLSearchParams(location.search).get("readonly") === "1";
      btn.textContent = "Compile & run";
    }
  }
  function loadModel(model) {
    S.model = model; S.D = prepare(model); S.t = 0; S.links.qubits.clear(); S.links.gates.clear(); S.hover = null; S.selected = null;
    schemaCache = new Map();
    $("emptyHint").classList.add("hidden");
    const st = model.stats;
    $("stats").innerHTML = [
      `<b>${esc(model.logical.name)}</b> on <b>${esc(model.backend.name)}</b>`,
      `<b>${model.logical.num_qubits}</b> logical / <b>${model.backend.num_qubits}</b> physical`,
      `<b>${st.logical_gates}</b> gates → <b>${st.native_ops}</b> native`,
      `<b>${st.routing_swaps}</b> routing swaps`,
      `<b>${fmtTime(model.total_time)}</b> total`,
      `basis: ${model.backend.basis.join(" ")}`,
    ].map((s) => `<span class="stat">${s}</span>`).join("");
    renderBackendStatic();
    renderTimelineStatic();
    renderCircuitStatic();
    updateLinkButtons();
    $("inspectorBody").innerHTML = `<p class="muted">Click a qubit to see its value and Bloch sphere. Click a gate to see its Qiskit schema.</p>`;
    $("inspectorTitle").textContent = "Inspector";
    renderAll();
    setTimeout(() => fitChip(true, S.D.everActive.size > 0 && model.backend.num_qubits > 30), 50);
    applyUrlState();
  }

  // optional deep-link state: ?t=2500&circuit=1&level=native&cmode=simple&link=qubits,gates&sel=q0|g3|p5&play=1
  let urlStateApplied = false;
  function applyUrlState() {
    if (urlStateApplied) return; urlStateApplied = true;
    const u = new URLSearchParams(location.search);
    if (!u.toString()) return;
    if (u.get("level")) document.querySelector(`[data-level="${u.get("level")}"]`)?.click();
    if (u.get("circuit") === "1") $("circuitBtn").click();
    if (u.get("cmode")) document.querySelector(`[data-cmode="${u.get("cmode")}"]`)?.click();
    setTimeout(() => {
      (u.get("link") || "").split(",").forEach((k) => { if (k === "qubits") $("linkQubitsBtn").click(); if (k === "gates") $("linkGatesBtn").click(); });
      if (u.get("t")) seek(+u.get("t"));
      const sel = u.get("sel");
      if (sel && S.D) {
        const m = /^([qgp])(\d+)$/.exec(sel);
        if (m && m[1] === "q") inspectQubit(+m[2], S.D.mappingAt(S.t)[+m[2]]);
        else if (m && m[1] === "p") onClickPhys(+m[2], { shiftKey: true });
        else if (m && m[1] === "g" && S.D.gates[+m[2]]) inspectLogicalGate(S.D.gates[+m[2]]);
      }
      if (u.get("play") === "1") setPlaying(true);
      renderAll();
    }, 120);
  }

  // ------------------------------------------------------------------- wiring
  async function init() {
    const readonly = new URLSearchParams(location.search).get("readonly") === "1";
    if (readonly) {
      $("emptyHint").classList.add("hidden");
    } else {
      $("emptyHintText").textContent = "Loading available backends and circuits…";
    }
    const [backends, examples] = readonly
      ? [[], []]
      : await Promise.all([fetch("/api/backends").then((r) => r.json()), fetch("/api/examples").then((r) => r.json())]);
    S.backends = backends; S.examples = examples;
    const bs = $("backendSelect");
    bs.innerHTML = backends.map((b) => `<option value="${b.id}">${b.name} · ${b.num_qubits}q · ${b.basis.filter((x) => ["cx", "cz", "ecr"].includes(x)).join("/")}</option>`).join("");
    bs.value = backends.find((b) => b.id === "FakeGuadalupeV2") ? "FakeGuadalupeV2" : (backends[0]?.id || "");
    const cs = $("circuitSelect");
    cs.innerHTML = examples.map((e) => `<option value="${e.id}" title="${esc(e.desc)}">${esc(e.title)}</option>`).join("") + `<option value="__qasm__">Custom QASM…</option>`;
    cs.value = "ghz_star";
    const syncN = () => { const ex = examples.find((e) => e.id === cs.value); const n = $("nInput"); if (ex) { n.min = ex.min; n.max = ex.max; n.value = Math.min(Math.max(+n.value || ex.default, ex.min), ex.max); n.disabled = ex.min === ex.max; if (n.value === "" ) n.value = ex.default; } else n.disabled = true; };
    cs.addEventListener("change", () => { if (cs.value === "__qasm__") openQasmModal(); syncN(); });
    $("nInput").value = 5; syncN();
    $("emptyHint").classList.add("hidden");
    const u0 = new URLSearchParams(location.search);
    if (u0.get("backend") && backends.some((b) => b.id === u0.get("backend"))) bs.value = u0.get("backend");
    if (u0.get("example") && examples.some((e) => e.id === u0.get("example"))) { cs.value = u0.get("example"); syncN(); }
    if (u0.get("n")) { $("nInput").value = +u0.get("n"); syncN(); }
    if (u0.get("seed")) $("seedInput").value = +u0.get("seed");
    $("compileBtn").onclick = compile;
    $("randSeedBtn").onclick = () => { $("seedInput").value = Math.floor(Math.random() * 10000); compile(); };
    $("qasmBtn").onclick = openQasmModal;
    $("playBtn").onclick = () => setPlaying(!S.playing);
    $("prevBtn").onclick = () => S.D && stepEvent(-1);
    $("nextBtn").onclick = () => S.D && stepEvent(1);
    $("speedSelect").onchange = (e) => { S.speed = +e.target.value; };
    if (readonly) {
      ["backendSelect", "circuitSelect", "nInput", "seedInput", "layoutSelect", "compileBtn", "randSeedBtn", "qasmBtn"].forEach((id) => {
        const control = $(id);
        if (control) control.disabled = true;
      });
      $("topbar").classList.add("hidden");
      $("menuBtn").classList.add("hidden");
    }
    const setMenu = (hidden) => {
      $("topbar").classList.toggle("hidden", hidden);
      $("menuBtn").textContent = hidden ? "Show menu" : "Hide menu";
      try { localStorage.setItem("menuHidden", hidden ? "1" : "0"); } catch (e) { /* storage unavailable */ }
      setTimeout(() => { lockButtonWidths(); if (S.D) { renderTimelineStatic(); fitChip(false, S.fitMode); renderAll(); } }, 0);
    };
    setMenu(false); // always shown on load
    $("menuBtn").onclick = () => setMenu(!$("topbar").classList.contains("hidden"));
    const setTimelineChart = (hidden) => {
      $("timelineSvg").classList.toggle("hidden", hidden);
      $("timelineBtn").textContent = hidden ? "Show timeline" : "Hide timeline";
      $("timeline").classList.toggle("tl-collapsed", hidden);
      try { localStorage.setItem("timelineHidden", hidden ? "1" : "0"); } catch (e) { /* storage unavailable */ }
      setTimeout(() => { if (S.D) { if (!hidden) renderTimelineStatic(); fitChip(false, S.fitMode); renderAll(); } }, 0);
    };
    try { if (localStorage.getItem("timelineHidden") === "1") setTimelineChart(true); } catch (e) { /* ignore */ }
    $("timelineBtn").onclick = () => setTimelineChart(!$("timelineSvg").classList.contains("hidden"));
    $("fitBtn").onclick = () => fitChip(true, false);
    $("focusBtn").onclick = () => fitChip(true, true);
    $("showUnused").onchange = (e) => { S.showUnused = e.target.checked; updateBackend(); };
    syncLegend();
    const setLegend = (collapsed) => {
      $("legend").classList.toggle("collapsed", collapsed);
      $("legendToggle").setAttribute("aria-expanded", String(!collapsed));
      try { localStorage.setItem("legendCollapsed", collapsed ? "1" : "0"); } catch (e) { /* storage unavailable */ }
    };
    try { if (localStorage.getItem("legendCollapsed") === "1") setLegend(true); } catch (e) { /* ignore */ }
    $("legendToggle").onclick = () => {
      if (S.legendMoved) { S.legendMoved = false; return; } // a drag ends with a click; ignore it
      setLegend(!$("legend").classList.contains("collapsed"));
    };
    // drag the legend by its header; on release it snaps to the nearest corner
    const LEGEND_MARGIN = 12, LEGEND_TOP = 52; // top corners sit below the view toolbar
    const placeLegend = (corner) => {
      const L = $("legend");
      L.style.left = L.style.right = L.style.top = L.style.bottom = "auto";
      const [v, h] = corner.split("-"); // e.g. "bottom-left"
      L.style[h] = LEGEND_MARGIN + "px";
      L.style[v] = (v === "top" ? LEGEND_TOP : LEGEND_MARGIN) + "px";
      try { localStorage.setItem("legendCorner", corner); } catch (e) { /* storage unavailable */ }
    };
    try { placeLegend(localStorage.getItem("legendCorner") || "bottom-left"); } catch (e) { placeLegend("bottom-left"); }
    $("legend").querySelector(".legend-title").addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const L = $("legend"), vp = $("viewport").getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, left: L.getBoundingClientRect().left - vp.left, top: L.getBoundingClientRect().top - vp.top };
      let moved = false;
      const onMove = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const r = L.getBoundingClientRect();
        const x = Math.max(0, Math.min(vp.width - r.width, start.left + dx));
        const y = Math.max(0, Math.min(vp.height - r.height, start.top + dy));
        L.style.left = x + "px"; L.style.top = y + "px"; L.style.right = L.style.bottom = "auto";
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!moved) return;
        S.legendMoved = true;
        const r = L.getBoundingClientRect();
        const vert = (r.top + r.height / 2 - vp.top) < vp.height / 2 ? "top" : "bottom";
        const horiz = (r.left + r.width / 2 - vp.left) < vp.width / 2 ? "left" : "right";
        placeLegend(`${vert}-${horiz}`);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
    document.querySelectorAll("[data-level]").forEach((b) => b.onclick = () => {
      S.level = b.dataset.level; document.querySelectorAll("[data-level]").forEach((x) => x.classList.toggle("active", x === b));
      syncLegend();
      if (S.D) { renderTimelineStatic(); renderAll(); }
    });
    document.querySelectorAll("[data-cmode]").forEach((b) => b.onclick = () => {
      S.circuitMode = b.dataset.cmode; document.querySelectorAll("[data-cmode]").forEach((x) => x.classList.toggle("active", x === b)); renderAll();
    });
    const setCircuit = (on) => {
      S.showCircuit = on; $("circuitPanel").classList.toggle("hidden", !on);
      $("circuitBtn").textContent = on ? "Hide logical circuit" : "Show logical circuit"; $("circuitBtn").classList.toggle("active", on);
      if (!on) { S.hover = null; }
      setTimeout(() => { lockButtonWidths(); if (S.D) { renderTimelineStatic(); fitChip(true, S.fitMode); renderAll(); if (S.selected) renderInspector(); } }, 0);
    };
    $("circuitBtn").onclick = () => setCircuit(!S.showCircuit);
    $("circuitClose").onclick = () => setCircuit(false);
    $("linkQubitsBtn").onclick = () => { if (!S.D) return; const all = S.links.qubits.size === S.D.nL; S.links.qubits.clear(); if (!all) for (let q = 0; q < S.D.nL; q++) S.links.qubits.add(q); updateLinkButtons(); renderAll(); };
    $("linkGatesBtn").onclick = () => { if (!S.D) return; const gl = S.D.gates.filter((g) => g.start != null); const all = gl.every((g) => S.links.gates.has(g.id)); S.links.gates.clear(); if (!all) gl.forEach((g) => S.links.gates.add(g.id)); updateLinkButtons(); renderAll(); };
    $("clearLinksBtn").onclick = () => { S.links.qubits.clear(); S.links.gates.clear(); updateLinkButtons(); renderAll(); };
    $("blochPopClose").onclick = closeBlochPopup;
    $("inspectorClose").onclick = () => { $("inspector").classList.add("hidden"); S.selected = null; setTimeout(() => { if (S.D) { renderTimelineStatic(); renderAll(); } }, 0); };
    $("circuitScroll").addEventListener("scroll", drawLinks);
    window.addEventListener("resize", () => { if (S.D) { renderTimelineStatic(); fitChip(false, S.fitMode); renderAll(); } });
    if (new URLSearchParams(location.search).get("theme")) document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme");
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (e.code === "Space") { e.preventDefault(); setPlaying(!S.playing); }
      else if (e.key === "ArrowRight") stepEvent(1); else if (e.key === "ArrowLeft") stepEvent(-1);
      else if (e.key === "Escape") hideModal();
    });
    compile();
  }

  function syncLegend() {
    document.querySelectorAll("[data-lv]").forEach((r) => r.classList.toggle("hidden", r.dataset.lv !== S.level));
  }

  function openQasmModal() {
    const sample = qasmText || `OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3];\ncreg c[3];\nh q[0];\ncx q[0],q[1];\ncx q[0],q[2];\nrz(0.3) q[2];\nccx q[0],q[1],q[2];\nmeasure q -> c;`;
    showModal("Custom OpenQASM circuit", `<p class="muted">Paste OpenQASM 2 or 3, or load a file. All parameters must be bound.</p><textarea id="qasmArea">${esc(sample)}</textarea><p><input type="file" id="qasmFile" accept=".qasm,.txt"></p>`,
      [{ label: "Cancel" }, { label: "Use this circuit", primary: true, onClick: () => { qasmText = $("qasmArea").value; $("circuitSelect").value = "__qasm__"; $("nInput").disabled = true; compile(); } }]);
    $("qasmFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (!f) return; f.text().then((txt) => { $("qasmArea").value = txt; }); });
  }

  // Buttons whose label changes (show/hide, link/unlink) keep the width of their widest label,
  // so toggling never shifts the surrounding controls.
  const WIDTH_LOCKS = [
    ["circuitBtn", ["Show logical circuit", "Hide logical circuit"]],
    ["timelineBtn", ["Hide timeline", "Show timeline"]],
    ["menuBtn", ["Hide menu", "Show menu"]],
    ["linkQubitsBtn", ["Link all qubits", "Unlink all qubits"]],
    ["linkGatesBtn", ["Link all gates", "Unlink all gates"]],
  ];
  function lockButtonWidths() {
    for (const [id, labels] of WIDTH_LOCKS) {
      const btn = $(id);
      if (!btn) continue;
      const original = btn.textContent;
      btn.style.minWidth = "";
      let widest = 0;
      for (const label of labels) {
        btn.textContent = label;
        widest = Math.max(widest, btn.getBoundingClientRect().width);
      }
      btn.textContent = original;
      btn.style.minWidth = Math.ceil(widest) + "px";
    }
  }

  // surface runtime errors to the user instead of failing silently
  window.addEventListener("error", (e) => {
    const box = document.createElement("div");
    box.className = "tooltip"; box.style.cssText = "left:12px;bottom:12px;top:auto;pointer-events:auto;border-color:var(--cursor);max-width:60vw";
    box.innerHTML = `<b>Script error:</b> ${esc(e.message)} <span class="muted">(${esc((e.filename || "").split("/").pop())}:${e.lineno})</span>`;
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  });
  init().then(() => {
    lockButtonWidths();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(lockButtonWidths);
  });
})();
